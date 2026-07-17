# -*- coding: utf-8 -*-
"""Auth → sub2api 远程推送：CPA xai JSON 先转官方格式再 POST Admin API。

对齐 Wei-Shaw/sub2api Admin 鉴权（admin_auth.go）：
  1) Admin API Key → header  x-api-key: <admin-...>
  2) 管理员 JWT    → header  Authorization: Bearer <jwt>
  POST {base}/api/v1/admin/accounts
  body: CreateAccountRequest (platform=grok, type=oauth, credentials, …)

配置键（register/config.json）：
  push_auth_to_sub2api / allow_push_auth_to_sub2api
  sub2api_remote_url / sub2api_admin_token
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional

LogFn = Callable[[str], None]

_ROOT = Path(__file__).resolve().parent


def _load_conf() -> dict[str, Any]:
    p = _ROOT / "config.json"
    if not p.is_file():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8-sig"))
    except Exception:
        return {}


def _truthy(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if v is None:
        return False
    s = str(v).strip().lower()
    return s in ("1", "true", "yes", "on")


def _normalize_admin_secret(raw: str) -> str:
    """Strip whitespace and accidental 'Bearer ' prefix from pasted secrets."""
    s = (raw or "").strip()
    if len(s) >= 7 and s[:7].lower() == "bearer ":
        s = s[7:].strip()
    return s


def _normalize_sub2api_base_url(raw: str) -> str:
    """服务根地址：去尾斜杠，剥掉误粘贴的 /api/v1 等路径（避免双写）。"""
    base = (raw or "").strip().rstrip("/")
    if not base:
        return ""
    for suffix in (
        "/api/v1/admin/accounts",
        "/api/v1/admin",
        "/api/v1",
        "/api",
    ):
        if base.lower().endswith(suffix):
            base = base[: -len(suffix)].rstrip("/")
    return base


def _looks_like_jwt(secret: str) -> bool:
    """JWT = three base64url segments separated by dots."""
    parts = secret.split(".")
    return len(parts) == 3 and all(parts)


def auth_headers_for_sub2api(token: str) -> dict[str, str]:
    """Build Admin API headers.

    - admin-... / non-JWT secrets → x-api-key (Admin API Key)
    - three-segment JWT         → Authorization: Bearer ...
    """
    tok = _normalize_admin_secret(token)
    headers: dict[str, str] = {"Accept": "application/json"}
    if not tok:
        return headers
    if _looks_like_jwt(tok):
        headers["Authorization"] = f"Bearer {tok}"
    else:
        headers["x-api-key"] = tok
    return headers


def read_sub2api_remote_config(
    config: dict[str, Any] | None = None,
) -> tuple[str, str]:
    """Return (base_url, admin_token). Env overrides config."""
    cfg = config if config is not None else _load_conf()
    url = _normalize_sub2api_base_url(
        os.environ.get("SUB2API_REMOTE_URL")
        or os.environ.get("sub2api_remote_url")
        or str(cfg.get("sub2api_remote_url") or cfg.get("sub2apiRemoteUrl") or "")
    )
    token = _normalize_admin_secret(
        os.environ.get("SUB2API_ADMIN_TOKEN")
        or os.environ.get("sub2api_admin_token")
        or str(cfg.get("sub2api_admin_token") or cfg.get("sub2apiAdminToken") or "")
    )
    return url, token


def is_auto_push_enabled(config: dict[str, Any] | None = None) -> bool:
    cfg = config if config is not None else _load_conf()
    v = cfg.get("push_auth_to_sub2api")
    if v is None:
        v = cfg.get("pushAuthToSub2api")
    if v is None:
        v = cfg.get("autoPushAuthToSub2api")
    return _truthy(v)


def is_allow_push_enabled(config: dict[str, Any] | None = None) -> bool:
    cfg = config if config is not None else _load_conf()
    if is_auto_push_enabled(cfg):
        return True
    v = cfg.get("allow_push_auth_to_sub2api")
    if v is None:
        v = cfg.get("allowPushAuthToSub2api")
    if v is None:
        v = cfg.get("pushAuthToSub2api")
    return _truthy(v)


def _http_json(
    method: str,
    url: str,
    *,
    token: str,
    body: Any | None = None,
    timeout: float = 30.0,
) -> tuple[int, Any]:
    data = None
    headers = auth_headers_for_sub2api(token)
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            status = int(getattr(resp, "status", 200) or 200)
            try:
                return status, json.loads(raw) if raw.strip() else {}
            except Exception:
                return status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace") if e.fp else ""
        try:
            parsed: Any = json.loads(raw) if raw.strip() else raw
        except Exception:
            parsed = raw
        return int(e.code), parsed
    except Exception as e:
        return 0, str(e)


def cpa_path_to_create_body(cpa_path: str | Path) -> dict[str, Any]:
    """CPA xai file → CreateAccountRequest body for sub2api."""
    from cpa_to_sub2api import cpa_xai_to_sub2api_account

    path = Path(cpa_path).expanduser().resolve()
    cpa = json.loads(path.read_text(encoding="utf-8-sig"))
    acc = cpa_xai_to_sub2api_account(cpa, source="cpa_xai")
    # CreateAccountRequest 不含文档头；DataAccount 字段可直接用
    body: dict[str, Any] = {
        "name": acc["name"],
        "platform": acc["platform"],
        "type": acc["type"],
        "credentials": acc["credentials"],
        "concurrency": int(acc.get("concurrency") or 1),
        "priority": int(acc.get("priority") or 0),
    }
    if acc.get("extra"):
        body["extra"] = acc["extra"]
    if acc.get("expires_at") is not None:
        body["expires_at"] = acc["expires_at"]
    if acc.get("auto_pause_on_expired") is not None:
        body["auto_pause_on_expired"] = acc["auto_pause_on_expired"]
    return body


def push_account_body(
    body: dict[str, Any],
    *,
    base_url: str,
    token: str,
    timeout: float = 30.0,
) -> dict[str, Any]:
    base = _normalize_sub2api_base_url(base_url or "")
    if not base:
        return {"ok": False, "error": "missing sub2api_remote_url"}
    if not (token or "").strip():
        return {"ok": False, "error": "missing sub2api_admin_token"}
    url = f"{base}/api/v1/admin/accounts"
    status, resp = _http_json("POST", url, token=token.strip(), body=body, timeout=timeout)
    if 200 <= status < 300:
        # 官方信封 {code:0, data}；code!=0 视为失败
        if isinstance(resp, dict) and "code" in resp and resp.get("code") not in (0, "0", None):
            err = str(resp.get("message") or resp.get("error") or resp)[:400]
            return {
                "ok": False,
                "status": status,
                "error": f"code={resp.get('code')}: {err}",
                "url": url,
            }
        return {"ok": True, "status": status, "data": resp, "url": url}
    err = ""
    if isinstance(resp, dict):
        err = str(resp.get("error") or resp.get("message") or resp)[:400]
    else:
        err = str(resp)[:400]
    return {"ok": False, "status": status, "error": err or f"HTTP {status}", "url": url}


def push_cpa_file(
    cpa_path: str | Path,
    *,
    base_url: str = "",
    token: str = "",
    config: dict[str, Any] | None = None,
    log: Optional[LogFn] = None,
) -> dict[str, Any]:
    """Convert one CPA auth file and POST to sub2api."""
    log = log or (lambda m: None)
    cfg = config if config is not None else _load_conf()
    url, tok = read_sub2api_remote_config(cfg)
    if base_url:
        url = _normalize_sub2api_base_url(base_url)
    if token:
        tok = _normalize_admin_secret(token)
    try:
        body = cpa_path_to_create_body(cpa_path)
    except Exception as e:
        return {"ok": False, "error": f"convert fail: {e}", "path": str(cpa_path)}
    r = push_account_body(body, base_url=url, token=tok)
    r["path"] = str(cpa_path)
    r["name"] = body.get("name")
    if r.get("ok"):
        log(f"[sub2api] push OK name={body.get('name')} -> {url}")
    else:
        log(f"[sub2api] push FAIL name={body.get('name')}: {r.get('error')}")
    return r


def push_after_cpa_result(
    result: dict[str, Any],
    *,
    config: dict[str, Any] | None = None,
    log: Optional[LogFn] = None,
) -> dict[str, Any]:
    """mint 成功后可选远程推送。受 push_auth_to_sub2api 控制。"""
    cfg = config if config is not None else _load_conf()
    log = log or (lambda m: None)
    if not is_auto_push_enabled(cfg):
        return {"ok": False, "skipped": True, "reason": "disabled"}
    url, tok = read_sub2api_remote_config(cfg)
    if not url or not tok:
        log("[sub2api] 已开自动推送但未配置 sub2api_remote_url / admin_token")
        return {"ok": False, "skipped": True, "reason": "missing url/token"}

    paths: list[str] = []
    if result.get("path"):
        paths.append(str(result["path"]))
    for p in result.get("paths") or []:
        if p and str(p) not in paths:
            paths.append(str(p))
    if not paths:
        return {"ok": False, "error": "missing cpa path"}

    ok_n = 0
    fail_n = 0
    results: list[dict[str, Any]] = []
    for cp in paths:
        r = push_cpa_file(cp, base_url=url, token=tok, config=cfg, log=log)
        results.append(r)
        if r.get("ok"):
            ok_n += 1
        else:
            fail_n += 1
    return {
        "ok": ok_n > 0 and fail_n == 0,
        "ok_count": ok_n,
        "failed": fail_n,
        "results": results,
    }


def test_connectivity(
    *,
    base_url: str = "",
    token: str = "",
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """GET /api/v1/admin/accounts?page=1&page_size=1 — 鉴权探活。"""
    cfg = config if config is not None else _load_conf()
    url, tok = read_sub2api_remote_config(cfg)
    if base_url:
        url = _normalize_sub2api_base_url(base_url)
    if token:
        tok = _normalize_admin_secret(token)
    if not url:
        return {"ok": False, "error": "missing url"}
    if not tok:
        return {"ok": False, "error": "missing token"}
    probe = f"{url}/api/v1/admin/accounts?page=1&page_size=1"
    status, resp = _http_json("GET", probe, token=tok, timeout=12.0)
    if 200 <= status < 300:
        if isinstance(resp, dict) and "code" in resp and resp.get("code") not in (0, "0", None):
            return {
                "ok": False,
                "status": status,
                "error": f"业务 code={resp.get('code')}: {resp.get('message') or resp.get('error') or ''}",
                "url": url,
            }
        return {"ok": True, "status": status, "url": url}
    if status in (401, 403):
        method = "jwt" if _looks_like_jwt(tok) else "x-api-key"
        return {
            "ok": False,
            "status": status,
            "error": (
                f"鉴权失败 HTTP {status}（以 {method} 发送）。"
                " 推荐 Admin API Key（admin-...）；JWT 须为管理员且未过期。"
            ),
            "url": url,
        }
    err = ""
    if isinstance(resp, dict):
        err = str(resp.get("error") or resp.get("message") or resp)[:200]
    else:
        err = str(resp)[:200]
    return {
        "ok": False,
        "status": status,
        "error": err or f"HTTP {status}",
        "url": url,
    }
