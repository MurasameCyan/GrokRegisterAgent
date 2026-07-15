# -*- coding: utf-8 -*-
"""
SSO materialize：wrapper JWT → 会话级 sso cookie。
源自 grok-regkit protocol/sso_util，与本项目密码重登/hybrid 并存。
"""
from __future__ import annotations

import base64
import json
import time
from typing import Any, Callable, Optional
from urllib.parse import urlparse

LogFn = Callable[[str], None]


def _noop(msg: str) -> None:
    pass


def _b64url_json(segment: str) -> dict:
    s = (segment or "").strip()
    if not s:
        return {}
    pad = "=" * ((4 - len(s) % 4) % 4)
    try:
        raw = base64.urlsafe_b64decode(s + pad)
        return json.loads(raw.decode("utf-8", errors="replace"))
    except Exception:
        return {}


def decode_jwt_payload(token: str) -> dict:
    parts = str(token or "").strip().split(".")
    if len(parts) < 2:
        return {}
    return _b64url_json(parts[1])


def is_wrapper_sso(token: str) -> bool:
    """
    hybrid/CreateAccount 常返回短时 wrapper JWT（含 userId 等），
    不能直接当 accounts.x.ai 的 sso cookie 做 mint，需 materialize。
    """
    payload = decode_jwt_payload(token)
    if not payload:
        return False
    # 明确会话 cookie 特征
    if payload.get("sid") or payload.get("session_id"):
        return False
    # wrapper 常见 claim
    if payload.get("userId") or payload.get("user_id"):
        return True
    # 过短且无典型会话字段
    aud = payload.get("aud")
    if isinstance(aud, list):
        aud = ",".join(str(x) for x in aud)
    if "session" in str(aud or "").lower():
        return False
    exp = payload.get("exp")
    iat = payload.get("iat")
    try:
        if exp and iat and int(exp) - int(iat) < 600:
            # 极短 TTL 更像 wrapper
            if not payload.get("sso"):
                return True
    except Exception:
        pass
    return False


def materialize_sso_via_http(
    wrapper_or_sso: str,
    *,
    proxy: str = "",
    log: Optional[LogFn] = None,
    timeout: float = 30.0,
) -> str:
    """
    尝试用 HTTP 将会话落到 sso cookie（curl_cffi 优先）。
    失败返回空字符串，由调用方再试浏览器路径。
    """
    lg = log or _noop
    token = str(wrapper_or_sso or "").strip()
    if not token:
        return ""
    if not is_wrapper_sso(token):
        return token

    try:
        from curl_cffi import requests as cf_requests
    except ImportError:
        lg("[materialize] curl_cffi 不可用，跳过 HTTP materialize")
        return ""

    proxies = None
    if proxy:
        proxies = {"http": proxy, "https": proxy}

    sess = cf_requests.Session(impersonate="chrome131")
    # 先带 token 访问 accounts，期望 Set-Cookie: sso=
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Cookie": f"sso={token}; sso-rw={token}",
    }
    urls = (
        "https://accounts.x.ai/",
        "https://accounts.x.ai/sign-in",
        "https://grok.com/",
    )
    for url in urls:
        try:
            r = sess.get(
                url,
                headers=headers,
                proxies=proxies,
                timeout=timeout,
                allow_redirects=True,
            )
            # 从 cookie jar 取 sso
            for c in sess.cookies:
                name = getattr(c, "name", None) or ""
                val = getattr(c, "value", None) or ""
                if name in ("sso", "sso-rw") and val and val != token and len(val) > 40:
                    if not is_wrapper_sso(val):
                        lg(f"[materialize] HTTP 得到会话 sso via {urlparse(url).netloc}")
                        return str(val).strip()
            # 响应头 Set-Cookie
            sc = r.headers.get("set-cookie") or r.headers.get("Set-Cookie") or ""
            if "sso=" in sc:
                for part in sc.split(","):
                    if "sso=" in part:
                        frag = part.split("sso=", 1)[-1].split(";", 1)[0].strip()
                        if frag and frag != token and len(frag) > 40 and not is_wrapper_sso(frag):
                            lg("[materialize] HTTP Set-Cookie 得到会话 sso")
                            return frag
        except Exception as e:
            lg(f"[materialize] HTTP {urlparse(url).netloc} 失败: {e}")
    return ""


def materialize_sso_via_browser(
    page: Any,
    wrapper_or_sso: str,
    log: Optional[LogFn] = None,
    timeout: float = 45.0,
) -> str:
    """在已有 Drission 页面上注入 cookie 并读回 sso。"""
    lg = log or _noop
    token = str(wrapper_or_sso or "").strip()
    if not token:
        return ""
    if not is_wrapper_sso(token):
        return token
    if page is None:
        return ""

    try:
        page.get("https://accounts.x.ai/")
        time.sleep(0.8)
    except Exception as e:
        lg(f"[materialize] browser open accounts: {e}")

    try:
        # 设置 cookie
        page.run_js(
            f"""
(() => {{
  document.cookie = "sso={token}; domain=.x.ai; path=/; Secure; SameSite=None";
  document.cookie = "sso-rw={token}; domain=.x.ai; path=/; Secure; SameSite=None";
  return document.cookie;
}})()
"""
        )
    except Exception as e:
        lg(f"[materialize] set cookie js: {e}")

    deadline = time.time() + max(5.0, float(timeout))
    while time.time() < deadline:
        try:
            cookies = page.cookies() if callable(getattr(page, "cookies", None)) else None
            jar = cookies() if callable(cookies) else cookies
            if isinstance(jar, dict):
                for k in ("sso", "sso-rw"):
                    v = str(jar.get(k) or "").strip()
                    if v and v != token and not is_wrapper_sso(v):
                        lg("[materialize] browser cookie jar 会话 sso")
                        return v
            if isinstance(jar, (list, tuple)):
                for c in jar:
                    if not isinstance(c, dict):
                        continue
                    name = str(c.get("name") or "")
                    val = str(c.get("value") or "").strip()
                    if name in ("sso", "sso-rw") and val and val != token and not is_wrapper_sso(val):
                        lg("[materialize] browser list 会话 sso")
                        return val
        except Exception:
            pass
        try:
            page.get("https://accounts.x.ai/sign-in")
        except Exception:
            pass
        time.sleep(1.0)
    lg("[materialize] browser 超时未得到会话 sso")
    return ""


def ensure_session_sso(
    token: str,
    *,
    page: Any = None,
    proxy: str = "",
    log: Optional[LogFn] = None,
) -> str:
    """统一入口：非 wrapper 原样返回；wrapper 则 HTTP→浏览器 materialize。"""
    lg = log or _noop
    t = str(token or "").strip()
    if not t:
        return ""
    if not is_wrapper_sso(t):
        return t
    lg("[materialize] 检测到 wrapper SSO，尝试转为会话 sso…")
    http_sso = materialize_sso_via_http(t, proxy=proxy, log=lg)
    if http_sso:
        return http_sso
    if page is not None:
        br = materialize_sso_via_browser(page, t, log=lg)
        if br:
            return br
    lg("[materialize] 未能 materialize，返回原 token（mint 可能失败）")
    return t
