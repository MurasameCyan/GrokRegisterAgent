# -*- coding: utf-8 -*-
"""SSO 预检：mint / 批量操作前判定存活或封禁。

流程（用户要求：先测活，再检 blocked）：
  1) grok get-user —— 会话是否可用（sso 测活）
  2) CreateCookieSetterLink（gRPC-web）—— 是否封禁
     对齐 src/check_sso_ban.py：
       banned  -> grpc-message 含 blocked-user / WKE=unauthorized
       alive   -> 返回 cookie_setter_url（或无封禁标记）
  3) accounts.x.ai 会话作补充（sso2gropcpa）

返回 verdict: alive | dead | banned | unknown
  alive=True 时才应继续 mint。
"""
from __future__ import annotations

import json
import re
import secrets
import struct
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler

# 与 check_sso_ban.py 一致：仅明确封禁文案判 banned
BLOCK_MARKERS = (
    "blocked-user",
    "user is blocked",
    "wke=unauthorized",
    "unauthorized:blocked",
)
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
GET_USER_URL = "https://grok.com/rest/auth/get-user"
ACCOUNTS_URL = "https://accounts.x.ai/"
ACCOUNTS_ORIGIN = "https://accounts.x.ai"
CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
OIDC_ISSUER = "https://auth.x.ai"
# 与 check_sso_ban / ProtocolOAuthClient 同路径
CSL_URL = f"{ACCOUNTS_ORIGIN}/auth_mgmt.AuthManagement/CreateCookieSetterLink"


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def _opener(proxy: str = "", *, allow_redirect: bool = False):
    handlers: list[Any] = []
    p = (proxy or "").strip()
    if p:
        handlers.append(ProxyHandler({"http": p, "https": p}))
    if not allow_redirect:
        handlers.append(_NoRedirect())
    return build_opener(*handlers)


def _blob_banned(text: str) -> bool:
    low = (text or "").lower()
    return any(m in low for m in BLOCK_MARKERS)


def _norm_sso(sso: str) -> str:
    return (sso or "").replace("sso=", "").strip()


def _read_bot_flag(sso: str) -> dict[str, Any]:
    """只读解码 JWT payload 中的 bot_flag_source（不验签；无法改写）。"""
    t = _norm_sso(sso)
    if not t or t.count(".") < 2:
        return {"bot_flag_source": None, "is_bot_flag_1": False}
    try:
        import base64

        seg = t.split(".")[1]
        pad = "=" * ((4 - len(seg) % 4) % 4)
        raw = base64.urlsafe_b64decode(seg + pad)
        pl = json.loads(raw.decode("utf-8", errors="replace"))
        if not isinstance(pl, dict):
            return {"bot_flag_source": None, "is_bot_flag_1": False}
        v = pl.get("bot_flag_source")
        if v is None:
            return {"bot_flag_source": None, "is_bot_flag_1": False}
        is1 = v == 1 or v == "1" or (isinstance(v, (int, float, str)) and str(v) == "1")
        return {"bot_flag_source": v, "is_bot_flag_1": bool(is1)}
    except Exception:
        return {"bot_flag_source": None, "is_bot_flag_1": False}


def _cookie_header(sso: str) -> str:
    t = _norm_sso(sso)
    return f"sso={t}; sso-rw={t}"


def _pb_string(field_num: int, value: str) -> bytes:
    """protobuf wire: field_num, wire_type=2 (length-delimited) + utf-8 string."""
    data = (value or "").encode("utf-8")
    tag = (field_num << 3) | 2
    # varint tag + varint len + data
    out = bytearray()
    while True:
        b = tag & 0x7F
        tag >>= 7
        out.append(b | (0x80 if tag else 0))
        if not tag:
            break
    ln = len(data)
    while True:
        b = ln & 0x7F
        ln >>= 7
        out.append(b | (0x80 if ln else 0))
        if not ln:
            break
    out.extend(data)
    return bytes(out)


def _grpc_web_frame(payload: bytes) -> bytes:
    """grpc-web 数据帧：flag=0 + big-endian length + payload。"""
    return b"\x00" + struct.pack(">I", len(payload)) + payload


def _parse_grpc_web_response(raw: bytes, headers: Any) -> dict[str, Any]:
    """从 body + 响应头解析 grpc-status / grpc-message / 文本片段。"""
    text = raw.decode("utf-8", errors="replace")
    # trailers 有时嵌在 body 末尾（grpc-web）
    grpc_status = None
    grpc_message = ""
    try:
        # 响应头
        if headers is not None:
            for k, v in getattr(headers, "items", lambda: [])():
                lk = str(k).lower()
                if lk == "grpc-status":
                    try:
                        grpc_status = int(v)
                    except Exception:
                        pass
                if lk == "grpc-message":
                    grpc_message = str(v)
    except Exception:
        pass

    # body 内 trailer 块（以 grpc-status: 文本出现）
    m = re.search(r"grpc-status[:\s]+(\d+)", text, re.I)
    if m and grpc_status is None:
        try:
            grpc_status = int(m.group(1))
        except Exception:
            pass
    m2 = re.search(r"grpc-message[:\s]+([^\r\n]+)", text, re.I)
    if m2 and not grpc_message:
        grpc_message = m2.group(1).strip()

    # URL 解码 message
    try:
        from urllib.parse import unquote

        if grpc_message:
            grpc_message = unquote(grpc_message)
    except Exception:
        pass

    # cookie_setter_url 常以 https:// 出现在 proto 解码文本中
    url_m = re.search(r"https?://[^\s\x00\"']+", text)
    cookie_url = url_m.group(0) if url_m else ""

    return {
        "grpc_status": grpc_status,
        "grpc_message": grpc_message,
        "cookie_setter_url": cookie_url,
        "raw_preview": text[:500],
    }


def probe_get_user(sso: str, proxy: str = "", timeout: float = 20.0) -> dict[str, Any]:
    """grok get-user：200 视为会话可用（SSO 测活）。"""
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
    """sso2gropcpa：accounts.x.ai 不落到 sign-in。"""
    t = _norm_sso(sso)
    if not t:
        return {"ok": False, "error": "empty sso"}
    opener = _opener(proxy, allow_redirect=True)
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


def _prime_authorize(sso: str, proxy: str = "", timeout: float = 20.0) -> dict[str, Any]:
    """OAuth authorize 预热（check_sso_ban step 1）。"""
    t = _norm_sso(sso)
    state = secrets.token_hex(8)
    challenge = secrets.token_hex(16)
    q = urlencode(
        {
            "response_type": "code",
            "client_id": CLIENT_ID,
            "redirect_uri": "http://127.0.0.1:56121/callback",
            "scope": "openid profile email offline_access",
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "nonce": secrets.token_hex(8),
        }
    )
    auth_url = f"{OIDC_ISSUER}/oauth2/authorize?{q}"
    opener = _opener(proxy, allow_redirect=True)
    req = Request(
        auth_url,
        headers={"Cookie": _cookie_header(t), "User-Agent": UA},
        method="GET",
    )
    try:
        with opener.open(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")[:2000]
            final = resp.geturl() or ""
            if _blob_banned(body) or _blob_banned(final):
                return {"ok": False, "banned": True, "error": "blocked on authorize"}
            return {"ok": True, "url": final}
    except Exception as e:
        msg = str(e)
        if _blob_banned(msg):
            return {"ok": False, "banned": True, "error": msg[:300]}
        # 预热失败不阻断 ban 检测
        return {"ok": False, "error": msg[:200]}


def probe_cookie_setter_ban(sso: str, proxy: str = "", timeout: float = 30.0) -> dict[str, Any]:
    """CreateCookieSetterLink 封禁检测（对齐 check_sso_ban.py）。

    * banned  -> grpc-message 含 blocked-user / WKE
    * alive   -> 有 cookie_setter_url，或 grpc_status=0 且无封禁标记
    * unknown -> 网络/其它错误
    """
    t = _norm_sso(sso)
    if not t:
        return {"verdict": "unknown", "error": "empty sso"}

    prime = _prime_authorize(t, proxy=proxy, timeout=min(timeout, 20.0))
    if prime.get("banned"):
        return {
            "verdict": "banned",
            "message": prime.get("error") or "blocked on authorize",
            "mode": "authorize",
        }

    state = secrets.token_hex(8)
    challenge = secrets.token_hex(16)
    consent_url = f"{ACCOUNTS_ORIGIN}/oauth2/consent?" + urlencode(
        {
            "response_type": "code",
            "client_id": CLIENT_ID,
            "redirect_uri": "http://127.0.0.1:56121/callback",
            "scope": "openid profile email offline_access",
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "nonce": secrets.token_hex(8),
        }
    )
    error_url = f"{ACCOUNTS_ORIGIN}/sign-in"

    # CreateCookieSetterLinkRequest: field1=success/consent url, field2=error_url
    # （与常见 xconsole ProtocolOAuthClient 一致；字段号偏差时仍可从 grpc-message 判 ban）
    payload = _pb_string(1, consent_url) + _pb_string(2, error_url)
    body = _grpc_web_frame(payload)

    headers = {
        "Cookie": _cookie_header(t),
        "User-Agent": UA,
        "Content-Type": "application/grpc-web+proto",
        "x-grpc-web": "1",
        "x-user-agent": "connect-es/2.1.1",
        "Accept": "*/*",
        "Origin": ACCOUNTS_ORIGIN,
        "Referer": f"{ACCOUNTS_ORIGIN}/sign-in?redirect=oauth2-provider",
    }
    opener = _opener(proxy, allow_redirect=True)
    req = Request(CSL_URL, data=body, headers=headers, method="POST")
    try:
        with opener.open(req, timeout=timeout) as resp:
            raw = resp.read()
            parsed = _parse_grpc_web_response(raw, resp.headers)
    except Exception as e:
        # HTTPError 也可能带 body
        msg = str(e)
        raw_b = b""
        hdrs = None
        try:
            import urllib.error

            if isinstance(e, urllib.error.HTTPError):
                raw_b = e.read() if e.fp else b""
                hdrs = e.headers
                parsed = _parse_grpc_web_response(raw_b, hdrs)
                msg = parsed.get("grpc_message") or msg
            else:
                if _blob_banned(msg):
                    return {"verdict": "banned", "message": msg[:300], "mode": "csl_exc"}
                return {"verdict": "unknown", "message": msg[:300], "mode": "csl_exc"}
        except Exception:
            if _blob_banned(msg):
                return {"verdict": "banned", "message": msg[:300], "mode": "csl_exc"}
            return {"verdict": "unknown", "message": msg[:300], "mode": "csl_exc"}

    gmsg = parsed.get("grpc_message") or ""
    gstat = parsed.get("grpc_status")
    curl = parsed.get("cookie_setter_url") or ""
    blob = f"{gmsg} {parsed.get('raw_preview') or ''}"

    if _blob_banned(blob) or _blob_banned(gmsg):
        return {
            "verdict": "banned",
            "grpc_status": gstat,
            "message": gmsg or "User is blocked",
            "mode": "CreateCookieSetterLink",
        }

    # PERMISSION_DENIED=7 且无 cookie url → 多数为 ban/无权限；若无 block 文案仍标 unknown
    if gstat == 7 and not curl:
        if _blob_banned(blob) or "blocked" in blob.lower() or "unauthorized" in blob.lower():
            return {
                "verdict": "banned",
                "grpc_status": 7,
                "message": gmsg or "PERMISSION_DENIED",
                "mode": "CreateCookieSetterLink",
            }
        return {
            "verdict": "unknown",
            "grpc_status": 7,
            "message": gmsg or "PERMISSION_DENIED without block marker",
            "mode": "CreateCookieSetterLink",
        }

    if curl or gstat in (0, None):
        # 有 setter url 明确存活；status 0/空且无 ban 文案视为未封禁
        if curl:
            return {
                "verdict": "alive",
                "grpc_status": gstat,
                "message": "ok",
                "cookie_setter_url": curl,
                "mode": "CreateCookieSetterLink",
            }
        # 无 url 也无明确错误 → unknown（不单独当 banned）
        if gstat not in (None, 0) and gstat != 0:
            return {
                "verdict": "unknown",
                "grpc_status": gstat,
                "message": gmsg or f"grpc_status={gstat}",
                "mode": "CreateCookieSetterLink",
            }
        return {
            "verdict": "alive",
            "grpc_status": gstat,
            "message": "ok (no block marker)",
            "mode": "CreateCookieSetterLink",
        }

    return {
        "verdict": "unknown",
        "grpc_status": gstat,
        "message": gmsg or "unexpected csl response",
        "mode": "CreateCookieSetterLink",
    }


def probe_sso(sso: str, proxy: str = "") -> dict[str, Any]:
    """综合预检。alive=True 时才应继续 mint。

    顺序：
      1) SSO 测活（get-user）
      2) 封禁检测（CreateCookieSetterLink）
      3) accounts 会话补充

    额外只读解码 JWT bot_flag_source（展示/过滤用，无法改写）。
    """
    t = _norm_sso(sso)
    flag = _read_bot_flag(t)
    if not t:
        return {
            "alive": False,
            "verdict": "dead",
            "error": "empty sso",
            "get_user": None,
            "accounts": None,
            "ban": None,
            **flag,
        }

    # —— 1) SSO 测活 ——
    gu = probe_get_user(t, proxy=proxy)
    if gu.get("banned"):
        return {
            "alive": False,
            "verdict": "banned",
            "error": gu.get("error") or "blocked-user",
            "get_user": gu,
            "accounts": None,
            "ban": None,
            **flag,
        }

    session_ok = bool(gu.get("ok"))
    acc = None
    if not session_ok:
        # get-user 失败时再看 accounts（部分环境 grok 拦截但 accounts 仍有效）
        acc = probe_accounts_session(t, proxy=proxy)
        if acc.get("banned"):
            return {
                "alive": False,
                "verdict": "banned",
                "error": acc.get("error") or "blocked-user",
                "get_user": gu,
                "accounts": acc,
                "ban": None,
                **flag,
            }
        if not acc.get("ok"):
            return {
                "alive": False,
                "verdict": "dead",
                "error": gu.get("error") or acc.get("error") or "sso not alive",
                "get_user": gu,
                "accounts": acc,
                "ban": None,
                **flag,
            }

    # —— 2) 仅会话可用时再检 blocked ——
    ban = probe_cookie_setter_ban(t, proxy=proxy)
    if ban.get("verdict") == "banned":
        return {
            "alive": False,
            "verdict": "banned",
            "error": ban.get("message") or "User is blocked",
            "get_user": gu,
            "accounts": acc,
            "ban": ban,
            **flag,
        }

    # ban unknown 不阻断 mint（网络抖动）；get-user/accounts 已证明会话在
    if acc is None:
        acc = probe_accounts_session(t, proxy=proxy)

    return {
        "alive": True,
        "verdict": "alive",
        "email": gu.get("email"),
        "get_user": gu,
        "accounts": acc,
        "ban": ban,
        "note": None
        if ban.get("verdict") == "alive"
        else f"ban_check={ban.get('verdict') or 'unknown'}",
        **flag,
    }


if __name__ == "__main__":
    import sys

    sso = sys.argv[1] if len(sys.argv) > 1 else ""
    proxy = sys.argv[2] if len(sys.argv) > 2 else ""
    print(json.dumps(probe_sso(sso, proxy), ensure_ascii=False, indent=2))
