# -*- coding: utf-8 -*-
"""P2: 浏览器 Device Flow mint（邮箱+密码路径）。

无 SSO / SSO mint 失败时的备用通道：
  1) 申请 device_code
  2) 独立 Chromium 打开 verification_uri
  3) 邮箱+密码登录 → 真点击 Consent「允许」
  4) poll token

依赖: DrissionPage + curl_cffi（device code / token 用 API）
"""
from __future__ import annotations

import secrets
import time
from typing import Any, Callable, Optional

LogFn = Callable[[str], None]

CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
ISSUER = "https://auth.x.ai"
DEVICE_CODE_URL = f"{ISSUER}/oauth2/device/code"
TOKEN_URL = f"{ISSUER}/oauth2/token"
SCOPE = (
    "openid profile email offline_access grok-cli:access "
    "api:access conversations:read conversations:write"
)
GROK_REFERRER = "grok-build"


def _noop(_: str) -> None:
    return None


def _request_device_code(proxy: str = "") -> dict[str, Any]:
    try:
        from curl_cffi import requests as cf_requests
    except ImportError as e:
        return {"ok": False, "error": f"curl_cffi required: {e}"}
    proxies = {"http": proxy, "https": proxy} if proxy else None
    try:
        r = cf_requests.post(
            DEVICE_CODE_URL,
            data={"client_id": CLIENT_ID, "scope": SCOPE},
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
            },
            proxies=proxies,
            impersonate="chrome120",
            timeout=20,
        )
        if r.status_code != 200:
            return {
                "ok": False,
                "error": f"device_code HTTP {r.status_code}: {(r.text or '')[:200]}",
            }
        data = r.json() if r.text else {}
        if not data.get("device_code"):
            return {"ok": False, "error": f"no device_code: {data}"}
        return {"ok": True, **data}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _poll_token(
    device_code: str,
    *,
    interval: float = 5.0,
    timeout: float = 120.0,
    proxy: str = "",
    log: LogFn,
) -> dict[str, Any]:
    try:
        from curl_cffi import requests as cf_requests
    except ImportError as e:
        return {"ok": False, "error": f"curl_cffi required: {e}"}
    proxies = {"http": proxy, "https": proxy} if proxy else None
    end = time.time() + timeout
    while time.time() < end:
        try:
            r = cf_requests.post(
                TOKEN_URL,
                data={
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                    "device_code": device_code,
                    "client_id": CLIENT_ID,
                },
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "application/json",
                },
                proxies=proxies,
                impersonate="chrome120",
                timeout=20,
            )
            if r.status_code == 200:
                data = r.json() if r.text else {}
                if data.get("access_token"):
                    return {
                        "ok": True,
                        "access_token": data.get("access_token"),
                        "refresh_token": data.get("refresh_token") or "",
                        "id_token": data.get("id_token"),
                        "expires_in": data.get("expires_in"),
                        "mode": "browser_device",
                    }
            body = {}
            try:
                body = r.json() if r.text else {}
            except Exception:
                pass
            err = str(body.get("error") or "")
            if err in ("authorization_pending", "slow_down"):
                time.sleep(max(interval, float(body.get("interval") or interval)))
                continue
            if err == "access_denied":
                return {"ok": False, "error": "access_denied", "mode": "browser_device"}
            if err == "expired_token":
                return {"ok": False, "error": "expired_token", "mode": "browser_device"}
            # 其它状态稍等再试
            time.sleep(interval)
        except Exception as e:
            log(f"[browser-mint] poll err: {e}")
            time.sleep(interval)
    return {"ok": False, "error": "poll timeout", "mode": "browser_device"}


def _click_consent(page: Any, log: LogFn) -> bool:
    """真点击「允许 / Allow / Authorize」—— JS click 常无效。"""
    labels = (
        "允许",
        "Allow",
        "Authorize",
        "Continue",
        "批准",
        "同意",
        "Accept",
    )
    for label in labels:
        try:
            el = page.ele(f"xpath://button[normalize-space(.)='{label}']", timeout=0.4)
            if el:
                try:
                    el.click(by_js=False)
                except Exception:
                    try:
                        el.click()
                    except Exception:
                        page.run_js(
                            "arguments[0].click();",
                            el,
                        )
                log(f"[browser-mint] consent clicked label={label}")
                return True
        except Exception:
            continue
    # 模糊匹配
    try:
        clicked = page.run_js(
            r"""
function isVisible(n) {
  if (!n) return false;
  const s = window.getComputedStyle(n);
  if (s.display === 'none' || s.visibility === 'hidden') return false;
  const r = n.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}
const re = /允许|allow|authorize|approve|同意|批准/i;
const btns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isVisible);
const t = btns.find(b => re.test((b.innerText || b.textContent || '').trim()));
if (t) { t.click(); return true; }
return false;
"""
        )
        if clicked:
            log("[browser-mint] consent clicked via fuzzy JS")
            return True
    except Exception:
        pass
    return False


def mint_with_password_browser(
    *,
    email: str,
    password: str,
    proxy: str = "",
    headless: bool = True,
    timeout: float = 150.0,
    log: Optional[LogFn] = None,
) -> dict[str, Any]:
    """邮箱+密码浏览器 Device mint。

    返回: ok, access_token, refresh_token, id_token?, expires_in?, error?, mode
    """
    log = log or _noop
    email = str(email or "").strip()
    password = str(password or "").strip()
    if not email or not password:
        return {"ok": False, "error": "missing email or password", "mode": "browser_device"}

    dc = _request_device_code(proxy=proxy)
    if not dc.get("ok"):
        return {
            "ok": False,
            "error": dc.get("error") or "device_code failed",
            "mode": "browser_device",
        }
    device_code = str(dc["device_code"])
    user_code = str(dc.get("user_code") or "")
    verify_uri = str(
        dc.get("verification_uri_complete")
        or dc.get("verification_uri")
        or f"{ISSUER}/oauth2/device/verify"
    )
    interval = float(dc.get("interval") or 5)
    log(f"[browser-mint] device_code ok user_code={user_code} uri={verify_uri[:80]}")

    try:
        from DrissionPage import Chromium, ChromiumOptions  # type: ignore
    except Exception as e:
        return {
            "ok": False,
            "error": f"DrissionPage unavailable: {e}",
            "mode": "browser_device",
        }

    co = ChromiumOptions()
    try:
        co.headless(bool(headless))
    except Exception:
        pass
    for arg in (
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--lang=en-US",
    ):
        try:
            co.set_argument(arg)
        except Exception:
            pass
    proxy_s = str(proxy or "").strip()
    if proxy_s:
        try:
            co.set_proxy(proxy_s)
        except Exception as e:
            log(f"[browser-mint] set_proxy failed: {e}")

    browser = None
    try:
        browser = Chromium(co)
        page = browser.latest_tab
        log(f"[browser-mint] open verify {verify_uri}")
        page.get(verify_uri)
        time.sleep(1.0 + secrets.randbelow(30) / 100.0)

        # 若需登录：填邮箱密码（复用 password_login 思路）
        deadline = time.time() + min(90.0, timeout * 0.6)
        logged = False
        while time.time() < deadline:
            try:
                url = page.url or ""
                text = ""
                try:
                    text = page.run_js(
                        "return (document.body && (document.body.innerText||'')) || '';"
                    ) or ""
                except Exception:
                    pass
                # 已到 consent
                if _click_consent(page, log):
                    logged = True
                    break
                # 填邮箱
                email_el = page.ele(
                    "css:input[type='email'], input[name='email'], input[autocomplete='username']",
                    timeout=0.5,
                )
                if email_el:
                    try:
                        email_el.clear()
                    except Exception:
                        pass
                    email_el.input(email)
                    time.sleep(0.3)
                    # 下一步 / continue
                    for lab in ("Continue", "Next", "继续", "下一步"):
                        btn = page.ele(
                            f"xpath://button[normalize-space(.)='{lab}']", timeout=0.3
                        )
                        if btn:
                            btn.click()
                            break
                    else:
                        page.run_js(
                            r"""
const b = Array.from(document.querySelectorAll('button')).find(x =>
  /continue|next|继续|下一步/i.test((x.innerText||'').trim()));
if (b) b.click();
"""
                        )
                    time.sleep(0.8)
                pass_el = page.ele(
                    "css:input[type='password'], input[name='password']",
                    timeout=0.5,
                )
                if pass_el:
                    try:
                        pass_el.clear()
                    except Exception:
                        pass
                    pass_el.input(password)
                    time.sleep(0.3)
                    for lab in ("Sign in", "Log in", "Continue", "登录", "登入"):
                        btn = page.ele(
                            f"xpath://button[normalize-space(.)='{lab}']", timeout=0.3
                        )
                        if btn:
                            btn.click()
                            break
                    else:
                        page.run_js(
                            r"""
const b = Array.from(document.querySelectorAll('button')).find(x =>
  /sign\s*in|log\s*in|continue|登录/i.test((x.innerText||'').trim()));
if (b) b.click();
"""
                        )
                    time.sleep(1.2)
                # user_code 输入（若 verify 页需要）
                if user_code:
                    code_el = page.ele(
                        "css:input[name='user_code'], input[autocomplete='one-time-code']",
                        timeout=0.3,
                    )
                    if code_el:
                        try:
                            code_el.clear()
                        except Exception:
                            pass
                        code_el.input(user_code)
                        time.sleep(0.2)
                        page.run_js(
                            r"""
const b = Array.from(document.querySelectorAll('button')).find(x =>
  /continue|next|submit|继续/i.test((x.innerText||'').trim()));
if (b) b.click();
"""
                        )
                if "allow" in text.lower() or "允许" in text or "authorize" in text.lower():
                    if _click_consent(page, log):
                        logged = True
                        break
            except Exception as e:
                log(f"[browser-mint] step: {e}")
            time.sleep(0.8)

        # consent 再试一轮
        for _ in range(8):
            if _click_consent(page, log):
                logged = True
                break
            time.sleep(0.6)

        if not logged:
            log("[browser-mint] ⚠ 未确认 consent 点击，仍尝试 poll token")

        log("[browser-mint] poll token…")
        return _poll_token(
            device_code,
            interval=interval,
            timeout=max(30.0, timeout - 40),
            proxy=proxy,
            log=log,
        )
    except Exception as e:
        return {"ok": False, "error": str(e), "mode": "browser_device"}
    finally:
        if browser is not None:
            try:
                browser.quit()
            except Exception:
                pass
