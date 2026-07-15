# -*- coding: utf-8 -*-
"""
Device Flow mint（mode=B）：SSO cookie → access/refresh。
源自 grok-regkit cpa_xai/oauth_device + protocol_mint 精简版。
注意：部分环境 access_token 无 referrer claim，cli-chat-proxy 可能 403；
与 Auth Code+PKCE（mode=A）并存，由 cpa_mint_mode 选择。
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Optional

CLIENT_ID = "app"
ISSUER = "https://auth.x.ai"
DEVICE_CODE_URL = f"{ISSUER}/oauth2/device/code"
TOKEN_URL = f"{ISSUER}/oauth2/token"
SCOPE = "openid offline_access"
VERIFY_URL = f"{ISSUER}/oauth2/device/verify"
APPROVE_URL = f"{ISSUER}/oauth2/device/approve"

LogFn = Callable[[str], None]


def _noop(_: str) -> None:
    return None


def _post_form(
    url: str,
    form: dict[str, str],
    *,
    timeout: float = 30.0,
    proxy: str = "",
    headers: Optional[dict[str, str]] = None,
) -> tuple[int, Any]:
    data = urllib.parse.urlencode(form).encode("utf-8")
    hdrs = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "User-Agent": "GrokRegisterAgent-device-mint/1.0",
    }
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=data, method="POST", headers=hdrs)
    handlers: list = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    opener = urllib.request.build_opener(*handlers) if handlers else urllib.request.build_opener()
    try:
        with opener.open(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            status = getattr(resp, "status", 200) or 200
            try:
                return int(status), json.loads(body)
            except json.JSONDecodeError:
                return int(status), body
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            return int(e.code), json.loads(body)
        except json.JSONDecodeError:
            return int(e.code), body


def mint_tokens_device_flow(
    sso: str,
    *,
    proxy: str = "",
    log: Optional[LogFn] = None,
    poll_timeout: float = 120.0,
) -> dict[str, Any]:
    """
    使用 SSO cookie 完成 device approve 并 poll token。
    返回 {ok, access_token, refresh_token, id_token?, expires_in?, error?, mode}
    """
    lg = log or _noop
    sso = str(sso or "").strip()
    if not sso:
        return {"ok": False, "error": "empty sso", "mode": "device"}

    lg("[mint-B] device code…")
    status, body = _post_form(
        DEVICE_CODE_URL,
        {"client_id": CLIENT_ID, "scope": SCOPE},
        proxy=proxy,
    )
    if status != 200 or not isinstance(body, dict):
        return {
            "ok": False,
            "error": f"device code HTTP {status}: {body!r}"[:200],
            "mode": "device",
        }
    device_code = str(body.get("device_code") or "").strip()
    user_code = str(body.get("user_code") or "").strip()
    interval = max(int(body.get("interval") or 5), 1)
    expires_in = int(body.get("expires_in") or 1800)
    vuri = str(body.get("verification_uri") or f"{ISSUER}/oauth2/device").strip()
    vcomplete = str(
        body.get("verification_uri_complete") or f"{vuri}?user_code={user_code}"
    ).strip()
    if not device_code or not user_code:
        return {"ok": False, "error": "device code missing fields", "mode": "device"}

    # curl_cffi 带 SSO 走 verify/approve（更像浏览器）
    try:
        from curl_cffi import requests as cf_requests

        sess = cf_requests.Session(impersonate="chrome131")
        proxies = {"http": proxy, "https": proxy} if proxy else None
        cookie = f"sso={sso}; sso-rw={sso}"
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            ),
            "Cookie": cookie,
            "Accept": "application/json, text/plain, */*",
            "Origin": "https://accounts.x.ai",
            "Referer": "https://accounts.x.ai/",
        }
        lg("[mint-B] GET verification_uri_complete…")
        sess.get(vcomplete, headers=headers, proxies=proxies, timeout=30, allow_redirects=True)
        lg("[mint-B] POST device/verify…")
        vr = sess.post(
            VERIFY_URL,
            data={"user_code": user_code, "client_id": CLIENT_ID},
            headers={**headers, "Content-Type": "application/x-www-form-urlencoded"},
            proxies=proxies,
            timeout=30,
        )
        lg(f"[mint-B] verify status={vr.status_code}")
        lg("[mint-B] POST device/approve…")
        ar = sess.post(
            APPROVE_URL,
            data={
                "user_code": user_code,
                "client_id": CLIENT_ID,
                "scope": SCOPE,
            },
            headers={**headers, "Content-Type": "application/x-www-form-urlencoded"},
            proxies=proxies,
            timeout=30,
        )
        lg(f"[mint-B] approve status={ar.status_code}")
    except ImportError:
        lg("[mint-B] curl_cffi 缺失，verify/approve 可能失败")
        # 降级：仅 cookie 头 form post
        _post_form(
            VERIFY_URL,
            {"user_code": user_code, "client_id": CLIENT_ID},
            proxy=proxy,
            headers={"Cookie": f"sso={sso}"},
        )
        _post_form(
            APPROVE_URL,
            {"user_code": user_code, "client_id": CLIENT_ID, "scope": SCOPE},
            proxy=proxy,
            headers={"Cookie": f"sso={sso}"},
        )
    except Exception as e:
        return {"ok": False, "error": f"verify/approve: {e}", "mode": "device"}

    # poll token
    lg("[mint-B] poll token…")
    deadline = time.time() + min(float(poll_timeout), float(expires_in))
    while time.time() < deadline:
        st, tb = _post_form(
            TOKEN_URL,
            {
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "device_code": device_code,
                "client_id": CLIENT_ID,
            },
            proxy=proxy,
        )
        if st == 200 and isinstance(tb, dict) and tb.get("access_token"):
            lg("[mint-B] token ok")
            return {
                "ok": True,
                "mode": "device",
                "access_token": str(tb.get("access_token") or ""),
                "refresh_token": str(tb.get("refresh_token") or ""),
                "id_token": tb.get("id_token"),
                "expires_in": tb.get("expires_in"),
                "raw": tb,
            }
        err = ""
        if isinstance(tb, dict):
            err = str(tb.get("error") or "")
        if err in ("authorization_pending", "slow_down"):
            time.sleep(interval + (2 if err == "slow_down" else 0))
            continue
        if err:
            return {"ok": False, "error": f"poll: {err}", "mode": "device"}
        time.sleep(interval)
    return {"ok": False, "error": "poll timeout", "mode": "device"}
