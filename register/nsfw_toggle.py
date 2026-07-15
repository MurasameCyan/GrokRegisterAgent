# -*- coding: utf-8 -*-
"""开启 Grok NSFW（对齐 grok-register-clean / AaronL725）。

真实链路（会话 SSO cookie，非 CPA access_token）：
  1) POST accounts.x.ai SetTosAcceptedVersion  (grpc-web)
  2) POST grok.com/rest/auth/set-birth-date     (JSON, 18+)
  3) POST grok.com/auth_mgmt.AuthManagement/UpdateUserFeatureControls
       feature = always_show_nsfw_content        (grpc-web+proto)

UI 对应：https://grok.com/user-feature-controls-static · Allow NSFW Content
"""
from __future__ import annotations

import random
import re
import struct
from datetime import date
from typing import Any, Callable, Optional

LogFn = Callable[[str], None]

TOS_URL = "https://accounts.x.ai/auth_mgmt.AuthManagement/SetTosAcceptedVersion"
BIRTH_URL = "https://grok.com/rest/auth/set-birth-date"
NSFW_URL = "https://grok.com/auth_mgmt.AuthManagement/UpdateUserFeatureControls"
FEATURE_KEY = b"always_show_nsfw_content"


def _noop(_: str) -> None:
    return None


def _preview(res: Any, limit: int = 200) -> str:
    try:
        text = str(getattr(res, "text", None) or "")
    except Exception:
        text = ""
    return re.sub(r"\s+", " ", text).strip()[:limit]


def _is_cf_block(res: Any) -> bool:
    try:
        headers = {
            str(k).lower(): str(v).lower()
            for k, v in dict(getattr(res, "headers", {}) or {}).items()
        }
        text = str(getattr(res, "text", None) or "").lower()
        server = headers.get("server", "")
        ctype = headers.get("content-type", "")
        code = int(getattr(res, "status_code", 0) or 0)
        return code in (403, 429, 503) and (
            "cloudflare" in server
            or "cloudflare" in text
            or "cf-error" in text
            or "__cf_chl" in text
            or "text/html" in ctype
        )
    except Exception:
        return False


def _random_birthdate_iso() -> str:
    today = date.today()
    age = random.randint(20, 40)
    y = today.year - age
    m = random.randint(1, 12)
    d = random.randint(1, 28)
    return f"{y}-{m:02d}-{d:02d}T16:00:00.000Z"


def encode_grpc_nsfw_settings() -> bytes:
    """protobuf + grpc-web frame：UpdateUserFeatureControls(always_show_nsfw_content=on)。

    字段布局与 clean 包一致：
      field1 = len-delimited { field2_varint = 1 }   # enable flag
      field2 = len-delimited { field1_string = "always_show_nsfw_content" }
      frame  = 0x00 | big-endian-u32-len | payload
    """
    field1_content = bytes([0x10, 0x01])
    field1 = bytes([0x0A, len(field1_content)]) + field1_content
    field2_inner = bytes([0x0A, len(FEATURE_KEY)]) + FEATURE_KEY
    field2 = bytes([0x12, len(field2_inner)]) + field2_inner
    payload = field1 + field2
    return b"\x00" + struct.pack(">I", len(payload)) + payload


def encode_grpc_tos_accepted(version: int = 1) -> bytes:
    """SetTosAcceptedVersion：field2 varint = version。"""
    # field number 2, wire type 0 (varint)
    payload = struct.pack("B", (2 << 3) | 0) + struct.pack("B", int(version) & 0x7F)
    return b"\x00" + struct.pack(">I", len(payload)) + payload


def _set_tos_accepted(session: Any, log: LogFn, timeout: float) -> tuple[bool, str]:
    headers = {
        "content-type": "application/grpc-web+proto",
        "x-grpc-web": "1",
        "x-user-agent": "connect-es/2.1.1",
        "origin": "https://accounts.x.ai",
        "referer": "https://accounts.x.ai/accept-tos",
    }
    try:
        res = session.post(
            TOS_URL, data=encode_grpc_tos_accepted(1), headers=headers, timeout=timeout
        )
        log(f"[nsfw] set_tos status={res.status_code} body={_preview(res)}")
        if 200 <= res.status_code < 300:
            return True, "ok"
        if _is_cf_block(res):
            return False, f"set_tos Cloudflare block HTTP {res.status_code}"
        return False, f"set_tos HTTP {res.status_code}: {_preview(res)}"
    except Exception as e:
        return False, f"set_tos: {e}"


def _set_birth_date(session: Any, log: LogFn, timeout: float) -> tuple[bool, str]:
    headers = {
        "content-type": "application/json",
        "origin": "https://grok.com",
        "referer": "https://grok.com/",
    }
    payload = {"birthDate": _random_birthdate_iso()}
    try:
        res = session.post(BIRTH_URL, json=payload, headers=headers, timeout=timeout)
        log(f"[nsfw] set_birth_date status={res.status_code} body={_preview(res)}")
        if 200 <= res.status_code < 300:
            return True, "ok"
        if _is_cf_block(res):
            return False, f"set_birth_date Cloudflare block HTTP {res.status_code}"
        # 已设置过生日时部分环境返回 4xx 仍可继续
        if res.status_code in (400, 409):
            log("[nsfw] set_birth_date 非 2xx，继续尝试 NSFW feature")
            return True, f"soft-ok HTTP {res.status_code}"
        return False, f"set_birth_date HTTP {res.status_code}: {_preview(res)}"
    except Exception as e:
        return False, f"set_birth_date: {e}"


def _update_nsfw_feature(session: Any, log: LogFn, timeout: float) -> tuple[bool, str]:
    headers = {
        "content-type": "application/grpc-web+proto",
        "x-grpc-web": "1",
        "origin": "https://grok.com",
        "referer": "https://grok.com/",
    }
    try:
        res = session.post(
            NSFW_URL,
            data=encode_grpc_nsfw_settings(),
            headers=headers,
            timeout=timeout,
        )
        log(f"[nsfw] UpdateUserFeatureControls status={res.status_code} body={_preview(res)}")
        if 200 <= res.status_code < 300:
            return True, "ok"
        if _is_cf_block(res):
            return False, f"update_nsfw Cloudflare block HTTP {res.status_code}"
        return False, f"update_nsfw HTTP {res.status_code}: {_preview(res)}"
    except Exception as e:
        return False, f"update_nsfw: {e}"


def enable_nsfw_for_sso(
    sso: str,
    *,
    cf_clearance: str = "",
    proxy: str = "",
    timeout: float = 20.0,
    skip_tos: bool = False,
    skip_birth: bool = False,
    max_attempts: int = 2,
    retry_delay_sec: float = 2.0,
    log: Optional[LogFn] = None,
) -> dict[str, Any]:
    """用会话 SSO 开启 NSFW（主路径，与 clean 包一致）。

    max_attempts: 失败自动二次重试（默认 2，#19）。
    返回: ok, steps?, error?, message?, attempts?
    """
    log = log or _noop
    sso = str(sso or "").strip()
    if sso.lower().startswith("sso="):
        sso = sso[4:]
    if not sso:
        return {"ok": False, "error": "empty sso"}

    try:
        from curl_cffi import requests as cf_requests
    except ImportError as e:
        return {"ok": False, "error": f"curl_cffi required: {e}"}

    import time

    proxies = {"http": proxy, "https": proxy} if proxy else None
    cookie_parts = [f"sso={sso}", f"sso-rw={sso}"]
    if cf_clearance:
        cookie_parts.append(f"cf_clearance={str(cf_clearance).strip()}")

    ua = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    )
    attempts = max(1, min(int(max_attempts or 2), 4))
    last: dict[str, Any] = {"ok": False, "error": "not attempted"}
    for attempt in range(1, attempts + 1):
        steps: dict[str, Any] = {}
        try:
            with cf_requests.Session(
                impersonate="chrome120", proxies=proxies
            ) as session:
                session.headers.update(
                    {
                        "user-agent": ua,
                        "cookie": "; ".join(cookie_parts),
                        "accept": "*/*",
                    }
                )
                # 可选：先暖一下 grok.com，减少纯 API 被拦
                try:
                    session.get("https://grok.com/", timeout=min(12.0, timeout))
                except Exception:
                    pass

                if not skip_tos:
                    ok, msg = _set_tos_accepted(session, log, timeout)
                    steps["tos"] = {"ok": ok, "message": msg}
                    if not ok:
                        log(f"[nsfw] TOS 步骤失败，继续: {msg}")
                else:
                    steps["tos"] = {"ok": True, "skipped": True}

                if not skip_birth:
                    ok, msg = _set_birth_date(session, log, timeout)
                    steps["birth"] = {"ok": ok, "message": msg}
                    if not ok:
                        log(f"[nsfw] birth 步骤失败，继续: {msg}")
                else:
                    steps["birth"] = {"ok": True, "skipped": True}

                ok, msg = _update_nsfw_feature(session, log, timeout)
                steps["feature"] = {"ok": ok, "message": msg}
                if ok:
                    log(
                        f"[nsfw] ✔ always_show_nsfw_content 已开启"
                        f"{'' if attempt == 1 else f'（第 {attempt} 次）'}"
                    )
                    return {
                        "ok": True,
                        "message": "成功开启 NSFW (always_show_nsfw_content)",
                        "endpoint": NSFW_URL,
                        "feature": "always_show_nsfw_content",
                        "steps": steps,
                        "attempts": attempt,
                    }
                last = {
                    "ok": False,
                    "error": msg,
                    "endpoint": NSFW_URL,
                    "steps": steps,
                    "attempts": attempt,
                }
                log(
                    f"[nsfw] ✘ 第 {attempt}/{attempts} 次失败: {msg}"
                    + ("，将重试…" if attempt < attempts else "")
                )
        except Exception as e:
            last = {"ok": False, "error": str(e), "steps": steps, "attempts": attempt}
            log(
                f"[nsfw] ✘ 第 {attempt}/{attempts} 次异常: {e}"
                + ("，将重试…" if attempt < attempts else "")
            )
        if attempt < attempts:
            time.sleep(max(0.5, float(retry_delay_sec or 2.0)) * attempt)
    return last


def enable_nsfw_for_token(
    token: str,
    *,
    cf_clearance: str = "",
    proxy: str = "",
    timeout: float = 20.0,
    log: Optional[LogFn] = None,
) -> dict[str, Any]:
    """兼容入口：token 按 SSO 会话 cookie 处理（非 CPA Bearer access_token）。

    历史误用 access_token 调 REST set-user-settings 无效；正式路径见 enable_nsfw_for_sso。
    """
    return enable_nsfw_for_sso(
        token,
        cf_clearance=cf_clearance,
        proxy=proxy,
        timeout=timeout,
        log=log,
    )
