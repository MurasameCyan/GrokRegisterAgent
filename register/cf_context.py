# -*- coding: utf-8 -*-
"""
W2 · Cloudflare 上下文：跨号复用 cf_clearance / __cf_bm，清身份时保留。

对齐 grok-register-web-master2：
  - 注册成功后 capture
  - 下一轮前 clear 全 cookie/storage 后 restore 仅 CF
  - 与 UA / 出口 IP 绑定；换代理或完整重启浏览器后应丢弃
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

LogFn = Callable[[str], None]

_CF_NAMES = frozenset({"cf_clearance", "__cf_bm"})
# xAI / Grok 相关域（清身份时优先干掉 sso）
_IDENTITY_COOKIE_NAMES = frozenset(
    {
        "sso",
        "sso-rw",
        "sso-session",
        "auth_token",
        "session",
        "__Secure-next-auth.session-token",
        "next-auth.session-token",
    }
)


@dataclass
class CloudflareContext:
    user_agent: str = ""
    cloudflare_cookies: str = ""  # "cf_clearance=...; __cf_bm=..."
    captured_at: float = 0.0
    source: str = ""

    @property
    def ready(self) -> bool:
        return bool(self.cloudflare_cookies) and (
            "cf_clearance=" in self.cloudflare_cookies.lower()
        )

    def cookie_pairs(self) -> list[tuple[str, str]]:
        out: list[tuple[str, str]] = []
        for part in (self.cloudflare_cookies or "").split(";"):
            part = part.strip()
            if not part or "=" not in part:
                continue
            name, value = part.split("=", 1)
            name, value = name.strip(), value.strip()
            if name.lower() in _CF_NAMES and value:
                out.append((name, value))
        return out


# 进程内线程本地 + 全局兜底（单 worker 主循环）
_tls = threading.local()
_global_lock = threading.Lock()
_global_ctx: Optional[CloudflareContext] = None


def get_thread_cf_context() -> Optional[CloudflareContext]:
    return getattr(_tls, "cf_ctx", None) or _global_ctx


def set_thread_cf_context(ctx: Optional[CloudflareContext]) -> None:
    global _global_ctx
    _tls.cf_ctx = ctx
    with _global_lock:
        _global_ctx = ctx


def clear_thread_cf_context() -> None:
    set_thread_cf_context(None)


def _cookie_name_value(item: Any) -> tuple[str, str, str]:
    if isinstance(item, dict):
        name = str(item.get("name") or item.get("Name") or "").strip()
        value = str(item.get("value") or item.get("Value") or "").strip()
        domain = str(item.get("domain") or item.get("Domain") or "").strip().lower()
        return name, value, domain.lstrip(".")
    return "", "", ""


def extract_cf_cookie_string(page: Any, browser: Any = None) -> str:
    """从 page/browser 提取 cf_clearance + __cf_bm 串。"""
    cf_map: dict[str, str] = {}

    def ingest(name: str, value: str) -> None:
        n = (name or "").strip()
        v = (value or "").strip()
        if not n or not v:
            return
        key = n.lower()
        if key in _CF_NAMES and key not in cf_map:
            cf_map[key] = f"{n}={v}"

    def scan_cookies(raw: Any) -> None:
        if raw is None:
            return
        if isinstance(raw, dict):
            for k, v in raw.items():
                ingest(str(k), str(v))
            return
        try:
            for c in list(raw or []):
                if isinstance(c, dict):
                    n, v, _d = _cookie_name_value(c)
                    ingest(n, v)
        except Exception:
            pass

    if page is not None:
        for getter in (
            lambda: page.cookies(all_domains=True, all_info=True),
            lambda: page.cookies(),
            lambda: page.get_cookies(),
        ):
            try:
                scan_cookies(getter())
            except TypeError:
                try:
                    scan_cookies(page.cookies())
                except Exception:
                    pass
            except Exception:
                pass
        try:
            doc = str(page.run_js("return document.cookie || ''") or "")
            for part in doc.split(";"):
                part = part.strip()
                if "=" in part:
                    n, v = part.split("=", 1)
                    ingest(n, v)
        except Exception:
            pass

    br = browser
    if br is None and page is not None:
        br = getattr(page, "browser", None)
    if br is not None:
        for getter in (lambda: br.cookies(), lambda: br.get_cookies()):
            try:
                scan_cookies(getter())
            except Exception:
                pass

    ordered: list[str] = []
    for key in ("cf_clearance", "__cf_bm"):
        if key in cf_map:
            ordered.append(cf_map[key])
    return "; ".join(ordered)


def capture_cloudflare_context(
    page: Any,
    browser: Any = None,
    *,
    source: str = "register",
    log: Optional[LogFn] = None,
) -> CloudflareContext:
    """捕获当前页 CF 上下文并写入线程缓存。"""
    cookies = extract_cf_cookie_string(page, browser)
    ua = ""
    try:
        if page is not None:
            ua = str(page.run_js("return navigator.userAgent") or "").strip()
    except Exception:
        pass
    ctx = CloudflareContext(
        user_agent=ua,
        cloudflare_cookies=cookies,
        captured_at=time.time(),
        source=source,
    )
    if ctx.ready:
        set_thread_cf_context(ctx)
        if log:
            log(
                f"[cf-ctx] 已捕获 clearance len={len(cookies)} "
                f"ua={ua[:40]}… source={source}"
            )
    else:
        if log:
            log("[cf-ctx] 捕获失败：无 cf_clearance")
    return ctx


def restore_cloudflare_context(
    page: Any,
    context: Optional[CloudflareContext] = None,
    *,
    log: Optional[LogFn] = None,
) -> bool:
    """把 CF cookie 写回浏览器（.grok.com / .x.ai）。"""
    ctx = context or get_thread_cf_context()
    if not ctx or not ctx.ready or page is None:
        return False
    pairs = ctx.cookie_pairs()
    if not pairs:
        return False

    domains = (".grok.com", ".x.ai", "grok.com", "x.ai")
    restored = False
    for name, value in pairs:
        for domain in domains:
            try:
                page.run_cdp(
                    "Network.setCookie",
                    name=name,
                    value=value,
                    domain=domain if domain.startswith(".") else f".{domain}",
                    path="/",
                    secure=True,
                    httpOnly=True,
                    sameSite="None",
                )
                restored = True
            except Exception:
                pass
        try:
            page.set.cookies(
                [
                    {
                        "name": name,
                        "value": value,
                        "domain": ".grok.com",
                        "path": "/",
                        "secure": True,
                    },
                    {
                        "name": name,
                        "value": value,
                        "domain": ".x.ai",
                        "path": "/",
                        "secure": True,
                    },
                ]
            )
            restored = True
        except Exception:
            pass

    if restored and log:
        log(
            f"[cf-ctx] 已恢复 CF cookies n={len(pairs)} "
            f"age={time.time() - (ctx.captured_at or time.time()):.0f}s"
        )
    return restored


def clear_identity_keep_cf(
    page: Any,
    browser: Any = None,
    *,
    context: Optional[CloudflareContext] = None,
    log: Optional[LogFn] = None,
) -> bool:
    """
    清身份（storage + 全 cookie）后恢复 CF。
    用于注册轮次之间复用 Chromium 进程。
    """
    # 优先用调用方传入的，否则 capture 当前（清之前）
    ctx = context
    if ctx is None or not ctx.ready:
        # 若线程里已有上一轮成功捕获的，用那个
        cached = get_thread_cf_context()
        if cached and cached.ready:
            ctx = cached
        else:
            ctx = capture_cloudflare_context(page, browser, source="pre_clear", log=None)

    ok = True
    try:
        if page is not None:
            try:
                page.get("about:blank")
            except Exception:
                pass
            for js in (
                "try{localStorage.clear()}catch(e){}",
                "try{sessionStorage.clear()}catch(e){}",
                "try{indexedDB.databases&&indexedDB.databases().then(ds=>ds.forEach(d=>indexedDB.deleteDatabase(d.name)))}catch(e){}",
            ):
                try:
                    page.run_js(js)
                except Exception:
                    pass
            # 清 cookie
            cleared = False
            for target in (page, browser):
                if target is None or cleared:
                    continue
                try:
                    target.set.cookies.clear()
                    cleared = True
                except Exception:
                    try:
                        target.cookies.clear()
                        cleared = True
                    except Exception:
                        pass
            if not cleared and page is not None:
                try:
                    page.run_js(
                        "document.cookie.split(';').forEach(c=>{"
                        "document.cookie=c.replace(/^ +/,'').replace(/=.*/, '=;expires='+new Date(0).toUTCString()+';path=/')"
                        "})"
                    )
                except Exception:
                    ok = False
    except Exception as e:
        ok = False
        if log:
            log(f"[cf-ctx] clear_identity 异常: {e}")

    # 恢复 CF
    restored = restore_cloudflare_context(page, ctx, log=log)
    if log:
        log(
            f"[cf-ctx] 会话已清理（保 CF={'是' if restored else '否'}）"
        )
    return ok
