# -*- coding: utf-8 -*-
"""CPA auth 测活（对齐 cehuo.py）。

对 xai-*.json 调 cli-chat-proxy /v1/responses：
  2xx → ok
  401/402/403 → dead（默认删除候选）
  其他/网络 → keep / error
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from cpa_schema import DEFAULT_BASE_URL, DEFAULT_CLIENT_HEADERS, GROK_CLIENT_VERSION

# 与 cehuo.py 默认 delete-statuses 一致
DEFAULT_DEAD_STATUSES = frozenset({401, 402, 403})


def _opener(proxy: str = ""):
    handlers: list[Any] = []
    p = (proxy or "").strip()
    if p:
        handlers.append(urllib.request.ProxyHandler({"http": p, "https": p}))
    return urllib.request.build_opener(*handlers) if handlers else urllib.request.build_opener()


def probe_mini_response(
    access_token: str,
    *,
    base_url: str = DEFAULT_BASE_URL,
    proxy: str = "",
    timeout: float = 60.0,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    """POST /responses 迷你对话测活（model=grok-4.5，要求可调通）。

    返回: ok, status, text?, model?, error?
    """
    access = str(access_token or "").strip()
    if not access:
        return {"ok": False, "status": 0, "error": "missing access_token", "text": ""}
    base = str(base_url or DEFAULT_BASE_URL).rstrip("/")
    url = f"{base}/responses"
    payload = {
        "model": "grok-4.5",
        "stream": False,
        "input": "Reply with exactly MINT_OK",
        "reasoning": {"effort": "low"},
    }
    hdrs: dict[str, str] = {
        "Authorization": f"Bearer {access}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        **DEFAULT_CLIENT_HEADERS,
    }
    if isinstance(headers, dict):
        for k, v in headers.items():
            if v is None:
                continue
            key = str(k)
            if key.lower() in ("authorization", "content-type"):
                continue
            hdrs[key] = str(v)
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=hdrs,
        method="POST",
    )
    opener = _opener(proxy)
    try:
        with opener.open(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8", errors="replace") or "{}")
            texts: list[str] = []
            for item in body.get("output") or []:
                if not isinstance(item, dict):
                    continue
                if item.get("type") == "message":
                    for c in item.get("content") or []:
                        if isinstance(c, dict) and c.get("type") == "output_text":
                            texts.append(str(c.get("text") or ""))
            # 兼容部分代理直接返回 output_text / choices
            if not texts and isinstance(body.get("output_text"), str):
                texts.append(body["output_text"])
            text = "\n".join(texts).strip()
            return {
                "ok": True,
                "status": getattr(resp, "status", 200) or 200,
                "model": body.get("model"),
                "text": text,
                "usage": body.get("usage"),
                "error": None,
            }
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")[:800] if e.fp else ""
        return {
            "ok": False,
            "status": int(e.code or 0),
            "error": raw or f"HTTP {e.code}",
            "text": "",
        }
    except Exception as e:
        return {"ok": False, "status": 0, "error": str(e)[:300], "text": ""}


def probe_models(
    access_token: str,
    *,
    base_url: str = DEFAULT_BASE_URL,
    proxy: str = "",
    timeout: float = 30.0,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    """GET /models：要求列表含 grok-4.5，否则视为假活 token。

    返回: ok, has_grok_45, model_ids, status, error?
    """
    access = str(access_token or "").strip()
    if not access:
        return {
            "ok": False,
            "has_grok_45": False,
            "model_ids": [],
            "status": 0,
            "error": "missing access_token",
        }
    base = str(base_url or DEFAULT_BASE_URL).rstrip("/")
    url = f"{base}/models"
    hdrs: dict[str, str] = {
        "Authorization": f"Bearer {access}",
        "Accept": "application/json",
        **DEFAULT_CLIENT_HEADERS,
    }
    if isinstance(headers, dict):
        for k, v in headers.items():
            if v is None:
                continue
            key = str(k)
            if key.lower() in ("authorization", "content-type"):
                continue
            hdrs[key] = str(v)
    req = urllib.request.Request(url, headers=hdrs, method="GET")
    opener = _opener(proxy)
    try:
        with opener.open(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8", errors="replace") or "{}")
            ids = [
                str(x.get("id") or "")
                for x in (body.get("data") or [])
                if isinstance(x, dict)
            ]
            has = any(i == "grok-4.5" for i in ids)
            return {
                "ok": True,
                "status": getattr(resp, "status", 200) or 200,
                "model_ids": ids,
                "has_grok_45": has,
                "error": None if has else "token ok but grok-4.5 not listed",
            }
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")[:500] if e.fp else ""
        return {
            "ok": False,
            "status": int(e.code or 0),
            "model_ids": [],
            "has_grok_45": False,
            "error": raw or f"HTTP {e.code}",
        }
    except Exception as e:
        return {
            "ok": False,
            "status": 0,
            "model_ids": [],
            "has_grok_45": False,
            "error": str(e)[:300],
        }


def probe_cpa_auth(
    path_or_doc: str | Path | dict[str, Any],
    *,
    proxy: str = "",
    model: str = "grok-4.5",
    prompt: str = "ping",
    max_output_tokens: int = 1,
    timeout: float = 20.0,
    dead_statuses: set[int] | frozenset[int] | None = None,
) -> dict[str, Any]:
    """测活单个 CPA auth 文件或已解析的 dict。

    返回:
      ok / dead / error
      http_status, elapsed_ms, summary, email, action
    """
    started = time.time()
    dead_statuses = dead_statuses or DEFAULT_DEAD_STATUSES
    path: Path | None = None
    doc: dict[str, Any]

    if isinstance(path_or_doc, dict):
        doc = path_or_doc
    else:
        path = Path(path_or_doc)
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:
            return {
                "ok": False,
                "alive": False,
                "action": "error",
                "error": f"read failed: {e}",
                "path": str(path),
                "elapsed_ms": int((time.time() - started) * 1000),
            }

    access = str(doc.get("access_token") or "").strip()
    email = str(doc.get("email") or "")
    base = str(doc.get("base_url") or DEFAULT_BASE_URL).rstrip("/")
    if not access:
        return {
            "ok": False,
            "alive": False,
            "action": "error",
            "error": "missing access_token",
            "email": email,
            "path": str(path) if path else "",
            "elapsed_ms": int((time.time() - started) * 1000),
        }

    endpoint = f"{base}/responses"
    body = json.dumps(
        {
            "model": model,
            "input": prompt,
            "max_output_tokens": max_output_tokens,
            "store": False,
        }
    ).encode("utf-8")

    headers: dict[str, str] = {
        "Authorization": f"Bearer {access}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "x-grok-client-version": GROK_CLIENT_VERSION,
    }
    # 合并文件内 headers（cehuo 主要设 version；完整 client headers 更贴近真实）
    file_headers = doc.get("headers")
    if isinstance(file_headers, dict):
        for k, v in file_headers.items():
            if v is None:
                continue
            key = str(k)
            # 不覆盖 Authorization / Content-Type
            if key.lower() in ("authorization", "content-type"):
                continue
            headers[key] = str(v)

    req = urllib.request.Request(endpoint, data=body, headers=headers, method="POST")
    opener = _opener(proxy)
    try:
        with opener.open(req, timeout=timeout) as resp:
            status = getattr(resp, "status", 200) or 200
            raw = resp.read().decode("utf-8", errors="replace")[:2048]
            summary = " ".join(raw.replace("\r", "").split())
            if len(summary) > 300:
                summary = summary[:300] + "..."
            elapsed = int((time.time() - started) * 1000)
            if 200 <= status < 300:
                return {
                    "ok": True,
                    "alive": True,
                    "action": "ok",
                    "http_status": status,
                    "summary": summary or "ok",
                    "email": email,
                    "path": str(path) if path else "",
                    "elapsed_ms": elapsed,
                }
            if status in dead_statuses:
                return {
                    "ok": False,
                    "alive": False,
                    "action": "dead",
                    "http_status": status,
                    "summary": summary,
                    "email": email,
                    "path": str(path) if path else "",
                    "elapsed_ms": elapsed,
                    "error": f"HTTP {status}",
                }
            return {
                "ok": False,
                "alive": False,
                "action": "keep",
                "http_status": status,
                "summary": summary,
                "email": email,
                "path": str(path) if path else "",
                "elapsed_ms": elapsed,
                "error": f"HTTP {status}",
            }
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")[:2048] if e.fp else ""
        summary = " ".join(raw.replace("\r", "").split())
        if len(summary) > 300:
            summary = summary[:300] + "..."
        status = int(e.code or 0)
        elapsed = int((time.time() - started) * 1000)
        if status in dead_statuses:
            return {
                "ok": False,
                "alive": False,
                "action": "dead",
                "http_status": status,
                "summary": summary,
                "email": email,
                "path": str(path) if path else "",
                "elapsed_ms": elapsed,
                "error": f"HTTP {status}",
            }
        return {
            "ok": False,
            "alive": False,
            "action": "keep",
            "http_status": status,
            "summary": summary,
            "email": email,
            "path": str(path) if path else "",
            "elapsed_ms": elapsed,
            "error": f"HTTP {status}",
        }
    except Exception as e:
        return {
            "ok": False,
            "alive": False,
            "action": "error",
            "http_status": 0,
            "summary": str(e)[:300],
            "email": email,
            "path": str(path) if path else "",
            "elapsed_ms": int((time.time() - started) * 1000),
            "error": str(e)[:300],
        }


# 测活 dead 后触发密码重登二次检测的 HTTP 状态
RECOVER_HTTP_STATUSES = frozenset({401, 403})

# 写入 auth JSON 的侧车字段（CPA 忽略；列表/UI 持久化测活与 HTTP）
PROBE_ACTION_KEY = "probe_action"
PROBE_HTTP_KEY = "probe_http"
PROBE_AT_KEY = "probe_at"


def persist_probe_result(path: str | Path, probe: dict[str, Any]) -> None:
    """把测活 action / http_status 写回 auth 文件，刷新后仍可显示。"""
    p = Path(path)
    if not p.is_file():
        return
    action = str(probe.get("action") or "").strip()
    if not action:
        return
    try:
        http = int(probe.get("http_status") or 0)
    except Exception:
        http = 0
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return
        data[PROBE_ACTION_KEY] = action
        if http > 0:
            data[PROBE_HTTP_KEY] = http
        else:
            data.pop(PROBE_HTTP_KEY, None)
        data[PROBE_AT_KEY] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(p)
    except Exception:
        pass

# mint 刚完成时常出现瞬时 permission-denied / 403，CPA 面板稍后仍 200
_SOFT_403_MARKERS = (
    "permission-denied",
    "permission_denied",
    "permission denied",
    "not authorized",
    "not_authorized",
    "token not ready",
    "temporarily unavailable",
)


def _looks_like_soft_403(probe: dict[str, Any]) -> bool:
    """刚 mint 的瞬时 403（permission-denied 等），不宜立刻判死号。"""
    if int(probe.get("http_status") or 0) != 403:
        return False
    blob = " ".join(
        str(probe.get(k) or "") for k in ("summary", "error", "message")
    ).lower()
    if any(m in blob for m in _SOFT_403_MARKERS):
        return True
    # 无 body 的裸 403 在 mint 后也常是传播延迟
    if not blob.strip() or blob.strip() in ("http 403", "403"):
        return True
    return False


def probe_cpa_auth_with_mint_soft_retry(
    path: str | Path,
    *,
    proxy: str = "",
    retries: int = 2,
    delay_sec: float = 2.5,
) -> dict[str, Any]:
    """mint 后测活：遇疑似瞬时 403 则短暂等待重试，仍失败再标 soft_warn 而非 dead。

    返回字段：
      soft_403: bool  是否曾命中软 403 路径
      mint_soft_warn: str | None  最终仍失败时的警告（action 改为 keep，不当 dead）
    """
    path = Path(path)
    r = probe_cpa_auth(path, proxy=proxy)
    r["soft_403"] = False
    r["mint_soft_warn"] = None
    attempts = max(0, int(retries))
    for i in range(attempts):
        if r.get("action") != "dead" or not _looks_like_soft_403(r):
            break
        r["soft_403"] = True
        time.sleep(max(0.5, float(delay_sec) * (1.0 + 0.35 * i)))
        r2 = probe_cpa_auth(path, proxy=proxy)
        r2["soft_403"] = True
        r2["mint_soft_warn"] = None
        r2["soft_retries"] = i + 1
        r = r2
    # 重试后仍是软 403 → 不当 dead（文件保留，ok 由上层 mint 逻辑处理）
    if r.get("action") == "dead" and _looks_like_soft_403(r):
        r["soft_403"] = True
        r["mint_soft_warn"] = (
            f"mint 后瞬时 403（{r.get('summary') or r.get('error') or 'permission-denied'}），"
            "已重试仍失败；文件已保留，请稍后手动测活"
        )
        r["action"] = "keep"
        r["ok"] = False
        r["alive"] = False
        r["error"] = r["mint_soft_warn"]
    return r


def probe_and_cleanup(
    path: str | Path,
    *,
    proxy: str = "",
    delete_on_dead: bool = False,
    email: str | None = None,
    password: str | None = None,
    recover_on_403: bool = True,
    recover_on_auth_error: bool | None = None,
    mint_soft_retry: bool = False,
) -> dict[str, Any]:
    """测活；若 dead 且 delete_on_dead 则删除文件。

    遇 HTTP 401/403 且提供 email/password 时：密码重登 → mint → 发英文消息 → 二次测活。
    默认 delete_on_dead=False（仅标记死号）。
    recover_on_403 为兼容旧参数；recover_on_auth_error 优先（默认与 recover_on_403 相同）。
    mint_soft_retry=True：mint 后路径，瞬时 403 重试并不当 dead。
    """
    path = Path(path)
    if mint_soft_retry:
        r = probe_cpa_auth_with_mint_soft_retry(path, proxy=proxy)
    else:
        r = probe_cpa_auth(path, proxy=proxy)
    r["deleted"] = False
    r["recovered_403"] = False  # 兼容：401/403 恢复成功链路均置 True
    r["recovered_auth"] = False
    r["recover_http"] = 0

    do_recover = (
        recover_on_auth_error if recover_on_auth_error is not None else recover_on_403
    )
    http_status = int(r.get("http_status") or 0)
    # 401/403：账号密码重登恢复（不立刻删文件）
    if (
        do_recover
        and r.get("action") == "dead"
        and http_status in RECOVER_HTTP_STATUSES
        and str(email or "").strip()
        and str(password or "").strip()
    ):
        try:
            from password_login import recover_auth_on_dead

            rec = recover_auth_on_dead(
                str(path),
                str(email).strip(),
                str(password).strip(),
                proxy=proxy,
                trigger_http=http_status,
            )
            r["recover"] = {
                "ok": bool(rec.get("ok")),
                "login": rec.get("login"),
                "mint": rec.get("mint"),
                "message": rec.get("message"),
                "error": rec.get("error"),
                "trigger_http": http_status,
            }
            r["recovered_403"] = True
            r["recovered_auth"] = True
            r["recover_http"] = http_status
            # 用二次测活结果覆盖
            second = rec.get("second_probe") if isinstance(rec.get("second_probe"), dict) else rec
            if isinstance(second, dict) and second.get("action"):
                r["action"] = second.get("action")
                r["ok"] = second.get("action") == "ok"
                r["alive"] = second.get("action") == "ok"
                r["http_status"] = second.get("http_status") or r.get("http_status")
                r["summary"] = second.get("summary") or r.get("summary")
                if second.get("error"):
                    r["error"] = second.get("error")
                elif rec.get("ok"):
                    r.pop("error", None)
            elif rec.get("ok"):
                r["action"] = "ok"
                r["ok"] = True
                r["alive"] = True
            if rec.get("email"):
                r["email"] = rec.get("email")
        except Exception as e:
            r["recover_error"] = str(e)[:300]

    if r.get("action") == "dead" and delete_on_dead and path.is_file():
        try:
            path.unlink()
            r["deleted"] = True
        except Exception as e:
            r["delete_error"] = str(e)
    # 未删除时持久化测活结果，供下次列表展示
    if not r.get("deleted") and path.is_file():
        persist_probe_result(path, r)
    return r
