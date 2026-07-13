"""SSO → CPA auth 文件 + refresh 重签。

默认写出目录：DATA_DIR/auth 或 config cpa_auth_dir，默认 /data/auth。
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional

from cpa_schema import (
    DEFAULT_BASE_URL,
    DEFAULT_CLIENT_HEADERS,
    DEFAULT_TOKEN_ENDPOINT,
    build_cpa_xai_auth,
    credential_file_name,
    random_client_headers,
)
from sso_to_auth import (
    access_token_referrer,
    sso_to_token,
    token_to_cpa_record,
    write_cpa_auth,
)
from cpa_probe import probe_and_cleanup

LogFn = Callable[[str], None]


def _noop(msg: str) -> None:
    return None


def _normalize_grok_pager_headers(headers: dict | None) -> dict[str, str]:
    """将旧 grok-shell 头升级为 grok-pager，保留 x-grok-agent-id。

    对齐 cred2cpa：免费 Build 必须以 grok-pager 身份访问 cli-chat-proxy。
    """
    base = dict(DEFAULT_CLIENT_HEADERS)
    if not isinstance(headers, dict):
        return base
    # 保留已有 agent-id / 平台相关 UA 仅当已是 pager；否则用默认 pager 头
    agent = str(headers.get("x-grok-agent-id") or headers.get("X-Grok-Agent-Id") or "").strip()
    ua = str(headers.get("User-Agent") or headers.get("user-agent") or "")
    ident = str(
        headers.get("x-grok-client-identifier")
        or headers.get("X-Grok-Client-Identifier")
        or ""
    ).strip()
    if ident == "grok-pager" or "grok-pager/" in ua:
        # 已是 pager：保留完整自定义（含随机平台 UA + agent-id）
        out = {str(k): str(v) for k, v in headers.items() if v is not None}
        # 确保关键身份字段存在
        for k, v in DEFAULT_CLIENT_HEADERS.items():
            out.setdefault(k, v)
        if agent:
            out["x-grok-agent-id"] = agent
        return out
    # 旧 shell 或其它：升级为 pager 默认，仅保留 agent-id
    if agent:
        base["x-grok-agent-id"] = agent
    return base


def default_auth_dir() -> Path:
    env = (os.environ.get("AUTH_DIR") or os.environ.get("CPA_AUTH_DIR") or "").strip()
    if env:
        return Path(env).expanduser().resolve()
    # config.json
    conf_path = Path(__file__).resolve().parent / "config.json"
    try:
        conf = json.loads(conf_path.read_text(encoding="utf-8"))
        d = str(conf.get("cpa_auth_dir") or conf.get("auth_dir") or "").strip()
        if d:
            return Path(d).expanduser().resolve()
    except Exception:
        pass
    data = (os.environ.get("DATA_DIR") or "").strip()
    if data:
        return Path(data).expanduser().resolve() / "auth"
    return Path("/data/auth")


def sso_to_cpa_auth(
    *,
    sso: str,
    email: str = "",
    proxy: str = "",
    auth_dir: str | Path | None = None,
    random_fingerprint: bool = True,
    log: LogFn | None = None,
) -> dict[str, Any]:
    """SSO cookie → device-flow → data/auth/xai-<email>.json"""
    log = log or _noop
    sso = (sso or "").strip()
    if not sso:
        return {"ok": False, "error": "empty sso"}
    out_dir = Path(auth_dir) if auth_dir else default_auth_dir()
    log(f"[auth] SSO→CPA mint email={email or '-'} dir={out_dir}")
    token = sso_to_token(sso, proxy=proxy or "", log=log)
    if not token:
        return {"ok": False, "error": "sso_to_token failed", "email": email}

    headers = random_client_headers(email or sso[:16]) if random_fingerprint else None
    # 用 schema 构建（含随机 fingerprint headers）
    try:
        payload = build_cpa_xai_auth(
            email=email,
            access_token=token.get("access_token") or "",
            refresh_token=token.get("refresh_token") or "",
            id_token=token.get("id_token"),
            expires_in=token.get("expires_in"),
            base_url=DEFAULT_BASE_URL,
            headers=headers,
        )
        # 兼容 token_to_cpa_record 字段
        if not payload.get("email") and email:
            payload["email"] = email
    except Exception:
        payload = token_to_cpa_record(token, email=email)
        if headers:
            payload["headers"] = headers

    path = write_cpa_auth(out_dir, payload)
    log(f"[auth] wrote {path}")

    # mint 后 cehuo 风格 /responses 测活；401/402/403 删文件
    probe = probe_and_cleanup(path, proxy=proxy or "", delete_on_dead=True)
    log(
        f"[auth] probe action={probe.get('action')} http={probe.get('http_status')} "
        f"deleted={probe.get('deleted')} {probe.get('summary') or probe.get('error') or ''}"
    )
    if probe.get("action") == "dead":
        return {
            "ok": False,
            "error": f"cpa probe dead HTTP {probe.get('http_status')}",
            "email": payload.get("email") or email,
            "path": str(path),
            "filename": path.name,
            "probe": probe,
            "deleted": bool(probe.get("deleted")),
        }
    if probe.get("action") == "error":
        # 网络错误保留文件，但标记 probe 失败（不强制 ok=false，避免误删）
        return {
            "ok": True,
            "email": payload.get("email") or email,
            "path": str(path),
            "filename": path.name,
            "sub": payload.get("sub") or "",
            "agent_id": (headers or {}).get("x-grok-agent-id", ""),
            "probe": probe,
            "probe_warn": probe.get("error") or "probe error",
        }

    return {
        "ok": True,
        "email": payload.get("email") or email,
        "path": str(path),
        "filename": path.name,
        "sub": payload.get("sub") or "",
        "agent_id": (headers or {}).get("x-grok-agent-id", ""),
        "probe": probe,
    }


def refresh_access_token(
    refresh_token: str,
    *,
    proxy: str = "",
    timeout: float = 30.0,
) -> dict[str, Any] | None:
    """用 refresh_token 换新 access/refresh（CPA 重签）。

    对齐 cred2cpa / 7sso2auth：refresh 请求必须带 grok-pager 身份头，
    服务端才会把 referrer=grok-build 签进新的 access_token，
    cli-chat-proxy.grok.com 才接受（旧 UA / 无 referrer 会 403）。
    """
    refresh_token = (refresh_token or "").strip()
    if not refresh_token:
        return None
    form = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": "b1a00492-073a-47ea-816f-4c329264a828",
    }
    data = urllib.parse.urlencode(form).encode("utf-8")
    req = urllib.request.Request(
        DEFAULT_TOKEN_ENDPOINT,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            **DEFAULT_CLIENT_HEADERS,
        },
    )
    handlers = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    opener = urllib.request.build_opener(*handlers) if handlers else urllib.request.build_opener()
    try:
        with opener.open(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return json.loads(body)
    except urllib.error.HTTPError as e:
        try:
            err_body = e.read().decode("utf-8", errors="replace")
        except Exception:
            err_body = str(e)
        return {"error": f"HTTP {e.code}", "detail": err_body[:300]}
    except Exception as e:
        return {"error": str(e)}


def resign_auth_file(
    path: str | Path,
    *,
    sso: str = "",
    proxy: str = "",
    log: LogFn | None = None,
) -> dict[str, Any]:
    """重签单个 auth JSON：优先 refresh_token；失败则用 sso 重 mint。"""
    log = log or _noop
    p = Path(path).expanduser().resolve()
    if not p.is_file():
        return {"ok": False, "error": f"file not found: {p}"}
    try:
        payload = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        return {"ok": False, "error": f"read failed: {e}"}

    email = str(payload.get("email") or "").strip()
    refresh = str(payload.get("refresh_token") or "").strip()
    raw_headers = payload.get("headers") if isinstance(payload.get("headers"), dict) else None
    # 重签时统一升级为 grok-pager（旧 grok-shell 文件也会修好）
    headers = _normalize_grok_pager_headers(raw_headers)

    # 1) refresh
    if refresh:
        log(f"[auth] resign via refresh: {p.name}")
        token = refresh_access_token(refresh, proxy=proxy)
        if token and token.get("access_token"):
            new_refresh = token.get("refresh_token") or refresh
            # 部分实现不回传新 refresh_token，沿用旧的（对齐 7sso2auth）
            try:
                new_payload = build_cpa_xai_auth(
                    email=email,
                    access_token=token["access_token"],
                    refresh_token=new_refresh,
                    id_token=token.get("id_token") or payload.get("id_token"),
                    expires_in=token.get("expires_in"),
                    base_url=str(payload.get("base_url") or DEFAULT_BASE_URL),
                    headers=headers,
                    sub=str(payload.get("sub") or "") or None,
                )
            except Exception as e:
                return {"ok": False, "error": f"build payload failed: {e}", "email": email}
            # 原地原子写
            tmp = p.with_suffix(p.suffix + ".tmp")
            tmp.write_text(json.dumps(new_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.replace(tmp, p)
            log(f"[auth] resign wrote (refresh) → {p}")
            ref = access_token_referrer(str(token.get("access_token") or ""))
            if ref:
                log(f"[auth] resign access_token referrer={ref}")
            else:
                log("[auth] ⚠ resign 后 access_token 无 referrer claim（cli-chat-proxy 可能 403）")
            # refresh 成功后 cehuo 风格测活；dead 删文件并 ok=false
            probe = probe_and_cleanup(p, proxy=proxy or "", delete_on_dead=True)
            log(
                f"[auth] resign probe action={probe.get('action')} http={probe.get('http_status')} "
                f"deleted={probe.get('deleted')} {probe.get('summary') or probe.get('error') or ''}"
            )
            if probe.get("action") == "dead":
                return {
                    "ok": False,
                    "mode": "refresh",
                    "error": f"cpa probe dead HTTP {probe.get('http_status')}",
                    "path": str(p),
                    "email": email,
                    "filename": p.name,
                    "probe": probe,
                    "deleted": bool(probe.get("deleted")),
                    "referrer": ref,
                }
            out: dict[str, Any] = {
                "ok": True,
                "mode": "refresh",
                "path": str(p),
                "email": email,
                "filename": p.name,
                "probe": probe,
                "deleted": bool(probe.get("deleted")),
                "referrer": ref,
            }
            if not ref:
                out["referrer_warn"] = "missing referrer claim"
            return out
        log(f"[auth] refresh failed: {token}")

    # 2) sso re-mint
    sso_v = (sso or str(payload.get("sso") or "")).strip()
    if sso_v:
        log(f"[auth] resign via sso: {p.name}")
        r = sso_to_cpa_auth(
            sso=sso_v,
            email=email,
            proxy=proxy,
            auth_dir=p.parent,
            random_fingerprint=bool(raw_headers is None),
            log=log,
        )
        if r.get("ok"):
            r["mode"] = "sso"
            return r
        out = {
            "ok": False,
            "error": r.get("error") or "sso resign failed",
            "email": email,
            "mode": "sso",
        }
        if r.get("probe") is not None:
            out["probe"] = r.get("probe")
        if "deleted" in r:
            out["deleted"] = r.get("deleted")
        if r.get("path"):
            out["path"] = r.get("path")
        if r.get("filename"):
            out["filename"] = r.get("filename")
        return out

    return {
        "ok": False,
        "error": "no refresh_token and no sso for resign",
        "email": email,
        "path": str(p),
    }


def list_auth_files(auth_dir: str | Path | None = None) -> list[dict[str, Any]]:
    d = Path(auth_dir) if auth_dir else default_auth_dir()
    if not d.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for f in sorted(d.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            data = {}
        out.append(
            {
                "filename": f.name,
                "path": str(f),
                "email": data.get("email") or "",
                "sub": data.get("sub") or "",
                "expired": data.get("expired") or "",
                "disabled": bool(data.get("disabled")),
                "has_refresh": bool(data.get("refresh_token")),
                "mtime": f.stat().st_mtime,
            }
        )
    return out
