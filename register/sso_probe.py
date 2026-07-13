# -*- coding: utf-8 -*-
"""SSO 预检：mint / 批量操作前判定存活或封禁。

综合：
- sso2gropcpa：accounts.x.ai 会话（跳转 sign-in = 无效）
- 现有号池验活：grok.com/rest/auth/get-user
- check_sso_ban：响应文本中的 blocked-user / WKE 封禁标记

返回 verdict: alive | dead | banned | unknown
"""
from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler

BLOCK_MARKERS = ("blocked-user", "user is blocked", "wke=unauthorized", "unauthorized:blocked")
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
GET_USER_URL = "https://grok.com/rest/auth/get-user"
ACCOUNTS_URL = "https://accounts.x.ai/"
ACCOUNTS_ORIGIN = "https://accounts.x.ai"
CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
OIDC_ISSUER = "https://auth.x.ai"


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def _opener(proxy: str = ""):
    handlers: list[Any] = []
    p = (proxy or "").strip()
    if p:
        handlers.append(ProxyHandler({"http": p, "https": p}))
    handlers.append(_NoRedirect())
    return build_opener(*handlers)


def _blob_banned(text: str) -> bool:
    low = (text or "").lower()
    return any(m in low for m in BLOCK_MARKERS)


def _norm_sso(sso: str) -> str:
    return (sso or "").replace("sso=", "").strip()


def _cookie_header(sso: str) -> str:
    t = _norm_sso(sso)
    return f"sso={t}; sso-rw={t}"


def probe_get_user(sso: str, proxy: str = "", timeout: float = 20.0) -> dict[str, Any]:
    """grok get-user：200 视为会话可用。"""
    t = _norm_sso(sso)
    if not t:
        return {"ok": False, "status": 0, "error": "empty sso"}
    opener = _opener(proxy)
    req = Request(
        GET_USER_URL,
        headers={
            "Cookie": _cookie_header(t),
            "User-Agent": UA,
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with opener.open(req, timeout=timeout) as resp:
            status = getattr(resp, "status", 200) or 200
            raw = resp.read().decode("utf-8", errors="replace")
            if _blob_banned(raw):
                return {"ok": False, "status": status, "banned": True, "error": "blocked-user in body"}
            if status == 200:
                try:
                    data = json.loads(raw) if raw else {}
                except Exception:
                    data = {}
                email = data.get("email") if isinstance(data, dict) else None
                return {"ok": True, "status": 200, "email": email, "data": data}
            return {"ok": False, "status": status, "error": f"HTTP {status}"}
    except Exception as e:
        msg = str(e)
        code = 0
        m = re.search(r"(\d{3})", msg)
        if m:
            try:
                code = int(m.group(1))
            except Exception:
                code = 0
        if _blob_banned(msg):
            return {"ok": False, "status": code, "banned": True, "error": msg[:300]}
        return {"ok": False, "status": code, "error": msg[:300]}


def probe_accounts_session(sso: str, proxy: str = "", timeout: float = 20.0) -> dict[str, Any]:
    """sso2gropcpa 风格：accounts.x.ai 不落到 sign-in。"""
    t = _norm_sso(sso)
    if not t:
        return {"ok": False, "error": "empty sso"}
    # 允许跟随重定向的 opener（不用 NoRedirect）
    handlers: list[Any] = []
    p = (proxy or "").strip()
    if p:
        handlers.append(ProxyHandler({"http": p, "https": p}))
    opener = build_opener(*handlers)
    req = Request(
        ACCOUNTS_URL,
        headers={
            "Cookie": _cookie_header(t),
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml",
        },
        method="GET",
    )
    try:
        with opener.open(req, timeout=timeout) as resp:
            final = resp.geturl() or ""
            raw = resp.read().decode("utf-8", errors="replace")[:4000]
            if _blob_banned(raw) or _blob_banned(final):
                return {"ok": False, "banned": True, "url": final, "error": "blocked-user"}
            low = final.lower()
            if "sign-in" in low or "sign-up" in low:
                return {"ok": False, "url": final, "error": "sso invalid (sign-in redirect)"}
            return {"ok": True, "url": final}
    except Exception as e:
        msg = str(e)
        if _blob_banned(msg):
            return {"ok": False, "banned": True, "error": msg[:300]}
        return {"ok": False, "error": msg[:300]}


def probe_cookie_setter_ban(sso: str, proxy: str = "", timeout: float = 25.0) -> dict[str, Any]:
    """轻量 ban 探测：OAuth authorize 预热 + 对 accounts 的 consent 请求看 blocked 标记。

    完整 CreateCookieSetterLink(gRPC) 依赖 xconsole_client；此处用 HTTP 路径做降级检测。
    若出现 blocked-user → banned；否则 unknown（不据此单独判活）。
    """
    t = _norm_sso(sso)
    if not t:
        return {"verdict": "unknown", "error": "empty sso"}

    handlers: list[Any] = []
    p = (proxy or "").strip()
    if p:
        handlers.append(ProxyHandler({"http": p, "https": p}))
    opener = build_opener(*handlers)
    cookie = _cookie_header(t)

    # 1) authorize 预热（与 check_sso_ban 一致，best-effort）
    try:
        q = urlencode(
            {
                "response_type": "code",
                "client_id": CLIENT_ID,
                "redirect_uri": "http://127.0.0.1:56121/callback",
                "scope": "openid profile email offline_access",
                "state": "precheck",
                "code_challenge": "precheck_challenge_placeholder_value_32b",
                "code_challenge_method": "S256",
            }
        )
        auth_url = f"{OIDC_ISSUER}/oauth2/authorize?{q}"
        req = Request(
            auth_url,
            headers={"Cookie": cookie, "User-Agent": UA},
            method="GET",
        )
        try:
            with opener.open(req, timeout=timeout) as resp:
                body = resp.read().decode("utf-8", errors="replace")[:2000]
                if _blob_banned(body) or _blob_banned(resp.geturl() or ""):
                    return {"verdict": "banned", "message": "blocked on authorize"}
        except Exception as e:
            if _blob_banned(str(e)):
                return {"verdict": "banned", "message": str(e)[:300]}
    except Exception:
        pass

    # 2) consent 页（常能带回会话态错误文案）
    try:
        consent_q = urlencode(
            {
                "response_type": "code",
                "client_id": CLIENT_ID,
                "redirect_uri": "http://127.0.0.1:56121/callback",
                "scope": "openid profile email offline_access",
                "state": "precheck",
                "code_challenge": "precheck_challenge_placeholder_value_32b",
                "code_challenge_method": "S256",
            }
        )
        consent_url = f"{ACCOUNTS_ORIGIN}/oauth2/consent?{consent_q}"
        req = Request(
            consent_url,
            headers={
                "Cookie": cookie,
                "User-Agent": UA,
                "Accept": "text/html,application/json",
                "Referer": f"{ACCOUNTS_ORIGIN}/sign-in?redirect=oauth2-provider",
            },
            method="GET",
        )
        with opener.open(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")[:4000]
            final = resp.geturl() or ""
            if _blob_banned(raw) or _blob_banned(final):
                return {"verdict": "banned", "message": "blocked-user", "url": final}
            return {"verdict": "unknown", "message": "no block marker", "url": final}
    except Exception as e:
        msg = str(e)
        if _blob_banned(msg):
            return {"verdict": "banned", "message": msg[:300]}
        return {"verdict": "unknown", "message": msg[:300]}


def probe_sso(sso: str, proxy: str = "") -> dict[str, Any]:
    """综合预检。alive=True 时才应继续 mint。

    判定优先级：
    1) banned 标记 → banned / not alive
    2) get-user 200 且 accounts 会话有效 → alive
    3) get-user 200 但 accounts 失败 → 仍可 mint（device flow 侧再决）
    4) get-user 失败 + accounts 失败 → dead
    """
    t = _norm_sso(sso)
    if not t:
        return {
            "alive": False,
            "verdict": "dead",
            "error": "empty sso",
            "get_user": None,
            "accounts": None,
            "ban": None,
        }

    ban = probe_cookie_setter_ban(t, proxy=proxy)
    if ban.get("verdict") == "banned":
        return {
            "alive": False,
            "verdict": "banned",
            "error": ban.get("message") or "User is blocked",
            "get_user": None,
            "accounts": None,
            "ban": ban,
        }

    gu = probe_get_user(t, proxy=proxy)
    if gu.get("banned"):
        return {
            "alive": False,
            "verdict": "banned",
            "error": gu.get("error") or "blocked-user",
            "get_user": gu,
            "accounts": None,
            "ban": ban,
        }

    acc = probe_accounts_session(t, proxy=proxy)
    if acc.get("banned"):
        return {
            "alive": False,
            "verdict": "banned",
            "error": acc.get("error") or "blocked-user",
            "get_user": gu,
            "accounts": acc,
            "ban": ban,
        }

    if gu.get("ok"):
        # accounts 失败不阻塞（部分环境 accounts 拦截但 grok 仍可用）
        return {
            "alive": True,
            "verdict": "alive",
            "email": gu.get("email"),
            "get_user": gu,
            "accounts": acc,
            "ban": ban,
        }

    if acc.get("ok"):
        # accounts 会话在，get-user 偶发失败 → 允许 mint（与 sso2gropcpa 一致：accounts 过了再 device flow）
        return {
            "alive": True,
            "verdict": "alive",
            "email": None,
            "get_user": gu,
            "accounts": acc,
            "ban": ban,
            "note": "accounts ok, get-user failed",
        }

    return {
        "alive": False,
        "verdict": "dead",
        "error": gu.get("error") or acc.get("error") or "sso not alive",
        "get_user": gu,
        "accounts": acc,
        "ban": ban,
    }


if __name__ == "__main__":
    import sys

    sso = sys.argv[1] if len(sys.argv) > 1 else ""
    proxy = sys.argv[2] if len(sys.argv) > 2 else ""
    print(json.dumps(probe_sso(sso, proxy), ensure_ascii=False, indent=2))
