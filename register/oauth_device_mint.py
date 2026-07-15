# -*- coding: utf-8 -*-
"""
Device Flow mint（mode=B）：SSO cookie → access/refresh。

对齐 7sso2auth / regkit：
- client_id = b1a00492-…（grok-build），禁止用 "app"（会 400 client_id is required）
- approve 阶段带 referrer=grok-build，服务端才把 claim 签进 access_token
"""
from __future__ import annotations

import time
from typing import Any, Callable, Optional

CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
ISSUER = "https://auth.x.ai"
DEVICE_CODE_URL = f"{ISSUER}/oauth2/device/code"
TOKEN_URL = f"{ISSUER}/oauth2/token"
VERIFY_URL = f"{ISSUER}/oauth2/device/verify"
APPROVE_URL = f"{ISSUER}/oauth2/device/approve"
SCOPE = (
    "openid profile email offline_access grok-cli:access "
    "api:access conversations:read conversations:write"
)
GROK_REFERRER = "grok-build"

LogFn = Callable[[str], None]


def _noop(_: str) -> None:
    return None


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

    try:
        from curl_cffi import requests as cf_requests
    except ImportError as e:
        return {"ok": False, "error": f"curl_cffi required: {e}", "mode": "device"}

    proxies = {"http": proxy, "https": proxy} if proxy else None
    s = cf_requests.Session()
    if proxies:
        s.proxies = proxies
    for domain in (".x.ai", "accounts.x.ai", "auth.x.ai"):
        s.cookies.set("sso", sso, domain=domain)
        s.cookies.set("sso-rw", sso, domain=domain)

    # 探活 SSO
    try:
        r = s.get("https://accounts.x.ai/", impersonate="chrome120", timeout=15)
        if "sign-in" in str(r.url) or "sign-up" in str(r.url):
            return {"ok": False, "error": "sso invalid (sign-in redirect)", "mode": "device"}
    except Exception as e:
        return {"ok": False, "error": f"sso probe: {e}", "mode": "device"}

    lg("[mint-B] device code…")
    try:
        r = s.post(
            DEVICE_CODE_URL,
            data={"client_id": CLIENT_ID, "scope": SCOPE},
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
            },
            impersonate="chrome120",
            timeout=20,
        )
        body = r.json() if r.text else {}
    except Exception as e:
        return {"ok": False, "error": f"device code: {e}", "mode": "device"}
    if r.status_code != 200 or not isinstance(body, dict):
        return {
            "ok": False,
            "error": f"device code HTTP {r.status_code}: {body!r}"[:220],
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
    lg(f"[mint-B] user_code={user_code}")

    try:
        lg("[mint-B] GET verification_uri_complete…")
        s.get(vcomplete, impersonate="chrome120", timeout=20, allow_redirects=True)
        lg("[mint-B] POST device/verify…")
        vr = s.post(
            VERIFY_URL,
            data={"user_code": user_code},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            impersonate="chrome120",
            timeout=20,
            allow_redirects=True,
        )
        if "consent" not in str(vr.url):
            # 部分部署 verify 后 URL 不含 consent 字样仍可 approve
            lg(f"[mint-B] verify status={vr.status_code} url={str(vr.url)[:80]}")
        lg("[mint-B] POST device/approve (referrer=grok-build)…")
        ar = s.post(
            APPROVE_URL,
            data={
                "user_code": user_code,
                "action": "allow",
                "principal_type": "User",
                "principal_id": "",
                # 关键：approve 带 referrer 才签进 access_token
                "referrer": GROK_REFERRER,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            impersonate="chrome120",
            timeout=20,
            allow_redirects=True,
        )
        lg(f"[mint-B] approve status={ar.status_code} url={str(ar.url)[:80]}")
    except Exception as e:
        return {"ok": False, "error": f"verify/approve: {e}", "mode": "device"}

    lg("[mint-B] poll token…")
    deadline = time.time() + min(float(poll_timeout), float(expires_in), 180.0)
    while time.time() < deadline:
        try:
            tr = s.post(
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
                impersonate="chrome120",
                timeout=20,
            )
            tb = tr.json() if tr.text else {}
        except Exception as e:
            return {"ok": False, "error": f"poll: {e}", "mode": "device"}
        if tr.status_code == 200 and isinstance(tb, dict) and tb.get("access_token"):
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
        err = str((tb or {}).get("error") or "") if isinstance(tb, dict) else ""
        if err in ("authorization_pending", "slow_down"):
            time.sleep(interval + (2 if err == "slow_down" else 0))
            continue
        if err:
            return {"ok": False, "error": f"poll: {err}", "mode": "device"}
        time.sleep(interval)
    return {"ok": False, "error": "poll timeout", "mode": "device"}
