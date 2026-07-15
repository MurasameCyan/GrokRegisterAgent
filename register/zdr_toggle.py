# -*- coding: utf-8 -*-
"""关闭 / 探测 Grok 账号级 ZDR（Zero Data Retention）。

协议优先：UpdateUserFeatureControls 候选 feature keys + 响应头 X-Zero-Retention probe。
失败不抛；由调用方写 tag（关=closed / 开=open）。

注意：公开文档无已证实 key；DEFAULT_FEATURE_ATTEMPTS 可配置增补。
"""
from __future__ import annotations

import re
import struct
import time
from typing import Any, Callable, Optional

LogFn = Callable[[str], None]

FEATURE_URL = "https://grok.com/auth_mgmt.AuthManagement/UpdateUserFeatureControls"

# (feature_key, enabled_varint) — 尽力尝试；HAR 后增补
DEFAULT_FEATURE_ATTEMPTS: list[tuple[str, int]] = [
    ("zero_data_retention", 0),
    ("zero_retention", 0),
    ("zdr", 0),
    ("disable_zero_data_retention", 1),
    ("allow_file_uploads", 1),
    ("allow_file_content", 1),
]


def _noop(_: str) -> None:
    return None


def _preview(res: Any, limit: int = 200) -> str:
    try:
        text = str(getattr(res, "text", None) or "")
    except Exception:
        text = ""
    return re.sub(r"\s+", " ", text).strip()[:limit]


def encode_grpc_feature_control(feature_key: bytes | str, enabled: int = 1) -> bytes:
    """与 nsfw_toggle.encode_grpc_nsfw_settings 同布局，key/enabled 可配。"""
    key = feature_key if isinstance(feature_key, bytes) else str(feature_key).encode("utf-8")
    en = int(enabled) & 0x7F
    field1_content = bytes([0x10, en])
    field1 = bytes([0x0A, len(field1_content)]) + field1_content
    field2_inner = bytes([0x0A, len(key)]) + key
    field2 = bytes([0x12, len(field2_inner)]) + field2_inner
    payload = field1 + field2
    return b"\x00" + struct.pack(">I", len(payload)) + payload


def _header_zdr_true(res: Any) -> Optional[bool]:
    """True=仍 ZDR；False=明确非 ZDR；None=未知。"""
    try:
        headers = {
            str(k).lower(): str(v)
            for k, v in dict(getattr(res, "headers", {}) or {}).items()
        }
    except Exception:
        return None
    raw = headers.get("x-zero-retention")
    if raw is None:
        return None
    v = str(raw).strip().lower()
    if v in ("true", "1", "yes"):
        return True
    if v in ("false", "0", "no"):
        return False
    return None


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


def _try_feature(
    session: Any, log: LogFn, timeout: float, feature: str, enabled: int
) -> dict[str, Any]:
    headers = {
        "content-type": "application/grpc-web+proto",
        "x-grpc-web": "1",
        "origin": "https://grok.com",
        "referer": "https://grok.com/",
    }
    try:
        res = session.post(
            FEATURE_URL,
            data=encode_grpc_feature_control(feature, enabled=enabled),
            headers=headers,
            timeout=timeout,
        )
        zdr = _header_zdr_true(res)
        log(
            f"[zdr] feature={feature} en={enabled} status={res.status_code} "
            f"x-zero-retention={zdr} body={_preview(res)}"
        )
        return {
            "feature": feature,
            "enabled": enabled,
            "ok_http": 200 <= int(res.status_code or 0) < 300,
            "status": int(res.status_code or 0),
            "zdr_header": zdr,
            "cf_block": _is_cf_block(res),
            "body": _preview(res),
        }
    except Exception as e:
        return {
            "feature": feature,
            "enabled": enabled,
            "ok_http": False,
            "error": str(e)[:300],
            "zdr_header": None,
        }


def _probe_retention(session: Any, log: LogFn, timeout: float) -> dict[str, Any]:
    """轻量 probe：GET grok.com/ + 可选 rest，收集 X-Zero-Retention。"""
    out: dict[str, Any] = {"skipped": False, "samples": []}
    urls = [
        "https://grok.com/",
        "https://grok.com/rest/app-chat/conversations",
    ]
    any_true = False
    any_false = False
    for url in urls:
        try:
            res = session.get(url, timeout=min(12.0, timeout))
            zdr = _header_zdr_true(res)
            sample = {
                "url": url,
                "status": int(getattr(res, "status_code", 0) or 0),
                "zdr_header": zdr,
            }
            out["samples"].append(sample)
            log(f"[zdr] probe {url} status={sample['status']} x-zero-retention={zdr}")
            if zdr is True:
                any_true = True
            elif zdr is False:
                any_false = True
        except Exception as e:
            out["samples"].append({"url": url, "error": str(e)[:200]})
    if any_true:
        out["still_zdr"] = True
    elif any_false:
        out["still_zdr"] = False
    else:
        out["still_zdr"] = None
        out["note"] = "no X-Zero-Retention header on probe samples"
    return out


def disable_zdr_for_sso(
    sso: str,
    *,
    cf_clearance: str = "",
    proxy: str = "",
    timeout: float = 20.0,
    max_attempts: int = 2,
    retry_delay_sec: float = 2.0,
    feature_attempts: list[tuple[str, int]] | None = None,
    log: Optional[LogFn] = None,
) -> dict[str, Any]:
    """尽力关闭 ZDR 并 probe。

    返回:
      ok: bool  — True 仅当判定已关（closed）
      zdr_status: "closed" | "open" | "unknown"
      error, steps, probe, attempts
    """
    log = log or _noop
    sso = str(sso or "").strip()
    if sso.lower().startswith("sso="):
        sso = sso[4:]
    if not sso:
        return {
            "ok": False,
            "zdr_status": "open",
            "error": "empty sso",
        }

    try:
        from curl_cffi import requests as cf_requests
    except ImportError as e:
        return {
            "ok": False,
            "zdr_status": "open",
            "error": f"curl_cffi required: {e}",
        }

    attempts_list = feature_attempts or list(DEFAULT_FEATURE_ATTEMPTS)
    proxies = {"http": proxy, "https": proxy} if proxy else None
    cookie_parts = [f"sso={sso}", f"sso-rw={sso}"]
    if cf_clearance:
        cookie_parts.append(f"cf_clearance={str(cf_clearance).strip()}")
    ua = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    )
    n_att = max(1, min(int(max_attempts or 2), 4))
    last: dict[str, Any] = {
        "ok": False,
        "zdr_status": "open",
        "error": "not attempted",
    }

    for attempt in range(1, n_att + 1):
        steps: dict[str, Any] = {"features": []}
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
                try:
                    session.get("https://grok.com/", timeout=min(12.0, timeout))
                except Exception:
                    pass

                for feat, en in attempts_list:
                    steps["features"].append(
                        _try_feature(session, log, timeout, feat, en)
                    )

                probe = _probe_retention(session, log, timeout)
                steps["probe"] = probe
                still = probe.get("still_zdr")

                # 判定：probe 明确仍 ZDR → open；明确非 ZDR → closed；
                # 未知 → 保守 open（规格：无证据不标关）
                if still is True:
                    last = {
                        "ok": False,
                        "zdr_status": "open",
                        "error": "probe still X-Zero-Retention: true",
                        "steps": steps,
                        "probe": probe,
                        "attempts": attempt,
                    }
                elif still is False:
                    log(f"[zdr] ✔ probe 非 ZDR（第 {attempt} 次）")
                    return {
                        "ok": True,
                        "zdr_status": "closed",
                        "message": "ZDR closed (probe X-Zero-Retention false)",
                        "steps": steps,
                        "probe": probe,
                        "attempts": attempt,
                    }
                else:
                    last = {
                        "ok": False,
                        "zdr_status": "open",
                        "error": "probe inconclusive; conservatively mark open",
                        "steps": steps,
                        "probe": probe,
                        "attempts": attempt,
                    }
                    log(f"[zdr] ✘ 第 {attempt}/{n_att} probe 无结论: {last['error']}")
        except Exception as e:
            last = {
                "ok": False,
                "zdr_status": "open",
                "error": str(e)[:300],
                "steps": steps,
                "attempts": attempt,
            }
            log(f"[zdr] ✘ 第 {attempt}/{n_att} 异常: {e}")
        if attempt < n_att:
            time.sleep(max(0.5, float(retry_delay_sec or 2.0)) * attempt)
    return last
