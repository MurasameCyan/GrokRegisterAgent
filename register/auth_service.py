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
from bfs_check import BFS_FLAGGED, BFS_UNKNOWN, bfs_sidecar_fields

LogFn = Callable[[str], None]

# 全局锁：browser consent 串行起独立 Chromium（独占 debug port + 临时 profile）
# 与注册机主浏览器隔离；并行 mint 时避免两路 consent 同时 auto/撞口
import threading as _threading

_BROWSER_CONSENT_LOCK = _threading.Lock()



def _noop(msg: str) -> None:
    return None



def _skip_bot_flag_on_mint_enabled() -> bool:
    """config/env: skip bot/high-risk before OAuth mint. Default True (safe).

    Keys: skip_bot_flag_on_mint / skipBotFlag1OnMint / SKIP_BOT_FLAG_ON_MINT
    Set false to still attempt mint (may waste time; keep SSO for later retry).
    """
    env = (
        os.environ.get("SKIP_BOT_FLAG_ON_MINT")
        or os.environ.get("skip_bot_flag_on_mint")
        or ""
    ).strip().lower()
    if env in ("0", "false", "no", "off"):
        return False
    if env in ("1", "true", "yes", "on"):
        return True
    conf_path = Path(__file__).resolve().parent / "config.json"
    try:
        conf = json.loads(conf_path.read_text(encoding="utf-8"))
        for k in (
            "skip_bot_flag_on_mint",
            "skipBotFlag1OnMint",
            "skip_bot_flag1_on_mint",
        ):
            if k not in conf:
                continue
            v = conf.get(k)
            if isinstance(v, bool):
                return v
            s = str(v or "").strip().lower()
            if s in ("0", "false", "no", "off"):
                return False
            if s in ("1", "true", "yes", "on"):
                return True
    except Exception:
        pass
    return True



def _risk_mint_light_attempts_enabled() -> bool:
    """config/env: bot/high-risk 仍 mint 时减通道重试。Default True.

    Keys: risk_mint_light_attempts / riskMintLightAttempts / RISK_MINT_LIGHT_ATTEMPTS
    true  → double: device 1 次 + pkce 1 次（非 3+2）
    false → 完整内部重试
    仅当 skip_bot_flag_on_mint=false 且 gate blocked 时生效。
    """
    env = (
        os.environ.get("RISK_MINT_LIGHT_ATTEMPTS")
        or os.environ.get("risk_mint_light_attempts")
        or ""
    ).strip().lower()
    if env in ("0", "false", "no", "off"):
        return False
    if env in ("1", "true", "yes", "on"):
        return True
    conf_path = Path(__file__).resolve().parent / "config.json"
    try:
        conf = json.loads(conf_path.read_text(encoding="utf-8"))
        for k in (
            "risk_mint_light_attempts",
            "riskMintLightAttempts",
            "risk_mint_light",
        ):
            if k not in conf:
                continue
            v = conf.get(k)
            if isinstance(v, bool):
                return v
            s = str(v or "").strip().lower()
            if s in ("0", "false", "no", "off"):
                return False
            if s in ("1", "true", "yes", "on"):
                return True
    except Exception:
        pass
    return True


def _conf_bool(
    env_keys: tuple[str, ...],
    conf_keys: tuple[str, ...],
    default: bool,
) -> bool:
    """env 优先、其次 register/config.json，最后 default。空值不算显式设置。"""

    def _parse(v: Any) -> bool | None:
        if isinstance(v, bool):
            return v
        s = str(v if v is not None else "").strip().lower()
        if s in ("0", "false", "no", "off"):
            return False
        if s in ("1", "true", "yes", "on"):
            return True
        return None

    for k in env_keys:
        got = _parse(os.environ.get(k))
        if got is not None:
            return got
    conf_path = Path(__file__).resolve().parent / "config.json"
    try:
        conf = json.loads(conf_path.read_text(encoding="utf-8"))
        if isinstance(conf, dict):
            for k in conf_keys:
                if k not in conf:
                    continue
                got = _parse(conf.get(k))
                if got is not None:
                    return got
    except Exception:
        pass
    return default


def _bfs_check_enabled() -> bool:
    """mint 后解码 access_token 检测 `bfs` claim。Default True（只读，无成本）。"""
    return _conf_bool(
        ("BFS_CHECK", "bfs_check"),
        ("bfs_check", "bfsCheck"),
        True,
    )


def _bfs_skip_cpa_enabled() -> bool:
    """bfs_status=unknown（JWT 解不开）时不写 CPA/远程。Default False。

    注意：FLAGGED **不再**触发跳过。全量实测证明 `bfs` claim 只在一段短上游窗口
    内签发的 token 上出现，且命中组测活存活率不低于未命中组——它是上游开关，
    不是按号评估的风控标记；按 FLAGGED 丢号会丢掉质量最好的一批。
    详见 register/bfs_check.py 模块头。
    """
    return _conf_bool(
        ("BFS_SKIP_CPA", "bfs_skip_cpa"),
        ("bfs_skip_cpa", "bfsSkipCpa"),
        False,
    )


def _bfs_disable_cpa_enabled() -> bool:
    """bfs_status=unknown 时仍写 CPA，但标 disabled=true。Default False。

    同上：FLAGGED 不再触发 disabled。
    """
    return _conf_bool(
        ("BFS_DISABLE_CPA", "bfs_disable_cpa"),
        ("bfs_disable_cpa", "bfsDisableCpa"),
        False,
    )


def probe_sso_oauth_gate(
    sso: str,
    *,
    proxy: str = "",
    log: LogFn | None = None,
) -> dict[str, Any]:
    """Mint 前探测：bot / 高风险账号通常 OAuth 一律 Access denied。

    依据 grok.com/rest/auth/get-user：
      botFlagSource / riskLevel=USER_RISK_LEVEL_HIGH
    常见于注册时 castleRequestToken 为空（Plan C 协议 CreateEmail 无 castle）。
    """
    log = log or _noop
    sso = str(sso or "").strip()
    if not sso:
        return {"ok": False, "blocked": True, "error": "empty sso"}
    try:
        from curl_cffi import requests as cf_requests
    except ImportError as e:
        return {"ok": False, "blocked": False, "error": f"curl_cffi required: {e}"}

    sess = cf_requests.Session()
    if proxy:
        sess.proxies = {"http": proxy, "https": proxy}
    for domain in (".grok.com", "grok.com", ".x.ai"):
        try:
            sess.cookies.set("sso", sso, domain=domain)
            sess.cookies.set("sso-rw", sso, domain=domain)
        except Exception:
            pass
    try:
        r = sess.get(
            "https://grok.com/rest/auth/get-user",
            headers={"Origin": "https://grok.com", "Referer": "https://grok.com/"},
            impersonate="chrome120",
            timeout=15,
        )
    except Exception as e:
        log(f"[auth] oauth-gate probe network: {e}")
        return {"ok": False, "blocked": False, "error": f"probe network: {e}"}
    if int(getattr(r, "status_code", 0) or 0) != 200:
        log(f"[auth] oauth-gate probe HTTP {r.status_code}: {(r.text or '')[:120]}")
        return {
            "ok": False,
            "blocked": False,
            "error": f"get-user HTTP {r.status_code}",
            "status": r.status_code,
        }
    try:
        body = r.json() if r.text else {}
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    risk = str(body.get("riskLevel") or "").strip()
    bot_src = str(body.get("botFlagSource") or "").strip()
    bot_details = str(body.get("botFlagDetails") or "").strip()
    email = str(body.get("email") or "").strip()
    # BOT_FLAG_SOURCE_* 非空 / 非 UNSPECIFIED → 视为 bot
    bot_hit = bool(bot_src) and "UNSPECIFIED" not in bot_src.upper() and bot_src.upper() not in (
        "",
        "BOT_FLAG_SOURCE_UNSPECIFIED",
        "0",
    )
    high_risk = "HIGH" in risk.upper()
    blocked = bool(bot_hit or high_risk)
    if blocked:
        log(
            f"[auth] ❌ OAuth 门禁拦截 email={email or '-'} risk={risk or '-'} "
            f"bot={bot_src or '-'} detail={(bot_details or '')[:120]}"
        )
        log(
            "[auth] 提示：注册期 Castle/风控标签会锁死 OAuth。"
            " no_token=没带 castle；policy=deny,risk=1.00=已评估仍 deny。"
            " 建号须用 CDN v2 window._castle('setAppId'+'createRequestToken')，"
            " 且 CreateEmail field3 / CreateUser 带 conversionId+新鲜 castle；"
            " 仅补 castle 未必能恢复 OAuth"
        )
    else:
        log(
            f"[auth] oauth-gate ok email={email or '-'} risk={risk or '-'} "
            f"bot={bot_src or 'none'}"
        )
    return {
        "ok": not blocked,
        "blocked": blocked,
        "riskLevel": risk,
        "botFlagSource": bot_src,
        "botFlagDetails": bot_details,
        "email": email,
        "userId": str(body.get("userId") or ""),
        "raw": body,
        "error": (
            f"sso bot/high-risk blocked for OAuth (risk={risk or '-'}, bot={bot_src or '-'})"
            if blocked
            else ""
        ),
    }


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
    allow_device_fallback: bool | None = None,
    allow_browser_fallback: bool = True,
    cloudflare_cookies: str = "",
) -> dict[str, Any] | None:
    """PKCE main path; optionally device then short browser Allow.

    Order (srcback-aligned):
      1) CreateCookieSetterLink PKCE (cpa_pkce_mint, chrome131)
      2) legacy sso_to_token PKCE
      3) device fallback (config cpa_allow_device_flow_fallback, default off)
      4) browser consent Allow（allow_browser_fallback=False 时跳过，风控 light 用）

    allow_device_fallback=False for double-mode *pkce channel* so a device grant
    is never written as xai-*-pkce.json (Auth B / *-device.json would be missing
    while the only file is a mislabeled device token).
    """
    log = log or _noop
    log("[auth] mint channel=pkce (Auth Code+PKCE)…")
    tokens: dict[str, Any] | None = None

    # Resolve device fallback: explicit arg wins; else config (default False)
    if allow_device_fallback is None:
        try:
            from cpa_pkce_mint import allow_device_flow_fallback as _adf

            allow_device_fallback = bool(_adf())
        except Exception:
            allow_device_fallback = False

    # 0) CreateCookieSetterLink PKCE（srcback 主路径）
    try:
        from cpa_pkce_mint import (
            PKCEMintError,
            mint_with_sso_pkce,
            prefer_cookie_setter_pkce,
            load_mint_impersonate,
        )

        if prefer_cookie_setter_pkce():
            imp = load_mint_impersonate()
            log(f"[auth] mint try cookie-setter PKCE impersonate={imp}…")
            # 网络瞬断轻量重试（对齐 cpa_pkce_network_retries 默认 1）
            last_cs_err = ""
            for attempt in range(1, 3):
                try:
                    tokens = mint_with_sso_pkce(
                        sso_cookie=sso,
                        proxy=proxy or None,
                        log=log,
                        impersonate=imp,
                    )
                    if tokens and tokens.get("access_token"):
                        log("[auth] cookie-setter PKCE SUCCESS")
                        return tokens
                    break
                except PKCEMintError as e:
                    last_cs_err = str(e)
                    err_l = last_cs_err.lower()
                    transient = any(
                        k in err_l
                        for k in (
                            "timeout",
                            "timed out",
                            "connect",
                            "curl",
                            "tls",
                            "reset",
                            "refused",
                        )
                    )
                    if attempt < 2 and transient:
                        log(
                            f"[auth] cookie-setter PKCE network: {e}; retry {attempt}/1"
                        )
                        time.sleep(1.5)
                        continue
                    log(f"[auth] cookie-setter PKCE failed: {e}")
                    break
                except Exception as e:
                    last_cs_err = str(e)
                    log(f"[auth] cookie-setter PKCE exception: {e}")
                    break
            tokens = None
    except ImportError as ie:
        log(f"[auth] cpa_pkce_mint 不可用，回落 legacy PKCE: {ie}")
    except Exception as ce:
        log(f"[auth] cookie-setter PKCE setup err: {ce}")

    # 1) legacy form-consent PKCE
    try:
        tokens = sso_to_token(sso, proxy=proxy or "", log=log)
    except Exception as pe:
        log(f"[auth] legacy PKCE exception: {pe}")
        tokens = None
    if tokens and tokens.get("access_token"):
        return tokens

    # 2) device: only when enabled (default off; double-mode pkce slot always off)
    if allow_device_fallback:
        log("[auth] PKCE failed → device flow fallback…")
        try:
            dev = _via_device_token(sso, proxy=proxy or "", log=log)
            if dev and dev.get("access_token"):
                return dev
        except Exception as de:
            log(f"[auth] device fallback err: {de}")
    else:
        log(
            "[auth] PKCE failed (device fallback off; "
            "set cpa_allow_device_flow_fallback=true to enable)"
        )

    # 3) browser Allow: short timeout so mint-queue cannot hang forever
    if not allow_browser_fallback:
        log("[auth] PKCE skip browser consent（allow_browser_fallback=false）")
        return None
    try:
        from sso_to_auth import sso_to_token_via_browser_consent

        log("[auth] PKCE path → browser consent fallback (timeout=55s, headed/Xvfb)…")
        with _BROWSER_CONSENT_LOCK:
            # Linux 容器：必须有头（复用注册机 Xvfb）。Chrome headless 会被 auth.x.ai CF 硬拦。
            px = str(proxy or "").strip()
            if not px:
                try:
                    from auth_export_queue import resolve_mint_proxy

                    px = resolve_mint_proxy("")
                except Exception:
                    px = ""
            if px:
                log(f"[auth] browser consent proxy={px[:64]}")
            else:
                log("[auth] ⚠ browser consent proxy empty (proxy_mode may be none)")
            tokens = sso_to_token_via_browser_consent(
                sso,
                proxy=px,
                log=log,
                headless=False,
                timeout=55.0,
                cloudflare_cookies=cloudflare_cookies or "",
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
    allow_browser_fallback: bool = True,
) -> dict[str, Any] | None:
    """Device Flow mint. attempts>1 retries transient TLS/OPENSSL curl (35).

    协议 Device 失败（invalid_grant / 假批准）后默认回退浏览器 OAuth
    （对齐 regkit protocol_only=False：机器号/假批准时浏览器更稳）。
    """
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

    if not allow_browser_fallback:
        return None

    # 协议 Device 假批准 / invalid_grant → 浏览器点 Allow（accounts.x.ai 前端）
    el = last_err.lower()
    if any(
        x in el
        for x in (
            "invalid_grant",
            "access_denied",
            "poll timeout",
            "approve",
            "denied",
        )
    ) or last_err:
        try:
            from browser_device_mint import mint_with_sso_browser

            log(
                "[auth] device protocol failed → browser SSO consent "
                f"(err={last_err[:80]})"
            )
            px = str(proxy or "").strip()
            if not px:
                try:
                    from auth_export_queue import resolve_mint_proxy

                    px = resolve_mint_proxy("")
                except Exception:
                    px = ""
            with _BROWSER_CONSENT_LOCK:
                br = mint_with_sso_browser(
                    sso=sso,
                    proxy=px,
                    headless=False,
                    timeout=100.0,
                    log=log,
                )
            if br and br.get("ok") and br.get("access_token"):
                log("[auth] browser SSO device consent ✔")
                return {
                    "access_token": br.get("access_token") or "",
                    "refresh_token": br.get("refresh_token") or "",
                    "id_token": br.get("id_token"),
                    "expires_in": br.get("expires_in"),
                }
            log(f"[auth] browser SSO device consent ✘ {br.get('error') if br else 'none'}")
        except Exception as be:
            log(f"[auth] browser SSO device fallback err: {be}")
    return None


def _mint_tokens(
    sso: str,
    *,
    proxy: str = "",
    mint_mode: str = "",
    cloudflare_cookies: str = "",
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
        t = _via_pkce_token(
            sso,
            proxy=proxy,
            log=log,
            cloudflare_cookies=cloudflare_cookies or "",
        )
        return t, "pkce"
    t = _via_pkce_token(
        sso,
        proxy=proxy,
        log=log,
        cloudflare_cookies=cloudflare_cookies or "",
    )
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

    # BFS claim 检测：payload 含 `bfs` key 即 flagged。
    # 实测非风险信号（仅特定上游窗口签发的 token 带此 claim，且该批存活率不低），
    # 故 flagged 仅作溯源记录，不参与拦截；只有 unknown（JWT 解不开、无法判定）
    # 才可按配置拦截。解不开的 token 绝不当 clean。
    bfs_info: dict[str, Any] = {}
    if _bfs_check_enabled():
        bfs_info = bfs_sidecar_fields(
            token.get("access_token") or "",
            token.get("id_token") or "",
            sso,
        )
        payload.update(bfs_info)
        bfs_status = str(bfs_info.get("bfs_status") or "")
        if bfs_status == BFS_FLAGGED:
            log(
                f"[auth] channel={channel} BFS 标记 "
                f"bfs={bfs_info.get('bfs_value')!r} "
                f"source={bfs_info.get('bfs_source') or '-'} "
                f"email={payload.get('email') or email or '-'}"
                f"（非风险信号：上游窗口标记，不拦截）"
            )
        elif bfs_status == BFS_UNKNOWN:
            log(f"[auth] channel={channel} BFS unknown（JWT 解不开，不判定为 clean）")

        # 仅 unknown 可拦截：无法判定的 token 不宜热加载进 CPA。
        # FLAGGED 明确是好号，绝不跳过。
        skip_for_bfs = bfs_status == BFS_UNKNOWN
        if skip_for_bfs and _bfs_skip_cpa_enabled():
            log(
                f"[auth] channel={channel} ✘ bfs_skip_cpa=true，跳过 CPA 写入"
                f"（bfs_status={bfs_status}）"
            )
            return {
                "ok": False,
                "channel": channel,
                "email": payload.get("email") or email,
                "path": "",
                "filename": "",
                "sub": payload.get("sub") or "",
                "skipped_bfs": True,
                "probe": None,
                "probe_alive": False,
                "referrer": ref,
                "remote": {
                    "ok": False,
                    "skipped": True,
                    "error": f"bfs_skip_cpa: {bfs_status}",
                },
                "mint_mode": channel,
                "error": f"bfs_skip_cpa: bfs_status={bfs_status}",
                **bfs_info,
            }
        # bfs_disable_cpa：仅 unknown 时写入并标 disabled，人工复核后可启用
        if bfs_status == BFS_UNKNOWN and _bfs_disable_cpa_enabled():
            payload["disabled"] = True
            log(
                f"[auth] channel={channel} bfs_disable_cpa=true → 写入但标 disabled=true"
                f"（bfs_status=unknown）"
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

    # 10: mini chat 探针（POST /responses）；新 token 常瞬时 deny → 延迟重试
    chat_probe: dict[str, Any] | None = None
    if models_ok and has_g45 and not fake_alive:
        try:
            # srcback: initial_delay=3 + retries [5,15,30]
            conf_chat: dict[str, Any] = {}
            try:
                conf_path = Path(__file__).resolve().parent / "config.json"
                if conf_path.is_file():
                    conf_chat = json.loads(conf_path.read_text(encoding="utf-8"))
                    if not isinstance(conf_chat, dict):
                        conf_chat = {}
            except Exception:
                conf_chat = {}
            try:
                initial_delay = float(
                    conf_chat.get("cpa_probe_chat_initial_delay_sec")
                    if conf_chat.get("cpa_probe_chat_initial_delay_sec") is not None
                    else conf_chat.get("cpaProbeChatInitialDelaySec")
                    if conf_chat.get("cpaProbeChatInitialDelaySec") is not None
                    else 3.0
                )
            except Exception:
                initial_delay = 3.0
            initial_delay = max(0.0, min(initial_delay, 30.0))
            raw_delays = conf_chat.get("cpa_probe_chat_retry_delays")
            if raw_delays is None:
                raw_delays = conf_chat.get("cpaProbeChatRetryDelays")
            retry_delays: list[float]
            if raw_delays is None:
                retry_delays = [5.0, 15.0, 30.0]
            elif isinstance(raw_delays, (list, tuple)):
                retry_delays = []
                for x in raw_delays:
                    try:
                        retry_delays.append(float(x))
                    except Exception:
                        pass
            else:
                retry_delays = [5.0, 15.0, 30.0]
            retry_delays = [max(0.0, min(d, 120.0)) for d in retry_delays][:5]

            if initial_delay > 0:
                log(
                    f"[auth] channel={channel} chat probe wait "
                    f"{initial_delay:.0f}s (new-token soft window)…"
                )
                time.sleep(initial_delay)

            attempts = 1 + len(retry_delays)
            chat_probe = {"ok": False, "error": "not attempted"}
            for ai in range(attempts):
                chat_probe = probe_mini_response(
                    str(token.get("access_token") or ""),
                    base_url=str(payload.get("base_url") or DEFAULT_BASE_URL),
                    proxy=proxy or "",
                    headers=headers if isinstance(headers, dict) else None,
                )
                log(
                    f"[auth] channel={channel} chat probe "
                    f"attempt={ai + 1}/{attempts} ok={chat_probe.get('ok')} "
                    f"status={chat_probe.get('status')} "
                    f"text={(chat_probe.get('text') or '')[:40]!r}"
                )
                if chat_probe.get("ok"):
                    break
                # 瞬时 permission-denied / 5xx 才重试
                st = int(chat_probe.get("status") or 0)
                err_l = str(chat_probe.get("error") or "").lower()
                retryable = st in (0, 403, 429, 500, 502, 503, 504) or any(
                    k in err_l
                    for k in (
                        "permission",
                        "denied",
                        "timeout",
                        "temporarily",
                        "rate",
                    )
                )
                if ai < len(retry_delays) and retryable:
                    d = retry_delays[ai]
                    log(
                        f"[auth] channel={channel} chat probe retry after "
                        f"{d:.0f}s…"
                    )
                    time.sleep(d)
                    continue
                break

            payload["chat_probe_ok"] = bool(chat_probe.get("ok"))
            payload["chat_probe_status"] = chat_probe.get("status")
            # 可选硬门槛：config require_chat_probe=true 时 chat 失败也挡 CPA
            require_chat = bool(
                conf_chat.get("require_chat_probe")
                or conf_chat.get("requireChatProbe")
            )
            if require_chat and not chat_probe.get("ok"):
                fake_alive = True
                log(
                    f"[auth] channel={channel} ✘ chat 探针失败且 require_chat_probe=true，"
                    f"按假活处理: {chat_probe.get('error')}"
                )
        except Exception as ce:
            chat_probe = {"ok": False, "error": str(ce)[:200]}
            log(f"[auth] channel={channel} chat probe skip: {ce}")

    # 回写 has_grok_45 / chat / BFS 到本地文件
    try:
        if path.is_file():
            doc = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(doc, dict):
                doc["has_grok_45"] = has_g45
                doc["model_ids"] = payload["model_ids"]
                if chat_probe is not None:
                    doc["chat_probe_ok"] = bool(chat_probe.get("ok"))
                    doc["chat_probe_status"] = chat_probe.get("status")
                if bfs_info:
                    doc.update(bfs_info)
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
                try:
                    from delivery_store import stamp_auth_file_push_flags

                    stamp_auth_file_push_flags([path], pushed_cpa=True)
                except Exception:
                    pass
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
        **bfs_info,
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



def _find_existing_refresh_for_sso(
    sso: str,
    email: str = "",
    auth_dir: str | Path | None = None,
) -> tuple[str, str, Path | None]:
    """从本地 xai-*.json 找可用 refresh（email 优先，其次 sso 匹配）。

    返回 (refresh_token, email, path)。抄 main：有 refresh 先 refresh 再 SSO mint。
    """
    sso_n = _normalize_sso_token(sso or "")
    email_n = str(email or "").strip().lower()
    try:
        out_dir = Path(auth_dir) if auth_dir else default_auth_dir()
    except Exception:
        return "", email_n, None
    if not out_dir.is_dir():
        return "", email_n, None

    try:
        files = sorted(out_dir.glob("xai-*.json"), key=lambda x: x.stat().st_mtime, reverse=True)
    except Exception:
        return "", email_n, None

    # 1) email 字段精确匹配（不依赖文件名大小写）
    # 2) sso 字段匹配
    # 3) 文件名包含 email
    ranked: list[tuple[int, Path, dict]] = []
    for fp in files:
        try:
            data = json.loads(fp.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        refresh = str(data.get("refresh_token") or "").strip()
        if not refresh:
            continue
        file_email = str(data.get("email") or "").strip().lower()
        file_sso = _normalize_sso_token(str(data.get("sso") or ""))
        score = 0
        if email_n and file_email == email_n:
            score = 3
        elif sso_n and file_sso and file_sso == sso_n:
            score = 2
        elif email_n and email_n in fp.name.lower():
            score = 1
        if score > 0:
            ranked.append((score, fp, data))
    if not ranked:
        return "", email_n, None
    ranked.sort(key=lambda x: (x[0],), reverse=True)
    _score, fp, data = ranked[0]
    refresh = str(data.get("refresh_token") or "").strip()
    em = str(data.get("email") or email_n or "").strip()
    return refresh, em, fp


def _try_refresh_first_for_mint(
    *,
    sso: str,
    email: str,
    proxy: str,
    out_dir: Path,
    delete_on_dead: bool,
    skip_remote: bool,
    require_grok_45: bool,
    log: LogFn,
) -> dict[str, Any] | None:
    """有 refresh 则 refresh 写 auth；成功返回结果 dict，失败返回 None 以走 SSO mint。"""
    refresh, em, src = _find_existing_refresh_for_sso(sso, email, out_dir)
    if not refresh:
        return None
    log(
        f"[auth] refresh-first: found refresh"
        f"{(' from ' + src.name) if src else ''}"
        f" email={em or email or '-'}"
    )
    token = refresh_access_token(refresh, proxy=proxy or "")
    if not token or not token.get("access_token"):
        log(f"[auth] refresh-first failed → SSO mint: {token}")
        return None
    new_refresh = str(token.get("refresh_token") or refresh)
    sso_keep = _normalize_sso_token(sso or "")
    try:
        one = _write_and_probe_one(
            token={
                "access_token": token.get("access_token"),
                "refresh_token": new_refresh,
                "id_token": token.get("id_token"),
                "expires_in": token.get("expires_in"),
            },
            sso=sso_keep,
            email=em or email or "",
            out_dir=out_dir,
            channel="",  # 单通道不写 -refresh 后缀，覆盖/更新主 xai-<email>.json
            proxy=proxy or "",
            random_fingerprint=True,
            skip_remote=skip_remote,
            remote_url="",
            management_key="",
            delete_on_dead=delete_on_dead,
            log=log,
            require_grok_45=require_grok_45,
        )
    except Exception as e:
        log(f"[auth] refresh-first write err: {e}")
        return None
    if not isinstance(one, dict):
        return None
    if one.get("ok"):
        one["mode"] = "sso_mint_refresh"
        one["mint_mode"] = "refresh"
        one["refresh_first"] = True
        log("[auth] refresh-first ✔ skip full SSO OAuth mint")
        return one
    log(f"[auth] refresh-first write not ok → SSO mint: {one.get('error')}")
    return None


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
    cloudflare_cookies: str = "",
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

    # Castle bot / 高风险：默认跳过 mint（可关 skip_bot_flag_on_mint 仍尝试）
    gate = probe_sso_oauth_gate(sso, proxy=proxy or "", log=log)
    risk_light = False
    if gate.get("blocked"):
        if _skip_bot_flag_on_mint_enabled():
            return {
                "ok": False,
                "error": gate.get("error") or "sso blocked for OAuth (bot/high-risk)",
                "email": email or gate.get("email") or "",
                "mint_mode": (mint_mode or _read_cpa_mint_mode() or "pkce"),
                "skipped_bot_flag": True,
                "oauth_gate": {
                    "riskLevel": gate.get("riskLevel"),
                    "botFlagSource": gate.get("botFlagSource"),
                    "botFlagDetails": gate.get("botFlagDetails"),
                    "userId": gate.get("userId"),
                },
            }
        risk_light = bool(_risk_mint_light_attempts_enabled())
        log(
            "[auth] ⚠ bot/high-risk 仍继续 mint（skip_bot_flag_on_mint=false）"
            f" email={email or gate.get('email') or '-'} "
            f"bot={gate.get('botFlagSource') or '-'} risk={gate.get('riskLevel') or '-'}"
            + (
                " · light_attempts=1+1（risk_mint_light_attempts=true）"
                if risk_light
                else " · light_attempts=off（完整重试）"
            )
        )
    if not email and gate.get("email"):
        email = str(gate.get("email") or "")

    resolved_mode = (mint_mode or _read_cpa_mint_mode() or "pkce").strip().lower()
    if resolved_mode in ("a", "auth_code"):
        resolved_mode = "pkce"
    if resolved_mode in ("b", "device_flow"):
        resolved_mode = "device"
    if resolved_mode in ("c", "auto", "merged", "both", "pkce_then_device"):
        resolved_mode = "double"

    # ---------- refresh-first（抄 main）：本地已有 refresh 则跳过 SSO OAuth ----------
    # 补签/重 mint 常见场景：auth 已存在，只需续票，避免 device/PKCE 慢与 524
    prefer_refresh = str(
        os.environ.get("CPA_MINT_REFRESH_FIRST")
        or os.environ.get("cpa_mint_refresh_first")
        or "1"
    ).strip().lower() not in ("0", "false", "no", "off")
    if prefer_refresh and resolved_mode != "double":
        # double 仍要两通道 OAuth；单通道可 refresh-first
        rf = _try_refresh_first_for_mint(
            sso=sso,
            email=email or "",
            proxy=proxy or "",
            out_dir=out_dir,
            delete_on_dead=delete_on_dead,
            skip_remote=skip_remote,
            require_grok_45=require_grok_45,
            log=log,
        )
        if rf is not None:
            return rf

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
            # 风控号 light：强制每通道 1 次（double=1 device + 1 pkce）
            if risk_light:
                attempts = 1
            else:
                attempts = 3 if ch == "device" else 2
            for ai in range(attempts):
                try:
                    if ch == "pkce":
                        tok = _via_pkce_token(
                            sso,
                            proxy=proxy or "",
                            log=log,
                            allow_device_fallback=False,
                            allow_browser_fallback=not risk_light,
                            cloudflare_cookies=cloudflare_cookies or "",
                        )
                    else:
                        tok = _via_device_token(
                            sso,
                            proxy=proxy or "",
                            log=log,
                            attempts=1,
                            allow_browser_fallback=not risk_light,
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
            # 风控 light：错误串带 bot/high-risk，避免 auth-queue 再走密码 browser 长轮询
            err_msg = "double mint: both channels failed"
            if risk_light:
                err_msg = (
                    "sso bot/high-risk blocked for OAuth; "
                    "double mint light 1+1 failed (no browser fallback)"
                )
            out: dict[str, Any] = {
                "ok": False,
                "error": err_msg,
                "email": email,
                "mint_mode": "double",
                "channels": channels_out,
                "note": "two independent OAuth grants; one does not invalidate the other",
            }
            if risk_light:
                out["risk_light"] = True
                out["skipped_bot_flag"] = False
                out["oauth_gate"] = {
                    "riskLevel": gate.get("riskLevel"),
                    "botFlagSource": gate.get("botFlagSource"),
                    "botFlagDetails": gate.get("botFlagDetails"),
                    "userId": gate.get("userId"),
                }
            return out
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
        + (" · risk_light no-browser" if risk_light else "")
    )
    if risk_light:
        # 风控 light：单通道也只协议一次，禁止 browser consent 长等
        if resolved_mode == "device":
            token = _via_device_token(
                sso,
                proxy=proxy or "",
                log=log,
                attempts=1,
                allow_browser_fallback=False,
            )
            used_mode = "device"
        else:
            token = _via_pkce_token(
                sso,
                proxy=proxy or "",
                log=log,
                allow_device_fallback=False,
                allow_browser_fallback=False,
                cloudflare_cookies=cloudflare_cookies or "",
            )
            used_mode = "pkce"
    else:
        token, used_mode = _mint_tokens(
            sso,
            proxy=proxy or "",
            mint_mode=resolved_mode,
            cloudflare_cookies=cloudflare_cookies or "",
            log=log,
        )
    if not token or not token.get("access_token"):
        err = f"mint failed (mode={used_mode})"
        if risk_light:
            err = (
                f"sso bot/high-risk blocked for OAuth; "
                f"mint light failed mode={used_mode} (no browser fallback)"
            )
        out_fail: dict[str, Any] = {
            "ok": False,
            "error": err,
            "email": email,
            "mint_mode": used_mode,
        }
        if risk_light:
            out_fail["risk_light"] = True
            out_fail["oauth_gate"] = {
                "riskLevel": gate.get("riskLevel"),
                "botFlagSource": gate.get("botFlagSource"),
                "botFlagDetails": gate.get("botFlagDetails"),
                "userId": gate.get("userId"),
            }
        return out_fail

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
    base_url_target: str = "",
    log: LogFn | None = None,
) -> dict[str, Any]:
    """重签单个 auth JSON：优先 refresh_token；失败则用 sso 重 mint。

    push_remote=True 时，成功后按 config/环境推送 Management API（默认 False）。
    delete_on_dead：接口保留兼容，重签路径 **始终不删** 文件（防点重签后文件消失）。
    需要删死号请用「测活」+ cpaProbeDeleteOnDead。

    base_url_target:
      - "cli" / "cli-chat" / "" → https://cli-chat-proxy.grok.com/v1（默认，额度满）
      - "api" / "api.x.ai" → https://api.x.ai/v1（防风控更强，额度约 50%）
    """
    # 兼容旧调用方；重签绝不删文件
    _ = delete_on_dead
    log = log or _noop
    # 解析 base_url 目标
    _bt = str(base_url_target or "").strip().lower()
    if _bt in ("api", "api.x.ai", "apixai", "xai-api"):
        force_base_url = "https://api.x.ai/v1"
    elif _bt in ("cli", "cli-chat", "cli-chat-proxy", "cliproxy", "free"):
        force_base_url = DEFAULT_BASE_URL
    elif _bt.startswith("http"):
        force_base_url = str(base_url_target).strip().rstrip("/")
        if force_base_url.endswith("cli-chat-proxy.grok.com"):
            force_base_url = force_base_url + "/v1"
        if force_base_url.endswith("api.x.ai") and not force_base_url.endswith("/v1"):
            force_base_url = force_base_url + "/v1"
    else:
        force_base_url = DEFAULT_BASE_URL
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
                    base_url=force_base_url,
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
                "base_url": force_base_url,
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
            # sso mint 默认写 DEFAULT_BASE_URL；按目标改写 base_url（不改 token）
            try:
                paths = list(r.get("paths") or [])
                if r.get("path"):
                    paths.insert(0, str(r.get("path")))
                if not paths:
                    paths = [str(p)]
                seen = set()
                for fp in paths:
                    fp = str(fp or "").strip()
                    if not fp or fp in seen:
                        continue
                    seen.add(fp)
                    fp_path = Path(fp)
                    if not fp_path.is_file():
                        continue
                    doc = json.loads(fp_path.read_text(encoding="utf-8"))
                    if isinstance(doc, dict):
                        doc["base_url"] = force_base_url
                        tmp = fp_path.with_suffix(fp_path.suffix + ".tmp")
                        tmp.write_text(
                            json.dumps(doc, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8",
                        )
                        os.replace(tmp, fp_path)
                r["base_url"] = force_base_url
                log(f"[auth] mode=sso base_url={force_base_url}")
            except Exception as be:
                log(f"[auth] mode=sso base_url patch skip: {be}")
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
