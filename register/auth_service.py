"""SSO → CPA auth 文件 + refresh 重签 + 可选远程 Management API 推送。

默认写出目录：DATA_DIR/auth 或 config cpa_auth_dir，默认 /data/auth。

对齐 grokRegister-cpa-main：
- 换 token 走 Authorization Code + PKCE（referrer=grok-build）
- 扁平 xai-*.json + cli-chat-proxy + grok-pager headers（含 x-authenticateresponse）
- 最新 CPA 关闭「使用官方 API（using_api）」即可用，无需手改 headers
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

from cpa_schema import (
    DEFAULT_BASE_URL,
    DEFAULT_CLIENT_HEADERS,
    DEFAULT_TOKEN_ENDPOINT,
    build_cpa_xai_auth,
    random_client_headers,
)
from sso_to_auth import (
    access_token_referrer,
    sso_to_token,
    token_to_cpa_record,
    upload_cpa_auth_remote,
    write_cpa_auth,
)
from cpa_probe import probe_and_cleanup

LogFn = Callable[[str], None]


def _noop(msg: str) -> None:
    return None


def _normalize_grok_pager_headers(headers: dict | None) -> dict[str, str]:
    """将旧 grok-shell 头升级为 grok-pager，保留 x-grok-agent-id。

    对齐 grokRegister-cpa-main：必须含 x-authenticateresponse。
    """
    base = dict(DEFAULT_CLIENT_HEADERS)
    if not isinstance(headers, dict):
        return base
    agent = str(headers.get("x-grok-agent-id") or headers.get("X-Grok-Agent-Id") or "").strip()
    ua = str(headers.get("User-Agent") or headers.get("user-agent") or "")
    ident = str(
        headers.get("x-grok-client-identifier")
        or headers.get("X-Grok-Client-Identifier")
        or ""
    ).strip()
    if ident == "grok-pager" or "grok-pager/" in ua:
        out = {str(k): str(v) for k, v in headers.items() if v is not None}
        for k, v in DEFAULT_CLIENT_HEADERS.items():
            out.setdefault(k, v)
        if agent:
            out["x-grok-agent-id"] = agent
        return out
    if agent:
        base["x-grok-agent-id"] = agent
    return base


def default_auth_dir() -> Path:
    env = (os.environ.get("AUTH_DIR") or os.environ.get("CPA_AUTH_DIR") or "").strip()
    if env:
        return Path(env).expanduser().resolve()
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


def _read_cpa_remote_config() -> tuple[str, str]:
    """从环境变量 / config.json 读取远程 CPA 推送配置。"""
    url = (
        os.environ.get("CPA_REMOTE_URL")
        or os.environ.get("cpa_remote_url")
        or ""
    ).strip()
    key = (
        os.environ.get("CPA_MANAGEMENT_KEY")
        or os.environ.get("cpa_management_key")
        or ""
    ).strip()
    conf_path = Path(__file__).resolve().parent / "config.json"
    try:
        conf = json.loads(conf_path.read_text(encoding="utf-8"))
        if not url:
            url = str(conf.get("cpa_remote_url") or "").strip()
        if not key:
            key = str(conf.get("cpa_management_key") or "").strip()
    except Exception:
        pass
    return url, key


def _normalize_sso_token(sso: str) -> str:
    """strip 空白与可选 sso= 前缀，便于号池 SHA-256 与文件字段一致。"""
    return str(sso or "").strip().removeprefix("sso=").removeprefix("SSO=").strip()


def _ensure_payload_sso(payload: dict[str, Any], sso: str) -> dict[str, Any]:
    """强制顶层写入 sso（覆盖 extra 仅嵌套、或 build 时丢字段的情况）。

    号池「已转 Auth」在无邮箱时依赖 auth 文件内 sso 做 SHA-256 交叉匹配。
    """
    if not isinstance(payload, dict):
        return payload
    token = _normalize_sso_token(sso)
    if not token:
        # 仍尝试从已有字段/嵌套 extra 提升到顶层
        existing = payload.get("sso")
        if isinstance(existing, str) and existing.strip():
            payload["sso"] = _normalize_sso_token(existing)
            return payload
        extra = payload.get("extra")
        if isinstance(extra, dict):
            nested = extra.get("sso")
            if isinstance(nested, str) and nested.strip():
                payload["sso"] = _normalize_sso_token(nested)
        return payload
    payload["sso"] = token
    return payload


def sso_to_cpa_auth(
    *,
    sso: str,
    email: str = "",
    proxy: str = "",
    auth_dir: str | Path | None = None,
    random_fingerprint: bool = True,
    remote_url: str = "",
    management_key: str = "",
    skip_remote: bool = False,
    delete_on_dead: bool = True,
    log: LogFn | None = None,
) -> dict[str, Any]:
    """SSO cookie → Auth Code+PKCE → data/auth/xai-<email>.json [+ 远程推送]

    产出文件可在最新 CPA 中手动登录使用：关闭认证文件设置中的
    「使用官方 API（using_api）」即可，无需手改 headers。

    delete_on_dead: mint 后 probe 为 401/402/403 时是否删除本地文件（默认 True）。
    """
    log = log or _noop
    sso = (sso or "").strip()
    if not sso:
        return {"ok": False, "error": "empty sso"}
    out_dir = Path(auth_dir) if auth_dir else default_auth_dir()
    log(f"[auth] SSO→CPA mint (Auth Code+PKCE) email={email or '-'} dir={out_dir}")
    token = sso_to_token(sso, proxy=proxy or "", log=log)
    if not token:
        return {"ok": False, "error": "sso_to_token failed", "email": email}

    ref = access_token_referrer(token.get("access_token") or "")
    if ref:
        log(f"[auth] access_token referrer={ref}")
    else:
        log("[auth] ⚠ access_token 无 referrer claim（cli-chat-proxy 可能 403）")

    headers = random_client_headers(email or sso[:16]) if random_fingerprint else None
    try:
        payload = build_cpa_xai_auth(
            email=email,
            access_token=token.get("access_token") or "",
            refresh_token=token.get("refresh_token") or "",
            id_token=token.get("id_token"),
            expires_in=token.get("expires_in"),
            base_url=DEFAULT_BASE_URL,
            headers=headers,
            extra={"sso": sso} if sso else None,
        )
        if not payload.get("email") and email:
            payload["email"] = email
    except Exception:
        payload = token_to_cpa_record(token, email=email, headers=headers, sso=sso)
        if headers:
            payload["headers"] = headers

    # 强制顶层写入 sso（号池无邮箱时靠 SSO SHA-256 匹配「已转 Auth」）
    payload = _ensure_payload_sso(payload, sso)

    path = write_cpa_auth(out_dir, payload)
    log(f"[auth] wrote {path}")

    remote_result: dict[str, Any] | None = None
    if not skip_remote:
        r_url = (remote_url or "").strip()
        r_key = (management_key or "").strip()
        if not r_url or not r_key:
            cfg_url, cfg_key = _read_cpa_remote_config()
            r_url = r_url or cfg_url
            r_key = r_key or cfg_key
        if r_url and r_key:
            try:
                name = upload_cpa_auth_remote(r_url, r_key, payload)
                log(f"[auth] CPA 远程推送 OK → {r_url.rstrip('/')}/.../{name}")
                remote_result = {"ok": True, "url": r_url, "name": name}
            except Exception as e:
                log(f"[auth] CPA 远程推送失败: {e}")
                remote_result = {"ok": False, "error": str(e), "url": r_url}
        elif r_url and not r_key:
            log("[auth] 已配置 cpa_remote_url 但无 management_key，跳过远程推送")

    # mint 后 cehuo 风格 /responses 测活；dead 时是否删文件由 delete_on_dead 控制
    probe = probe_and_cleanup(
        path, proxy=proxy or "", delete_on_dead=bool(delete_on_dead)
    )
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
            "referrer": ref,
            "remote": remote_result,
        }
    if probe.get("action") == "error":
        return {
            "ok": True,
            "email": payload.get("email") or email,
            "path": str(path),
            "filename": path.name,
            "sub": payload.get("sub") or "",
            "agent_id": (headers or {}).get("x-grok-agent-id", ""),
            "probe": probe,
            "probe_warn": probe.get("error") or "probe error",
            "referrer": ref,
            "remote": remote_result,
        }

    return {
        "ok": True,
        "email": payload.get("email") or email,
        "path": str(path),
        "filename": path.name,
        "sub": payload.get("sub") or "",
        "agent_id": (headers or {}).get("x-grok-agent-id", ""),
        "probe": probe,
        "referrer": ref,
        "remote": remote_result,
    }


def refresh_access_token(
    refresh_token: str,
    *,
    proxy: str = "",
    timeout: float = 30.0,
) -> dict[str, Any] | None:
    """用 refresh_token 换新 access/refresh（CPA 重签）。

    对齐 grok-pager 身份头；refresh 后应仍带 referrer=grok-build（若 mint 时正确）。
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


def _try_push_remote(
    payload: dict[str, Any],
    *,
    log: LogFn,
    remote_url: str = "",
    management_key: str = "",
) -> dict[str, Any] | None:
    """可选远程推送；未配置则返回 None。"""
    r_url = (remote_url or "").strip()
    r_key = (management_key or "").strip()
    if not r_url or not r_key:
        cfg_url, cfg_key = _read_cpa_remote_config()
        r_url = r_url or cfg_url
        r_key = r_key or cfg_key
    if not r_url or not r_key:
        if r_url and not r_key:
            log("[auth] 已配置 cpa_remote_url 但无 management_key，跳过远程推送")
        return None
    try:
        name = upload_cpa_auth_remote(r_url, r_key, payload)
        log(f"[auth] CPA 远程推送 OK → {r_url.rstrip('/')}/.../{name}")
        return {"ok": True, "url": r_url, "name": name}
    except Exception as e:
        log(f"[auth] CPA 远程推送失败: {e}")
        return {"ok": False, "error": str(e), "url": r_url}


def resign_auth_file(
    path: str | Path,
    *,
    sso: str = "",
    proxy: str = "",
    push_remote: bool = False,
    log: LogFn | None = None,
) -> dict[str, Any]:
    """重签单个 auth JSON：优先 refresh_token；失败则用 sso 重 mint。

    push_remote=True 时，成功后按 config/环境推送 Management API（默认 False）。
    """
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
    headers = _normalize_grok_pager_headers(raw_headers)

    # 1) refresh
    if refresh:
        log(f"[auth] resign via refresh: {p.name}")
        token = refresh_access_token(refresh, proxy=proxy)
        if token and token.get("access_token"):
            new_refresh = token.get("refresh_token") or refresh
            # 优先入参 sso，其次文件内已有 sso
            sso_keep = (sso or str(payload.get("sso") or "")).strip()
            try:
                extra = {"sso": sso_keep} if sso_keep else None
                new_payload = build_cpa_xai_auth(
                    email=email,
                    access_token=token["access_token"],
                    refresh_token=new_refresh,
                    id_token=token.get("id_token") or payload.get("id_token"),
                    expires_in=token.get("expires_in"),
                    base_url=str(payload.get("base_url") or DEFAULT_BASE_URL),
                    headers=headers,
                    sub=str(payload.get("sub") or "") or None,
                    extra=extra,
                )
            except Exception as e:
                return {"ok": False, "error": f"build payload failed: {e}", "email": email}
            new_payload = _ensure_payload_sso(new_payload, sso_keep)
            tmp = p.with_suffix(p.suffix + ".tmp")
            tmp.write_text(json.dumps(new_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.replace(tmp, p)
            log(f"[auth] resign wrote (refresh) → {p}")
            ref = access_token_referrer(str(token.get("access_token") or ""))
            if ref:
                log(f"[auth] resign access_token referrer={ref}")
            else:
                log("[auth] ⚠ resign 后 access_token 无 referrer claim（cli-chat-proxy 可能 403）")
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
            if push_remote:
                out["remote"] = _try_push_remote(new_payload, log=log)
            return out
        log(f"[auth] refresh failed: {token}")

    # 2) sso re-mint
    sso_v = (sso or str(payload.get("sso") or "")).strip()
    if sso_v:
        log(f"[auth] resign via sso (Auth Code+PKCE): {p.name}")
        r = sso_to_cpa_auth(
            sso=sso_v,
            email=email,
            proxy=proxy,
            auth_dir=p.parent,
            random_fingerprint=bool(raw_headers is None),
            # 默认不推；push_remote=True 时与 mint 一致走远程
            skip_remote=not push_remote,
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
        if r.get("remote") is not None:
            out["remote"] = r.get("remote")
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
