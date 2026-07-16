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
import time
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
from cpa_probe import probe_and_cleanup, probe_models, probe_mini_response

LogFn = Callable[[str], None]


def _noop(msg: str) -> None:
    return None


def _read_cpa_mint_mode() -> str:
    """从环境 / config.json 读 cpa_mint_mode：pkce|device|double。"""
    env = (
        os.environ.get("CPA_MINT_MODE")
        or os.environ.get("cpa_mint_mode")
        or ""
    ).strip().lower()
    if env in ("pkce", "a", "auth_code"):
        return "pkce"
    if env in ("device", "b", "device_flow"):
        return "device"
    if env in ("double", "auto", "c", "merged", "both", "pkce_then_device"):
        return "double"
    conf_path = Path(__file__).resolve().parent / "config.json"
    try:
        conf = json.loads(conf_path.read_text(encoding="utf-8"))
        m = str(conf.get("cpa_mint_mode") or conf.get("mint_mode") or "").strip().lower()
        if m in ("pkce", "a", "auth_code"):
            return "pkce"
        if m in ("device", "b", "device_flow"):
            return "device"
        if m in ("double", "auto", "c", "merged", "both", "pkce_then_device"):
            return "double"
    except Exception:
        pass
    return "pkce"


def _via_pkce_token(
    sso: str,
    *,
    proxy: str = "",
    log: LogFn | None = None,
    allow_device_fallback: bool = True,
) -> dict[str, Any] | None:
    """PKCE main path; optionally device then short browser Allow.

    allow_device_fallback=False for double-mode *pkce channel* so a device grant
    is never written as xai-*-pkce.json (Auth B / *-device.json would be missing
    while the only file is a mislabeled device token).
    """
    log = log or _noop
    log("[auth] mint channel=pkce (Auth Code+PKCE)…")
    tokens: dict[str, Any] | None = None
    try:
        tokens = sso_to_token(sso, proxy=proxy or "", log=log)
    except Exception as pe:
        log(f"[auth] PKCE exception: {pe}")
        tokens = None
    if tokens and tokens.get("access_token"):
        return tokens

    # 1) device: only when this is a single-channel mint (mode A), not double's pkce slot
    if allow_device_fallback:
        log("[auth] PKCE failed → device flow fallback…")
        try:
            dev = _via_device_token(sso, proxy=proxy or "", log=log)
            if dev and dev.get("access_token"):
                return dev
        except Exception as de:
            log(f"[auth] device fallback err: {de}")
    else:
        log("[auth] PKCE failed (no device fallback; double mode keeps channels pure)")

    # 2) browser Allow: short timeout so mint-queue cannot hang forever
    try:
        from sso_to_auth import sso_to_token_via_browser_consent

        log("[auth] PKCE path → browser consent fallback (timeout=55s, local callback)…")
        tokens = sso_to_token_via_browser_consent(
            sso,
            proxy=proxy or "",
            log=log,
            headless=True,
            timeout=55.0,
        )
        if tokens and tokens.get("access_token"):
            return tokens
    except Exception as be:
        log(f"[auth] browser consent fallback err: {be}")
    return None


def _via_device_token(
    sso: str,
    *,
    proxy: str = "",
    log: LogFn | None = None,
    attempts: int = 1,
) -> dict[str, Any] | None:
    """Device Flow mint. attempts>1 retries transient TLS/OPENSSL curl (35)."""
    log = log or _noop
    try:
        from oauth_device_mint import mint_tokens_device_flow
    except ImportError as e:
        log(f"[auth] oauth_device_mint 不可用: {e}")
        return None
    n = max(1, min(int(attempts or 1), 4))
    last_err = ""
    for ai in range(n):
        log(
            f"[auth] mint channel=device (Device Flow)"
            + (f" attempt={ai + 1}/{n}…" if n > 1 else "…")
        )
        try:
            r = mint_tokens_device_flow(sso, proxy=proxy or "", log=log)
        except Exception as e:
            last_err = str(e)
            log(f"[auth] device mint 异常: {e}")
            r = None
        if r and r.get("ok") and r.get("access_token"):
            return {
                "access_token": r.get("access_token") or "",
                "refresh_token": r.get("refresh_token") or "",
                "id_token": r.get("id_token"),
                "expires_in": r.get("expires_in"),
            }
        last_err = str((r or {}).get("error") or last_err or "unknown")
        log(f"[auth] device mint 失败: {last_err}")
        if ai + 1 < n:
            time.sleep(1.2 * (ai + 1))
    return None


def _mint_tokens(
    sso: str,
    *,
    proxy: str = "",
    mint_mode: str = "",
    log: LogFn | None = None,
) -> tuple[dict[str, Any] | None, str]:
    """按 mint_mode 换 token（单通道）。

    返回 (token_dict|None, mode_used)。
    mode: pkce | device
    double 请走 sso_to_cpa_auth 内双通道分支，不在此合并票。
    """
    log = log or _noop
    mode = (mint_mode or _read_cpa_mint_mode() or "pkce").strip().lower()
    if mode in ("a", "auth_code"):
        mode = "pkce"
    if mode in ("b", "device_flow"):
        mode = "device"
    if mode in ("c", "auto", "merged", "both", "pkce_then_device"):
        mode = "double"

    if mode == "device":
        t = _via_device_token(sso, proxy=proxy, log=log)
        return t, "device"
    if mode == "double":
        # 调用方应走 double 双写；此处兜底只取 pkce
        t = _via_pkce_token(sso, proxy=proxy, log=log)
        return t, "pkce"
    t = _via_pkce_token(sso, proxy=proxy, log=log)
    return t, "pkce"


def _write_and_probe_one(
    *,
    token: dict[str, Any],
    sso: str,
    email: str,
    out_dir: Path,
    channel: str,
    proxy: str,
    random_fingerprint: bool,
    skip_remote: bool,
    remote_url: str,
    management_key: str,
    delete_on_dead: bool,
    log: LogFn,
    require_grok_45: bool = True,
) -> dict[str, Any]:
    """单通道：写 auth + has_grok_45 门禁 + 可选远程 + probe。

    require_grok_45=True（默认）：GET /models 无 grok-4.5 则不推 CPA，ok=False（假活不入池）。
    """
    ref = access_token_referrer(token.get("access_token") or "")
    if ref:
        log(f"[auth] channel={channel} access_token referrer={ref}")
    else:
        log(
            f"[auth] channel={channel} ⚠ access_token 无 referrer claim"
            f"（cli-chat-proxy 可能 403）"
        )

    # 双通道各用独立指纹，避免 agent-id 撞车
    seed = f"{email or sso[:16]}-{channel}"
    headers = random_client_headers(seed) if random_fingerprint else None
    try:
        payload = build_cpa_xai_auth(
            email=email,
            access_token=token.get("access_token") or "",
            refresh_token=token.get("refresh_token") or "",
            id_token=token.get("id_token"),
            expires_in=token.get("expires_in"),
            base_url=DEFAULT_BASE_URL,
            headers=headers,
            extra={
                "sso": sso,
                "mint_channel": channel,
            }
            if sso
            else {"mint_channel": channel},
        )
        if not payload.get("email") and email:
            payload["email"] = email
    except Exception:
        payload = token_to_cpa_record(token, email=email, headers=headers, sso=sso)
        if headers:
            payload["headers"] = headers
    payload = _ensure_payload_sso(payload, sso)
    payload["mint_channel"] = channel
    # 标注双通道互不影响
    payload["mint_note"] = (
        f"channel={channel}; independent OAuth grant; dual mint does not invalidate peer"
    )

    path = write_cpa_auth(out_dir, payload, channel=channel)
    log(f"[auth] wrote {path} channel={channel}")

    # P0：假活门禁 — 无 grok-4.5 不推 CPA
    models_probe = probe_models(
        str(token.get("access_token") or ""),
        base_url=str(payload.get("base_url") or DEFAULT_BASE_URL),
        proxy=proxy or "",
        headers=headers if isinstance(headers, dict) else None,
    )
    has_g45 = bool(models_probe.get("has_grok_45"))
    models_ok = bool(models_probe.get("ok"))
    # 仅当 /models 成功且明确无 grok-4.5 时判假活；网络失败不误杀
    fake_alive = bool(require_grok_45) and models_ok and not has_g45
    payload["has_grok_45"] = has_g45
    payload["model_ids"] = list(models_probe.get("model_ids") or [])
    log(
        f"[auth] channel={channel} models probe ok={models_ok} "
        f"has_grok_45={has_g45} status={models_probe.get('status')} "
        f"ids={models_probe.get('model_ids')}"
    )
    if require_grok_45 and not models_ok:
        log(
            f"[auth] channel={channel} ⚠ models 探针失败，暂不按假活拦截: "
            f"{models_probe.get('error') or models_probe.get('status')}"
        )

    # 10: mini chat 探针（POST /responses）；失败不单独判死，写入结果供观测
    chat_probe: dict[str, Any] | None = None
    if models_ok and has_g45 and not fake_alive:
        try:
            chat_probe = probe_mini_response(
                str(token.get("access_token") or ""),
                base_url=str(payload.get("base_url") or DEFAULT_BASE_URL),
                proxy=proxy or "",
                headers=headers if isinstance(headers, dict) else None,
            )
            payload["chat_probe_ok"] = bool(chat_probe.get("ok"))
            payload["chat_probe_status"] = chat_probe.get("status")
            log(
                f"[auth] channel={channel} chat probe ok={chat_probe.get('ok')} "
                f"status={chat_probe.get('status')} "
                f"text={(chat_probe.get('text') or '')[:40]!r}"
            )
            # 可选硬门槛：config require_chat_probe=true 时 chat 失败也挡 CPA
            require_chat = False
            try:
                conf_path = Path(__file__).resolve().parent / "config.json"
                if conf_path.is_file():
                    conf = json.loads(conf_path.read_text(encoding="utf-8"))
                    require_chat = bool(
                        conf.get("require_chat_probe")
                        or conf.get("requireChatProbe")
                    )
            except Exception:
                require_chat = False
            if require_chat and not chat_probe.get("ok"):
                fake_alive = True
                log(
                    f"[auth] channel={channel} ✘ chat 探针失败且 require_chat_probe=true，"
                    f"按假活处理: {chat_probe.get('error')}"
                )
        except Exception as ce:
            chat_probe = {"ok": False, "error": str(ce)[:200]}
            log(f"[auth] channel={channel} chat probe skip: {ce}")

    # 回写 has_grok_45 / chat 到本地文件
    try:
        if path.is_file():
            doc = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(doc, dict):
                doc["has_grok_45"] = has_g45
                doc["model_ids"] = payload["model_ids"]
                if chat_probe is not None:
                    doc["chat_probe_ok"] = bool(chat_probe.get("ok"))
                    doc["chat_probe_status"] = chat_probe.get("status")
                path.write_text(
                    json.dumps(doc, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
    except Exception:
        pass

    remote_result: dict[str, Any] | None = None
    if fake_alive:
        log(
            f"[auth] channel={channel} ✘ 无 grok-4.5/chat，跳过 CPA 推送（假活 token）"
            f" err={models_probe.get('error') or (chat_probe or {}).get('error') or 'not listed'}"
        )
        remote_result = {
            "ok": False,
            "skipped": True,
            "error": "require_grok_45/chat: fake-alive gate",
            "models": models_probe,
            "chat": chat_probe,
        }
    elif not skip_remote:
        r_url = (remote_url or "").strip()
        r_key = (management_key or "").strip()
        if not r_url or not r_key:
            cfg_url, cfg_key = _read_cpa_remote_config()
            r_url = r_url or cfg_url
            r_key = r_key or cfg_key
        if r_url and r_key:
            try:
                name = upload_cpa_auth_remote(r_url, r_key, payload)
                log(f"[auth] channel={channel} CPA 远程推送 OK → {name}")
                remote_result = {"ok": True, "url": r_url, "name": name}
            except Exception as e:
                log(f"[auth] channel={channel} CPA 远程推送失败: {e}")
                remote_result = {"ok": False, "error": str(e), "url": r_url}

    probe = probe_and_cleanup(
        path,
        proxy=proxy or "",
        delete_on_dead=bool(delete_on_dead),
        mint_soft_retry=True,
    )
    # 假活：默认保留本地文件便于排查；仅 delete_on_dead=True 时删除
    if fake_alive and delete_on_dead and path.is_file():
        try:
            path.unlink(missing_ok=True)
            probe["deleted"] = True
            probe["action"] = "dead"
        except Exception:
            pass
    log(
        f"[auth] channel={channel} probe action={probe.get('action')} "
        f"http={probe.get('http_status')} deleted={probe.get('deleted')} "
        f"{probe.get('summary') or probe.get('error') or ''}"
    )
    alive = probe.get("action") == "ok" or (
        probe.get("action") in ("error", "keep") or probe.get("mint_soft_warn")
    )
    dead = probe.get("action") == "dead"
    still = path.is_file()
    # 明确无 grok-4.5 → ok=False（不进 CPA）；models 网络失败不按假活判死
    ok = bool(still) and not (dead and not still) and not fake_alive
    err = None
    if fake_alive:
        err = "require_grok_45: token ok but grok-4.5 not listed"
    elif dead:
        err = f"cpa probe dead HTTP {probe.get('http_status')}"
    return {
        "ok": ok,
        "channel": channel,
        "email": payload.get("email") or email,
        "path": str(path) if still else "",
        "filename": path.name if still else "",
        "sub": payload.get("sub") or "",
        "agent_id": (headers or {}).get("x-grok-agent-id", ""),
        "probe": probe,
        "probe_alive": bool(alive) and not dead and not fake_alive,
        "has_grok_45": has_g45,
        "models_probe": models_probe,
        "chat_probe": chat_probe,
        "deleted": bool(probe.get("deleted")) or not still,
        "referrer": ref,
        "remote": remote_result,
        "mint_mode": channel,
        "error": err,
    }


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
    delete_on_dead: bool = False,
    mint_mode: str = "",
    page: Any = None,
    require_grok_45: bool = True,
    log: LogFn | None = None,
) -> dict[str, Any]:
    """SSO cookie → mint → data/auth/xai-<email>[-channel].json [+ 远程推送]

    mint_mode:
      - pkce（默认 A）：Auth Code+PKCE，referrer=grok-build
      - device（B）：Device Flow（regkit）
      - double（C）：同时产出 PKCE + Device 两份 auth，各自写文件、各自测活；
        两通道独立 OAuth grant，互不影响（一份不会因另一份产生而失效）
      - 空：读 config/env cpa_mint_mode
      - 兼容别名：auto/c/merged/both → double

    若 sso 为 wrapper JWT，先 ensure_session_sso materialize。

    delete_on_dead: mint 后 probe 为 401/402/403 时是否删除本地文件（默认 False）。
    require_grok_45: True 时 GET /models 无 grok-4.5 则不推 CPA、ok=False。
    """
    log = log or _noop
    sso = _normalize_sso_token(sso or "")
    if not sso:
        return {"ok": False, "error": "empty sso"}
    out_dir = Path(auth_dir) if auth_dir else default_auth_dir()

    # wrapper JWT → 会话 sso（hybrid/CreateAccount 常见）
    try:
        from sso_materialize import ensure_session_sso, is_wrapper_sso

        if is_wrapper_sso(sso):
            log("[auth] SSO 疑似 wrapper，尝试 materialize…")
            sso = ensure_session_sso(sso, page=page, proxy=proxy or "", log=log) or sso
            sso = _normalize_sso_token(sso)
    except Exception as e:
        log(f"[auth] materialize 跳过: {e}")

    resolved_mode = (mint_mode or _read_cpa_mint_mode() or "pkce").strip().lower()
    if resolved_mode in ("a", "auth_code"):
        resolved_mode = "pkce"
    if resolved_mode in ("b", "device_flow"):
        resolved_mode = "device"
    if resolved_mode in ("c", "auto", "merged", "both", "pkce_then_device"):
        resolved_mode = "double"

    # ---------- double：两通道各 mint → 各写 auth → 各 probe ----------
    if resolved_mode == "double":
        log(
            f"[auth] SSO→CPA mint mode=double email={email or '-'} dir={out_dir} "
            f"（同时产出 pkce+device 两份 auth，分别测活；两通道互不影响）"
        )
        channels_out: list[dict[str, Any]] = []
        # device first (fast Auth B), then pure PKCE/browser (Auth A) so both can land
        for ch in ("device", "pkce"):
            tok: dict[str, Any] | None = None
            mint_err = ""
            # pkce: pure protocol + browser callback (never device-fallback into *-pkce)
            # device: retry TLS flakiness
            attempts = 3 if ch == "device" else 2
            for ai in range(attempts):
                try:
                    if ch == "pkce":
                        tok = _via_pkce_token(
                            sso,
                            proxy=proxy or "",
                            log=log,
                            allow_device_fallback=False,
                        )
                    else:
                        tok = _via_device_token(
                            sso,
                            proxy=proxy or "",
                            log=log,
                            attempts=1,
                        )
                except Exception as e:
                    mint_err = str(e)
                    log(f"[auth] channel={ch} mint 异常 attempt={ai + 1}/{attempts}: {e}")
                    tok = None
                if tok and tok.get("access_token"):
                    break
                if ai + 1 < attempts:
                    log(f"[auth] channel={ch} mint 失败，{1.0 + ai}s 后重试…")
                    time.sleep(1.0 + ai)
            if not tok or not tok.get("access_token"):
                channels_out.append(
                    {
                        "ok": False,
                        "channel": ch,
                        "error": mint_err or f"mint failed (channel={ch})",
                        "mint_mode": ch,
                    }
                )
                continue
            try:
                one = _write_and_probe_one(
                    token=tok,
                    sso=sso,
                    email=email,
                    out_dir=out_dir,
                    channel=ch,
                    proxy=proxy or "",
                    random_fingerprint=random_fingerprint,
                    skip_remote=skip_remote,
                    remote_url=remote_url,
                    management_key=management_key,
                    delete_on_dead=delete_on_dead,
                    require_grok_45=require_grok_45,
                    log=log,
                )
                channels_out.append(one)
            except Exception as e:
                log(f"[auth] channel={ch} write/probe 异常: {e}")
                channels_out.append(
                    {
                        "ok": False,
                        "channel": ch,
                        "error": str(e),
                        "mint_mode": ch,
                    }
                )

        ok_chs = [c for c in channels_out if c.get("ok") and c.get("path")]
        alive_chs = [c for c in ok_chs if c.get("probe_alive")]
        # 任一通道写出成功且过 grok-4.5 门禁即总体 ok；优先 pkce
        primary = next(
            (c for c in ok_chs if c.get("channel") == "pkce"),
            ok_chs[0] if ok_chs else None,
        )
        summary = (
            f"double channels={len(channels_out)} ok={len(ok_chs)} "
            f"probe_alive={len(alive_chs)}; independent grants, peer not invalidated"
        )
        log(f"[auth] {summary}")
        if not ok_chs:
            return {
                "ok": False,
                "error": "double mint: both channels failed",
                "email": email,
                "mint_mode": "double",
                "channels": channels_out,
                "note": "two independent OAuth grants; one does not invalidate the other",
            }
        return {
            "ok": True,
            "email": (primary or {}).get("email") or email,
            "path": (primary or {}).get("path") or "",
            "filename": (primary or {}).get("filename") or "",
            "sub": (primary or {}).get("sub") or "",
            "agent_id": (primary or {}).get("agent_id") or "",
            "probe": (primary or {}).get("probe"),
            "has_grok_45": (primary or {}).get("has_grok_45"),
            "referrer": (primary or {}).get("referrer"),
            "remote": (primary or {}).get("remote"),
            "mint_mode": "double",
            "channels": channels_out,
            "paths": [c.get("path") for c in ok_chs if c.get("path")],
            "note": (
                "double: produces two channel auths (pkce+device); "
                "each probed separately; independent grants do not invalidate each other"
            ),
            "summary": summary,
        }

    # ---------- 单通道 pkce | device ----------
    log(
        f"[auth] SSO→CPA mint mode={resolved_mode} email={email or '-'} dir={out_dir}"
    )
    token, used_mode = _mint_tokens(
        sso, proxy=proxy or "", mint_mode=resolved_mode, log=log
    )
    if not token or not token.get("access_token"):
        return {
            "ok": False,
            "error": f"mint failed (mode={used_mode})",
            "email": email,
            "mint_mode": used_mode,
        }

    one = _write_and_probe_one(
        token=token,
        sso=sso,
        email=email,
        out_dir=out_dir,
        channel="",  # 单通道不写后缀，保持 xai-<email>.json
        proxy=proxy or "",
        random_fingerprint=random_fingerprint,
        skip_remote=skip_remote,
        remote_url=remote_url,
        management_key=management_key,
        delete_on_dead=delete_on_dead,
        require_grok_45=require_grok_45,
        log=log,
    )
    one["mint_mode"] = used_mode
    if one.get("error") and not one.get("path"):
        one["ok"] = False
    elif one.get("error") and one.get("path"):
        # probe dead / 无 grok-4.5 但文件可能仍在
        one["ok"] = False
    return one


def tokens_to_cpa_auth(
    *,
    access_token: str,
    refresh_token: str,
    id_token: str | None = None,
    expires_in: Any = None,
    email: str = "",
    sso: str = "",
    proxy: str = "",
    auth_dir: str | Path | None = None,
    random_fingerprint: bool = True,
    remote_url: str = "",
    management_key: str = "",
    skip_remote: bool = False,
    delete_on_dead: bool = False,
    require_grok_45: bool = True,
    mint_channel: str = "browser_device",
    log: LogFn | None = None,
) -> dict[str, Any]:
    """已有 access/refresh token → 写 CPA auth + has_grok_45 门禁 + 可选推送。

    供 browser Device mint / 外部 token 导入复用。
    """
    log = log or _noop
    access_token = str(access_token or "").strip()
    if not access_token:
        return {"ok": False, "error": "empty access_token"}
    out_dir = Path(auth_dir) if auth_dir else default_auth_dir()
    token = {
        "access_token": access_token,
        "refresh_token": str(refresh_token or "").strip(),
        "id_token": id_token,
        "expires_in": expires_in,
    }
    return _write_and_probe_one(
        token=token,
        sso=sso or "",
        email=email,
        out_dir=out_dir,
        channel=str(mint_channel or "browser_device"),
        proxy=proxy or "",
        random_fingerprint=random_fingerprint,
        skip_remote=skip_remote,
        remote_url=remote_url,
        management_key=management_key,
        delete_on_dead=delete_on_dead,
        require_grok_45=require_grok_45,
        log=log,
    )


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
    delete_on_dead: bool = False,
    log: LogFn | None = None,
) -> dict[str, Any]:
    """重签单个 auth JSON：优先 refresh_token；失败则用 sso 重 mint。

    push_remote=True 时，成功后按 config/环境推送 Management API（默认 False）。
    delete_on_dead：接口保留兼容，重签路径 **始终不删** 文件（防点重签后文件消失）。
    需要删死号请用「测活」+ cpaProbeDeleteOnDead。
    """
    # 兼容旧调用方；重签绝不删文件
    _ = delete_on_dead
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

    # 1) refresh_token 换票（mode=refresh）
    if refresh:
        log(f"[auth] mode=refresh resign start: {p.name} proxy={'yes' if proxy else 'no'}")
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
                return {
                    "ok": False,
                    "error": f"build payload failed: {e}",
                    "email": email,
                    "mode": "refresh",
                }
            new_payload = _ensure_payload_sso(new_payload, sso_keep)
            tmp = p.with_suffix(p.suffix + ".tmp")
            tmp.write_text(json.dumps(new_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.replace(tmp, p)
            log(f"[auth] mode=refresh wrote → {p.name}")
            ref = access_token_referrer(str(token.get("access_token") or ""))
            if ref:
                log(f"[auth] mode=refresh access_token referrer={ref}")
            else:
                log("[auth] mode=refresh ⚠ access_token 无 referrer claim（cli-chat-proxy 可能 403）")
            # 重签：强制不因 probe dead 删文件（避免「点重签后文件没了」）。
            # mint_soft_retry：刚 refresh 后同样可能瞬时 403
            probe = probe_and_cleanup(
                p, proxy=proxy or "", delete_on_dead=False, mint_soft_retry=True
            )
            log(
                f"[auth] mode=refresh probe action={probe.get('action')} "
                f"http={probe.get('http_status')} deleted={probe.get('deleted')} "
                f"{probe.get('summary') or probe.get('error') or ''}"
            )
            # 文件已成功写出 → 重签视为成功；probe dead 仅作警告
            out: dict[str, Any] = {
                "ok": True,
                "mode": "refresh",
                "path": str(p),
                "email": email,
                "filename": p.name,
                "probe": probe,
                "deleted": False,
                "referrer": ref,
            }
            if probe.get("action") == "dead":
                out["probe_warn"] = f"cpa probe dead HTTP {probe.get('http_status')}"
                out["alive"] = False
            elif probe.get("action") == "ok":
                out["alive"] = True
            if not ref:
                out["referrer_warn"] = "missing referrer claim"
            if push_remote:
                out["remote"] = _try_push_remote(new_payload, log=log)
            return out
        log(f"[auth] mode=refresh failed, fallback sso if any: {token}")

    # 2) sso re-mint（mode=sso，Auth Code+PKCE）
    sso_v = (sso or str(payload.get("sso") or "")).strip()
    if sso_v:
        log(f"[auth] mode=sso resign start: {p.name} proxy={'yes' if proxy else 'no'}")
        r = sso_to_cpa_auth(
            sso=sso_v,
            email=email,
            proxy=proxy,
            auth_dir=p.parent,
            random_fingerprint=bool(raw_headers is None),
            # 默认不推；push_remote=True 时与 mint 一致走远程
            skip_remote=not push_remote,
            # 重签路径强制不删文件
            delete_on_dead=False,
            log=log,
        )
        # mint 写出后若仅 probe dead，文件仍在：视为重签成功 + 警告
        if r.get("ok"):
            r["mode"] = "sso"
            log(f"[auth] mode=sso ok: {p.name}")
            return r
        path_still = str(r.get("path") or "")
        fname_still = str(r.get("filename") or "")
        probe = r.get("probe") if isinstance(r.get("probe"), dict) else {}
        if (
            path_still
            and Path(path_still).is_file()
            and probe.get("action") == "dead"
            and not r.get("deleted")
        ):
            log(f"[auth] mode=sso wrote but probe dead: {fname_still or path_still}")
            return {
                "ok": True,
                "mode": "sso",
                "path": path_still,
                "filename": fname_still or Path(path_still).name,
                "email": r.get("email") or email,
                "probe": probe,
                "probe_warn": r.get("error") or f"cpa probe dead HTTP {probe.get('http_status')}",
                "alive": False,
                "deleted": False,
                "remote": r.get("remote"),
            }
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
        # 绝不因重签失败误报 deleted
        out["deleted"] = False
        if path_still and Path(path_still).is_file():
            out["path"] = path_still
        if fname_still:
            out["filename"] = fname_still
        log(f"[auth] mode=sso failed: {out.get('error')}")
        return out

    log(f"[auth] mode=none resign unavailable: {p.name} (no refresh_token and no sso)")
    return {
        "ok": False,
        "error": "no refresh_token and no sso for resign（可试密码重登 mode=password_relogin）",
        "email": email,
        "path": str(p),
        "mode": "none",
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
