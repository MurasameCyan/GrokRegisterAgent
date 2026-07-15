#!/usr/bin/env python3
"""
SSO cookie → CPA / grok auth.json（Authorization Code + PKCE）

对齐 grokRegister-cpa-main/sso_to_auth_json.py：
- authorize 注入 referrer=grok-build + plan=generic
- consent 提交带 referrer=grok-build
- 写出 CLIProxyAPI 扁平 xai-*.json（base_url=cli-chat-proxy.grok.com）
- headers 含 x-authenticateresponse，最新 CPA 关闭 using_api 即可用

用法:
  python3 sso_to_auth.py --sso sso_list.txt --cpa-auth-dir ./auth_out
  python3 sso_to_auth.py --sso-cookie 'eyJ...' --cpa-remote-url http://host:8317 --cpa-management-key KEY
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from curl_cffi import requests

from cpa_schema import (
    CLIENT_ID,
    DEFAULT_BASE_URL as CPA_GROK_BASE_URL,
    DEFAULT_CLIENT_HEADERS,
    DEFAULT_REDIRECT_URI as REDIRECT_URI,
    DEFAULT_TOKEN_ENDPOINT as CPA_TOKEN_ENDPOINT,
    GROK_CLIENT_VERSION as GROK_VERSION,
    GROK_PLAN,
    GROK_REFERRER,
    ISSUER as OIDC_ISSUER,
)

AUTH_KEY = f"{OIDC_ISSUER}::{CLIENT_ID}"
# 与当前可用号 JWT scope 对齐（含 conversations:*）
SCOPES = (
    "openid profile email offline_access grok-cli:access "
    "api:access conversations:read conversations:write"
)

GROK_TOKEN_UA = (
    f"grok-pager/{GROK_VERSION} grok-shell/{GROK_VERSION} (linux; x86_64)"
)
# consent 提交用的 Next.js Server Action ID（会随前端部署变化；运行时从 HTML 发现）
NEXT_ACTION_ID = "4005315a1d7e426de592990bb54bb37471f39dd6d2"
_NEXT_ACTION_RE = re.compile(
    r'createServerReference\)\("([a-f0-9]{40,44})"[^)]*submitOAuth2Consent',
    re.I,
)
_NEXT_ACTION_RE2 = re.compile(
    r'createServerReference\)\("([a-f0-9]{40,44})"',
    re.I,
)
_NEXT_ACTION_RE3 = re.compile(
    r'next-action["\'\s:=]+([a-f0-9]{40,})',
    re.I,
)

CPA_GROK_HEADERS = dict(DEFAULT_CLIENT_HEADERS)
CPA_PROBE_MODEL = "grok-4.5"
CPA_PROBE_URL = f"{CPA_GROK_BASE_URL}/responses"


def b64url_decode(seg: str) -> bytes:
    seg += "=" * (-len(seg) % 4)
    return base64.urlsafe_b64decode(seg)


def decode_jwt_payload(token: str) -> dict:
    try:
        return json.loads(b64url_decode(token.split(".")[1]))
    except Exception:
        return {}


def _pick_bot_flag_from_payload(pl: dict) -> Any:
    """从 JWT payload 取 bot_flag 类 claim；0 是合法 None。"""
    if not isinstance(pl, dict):
        return None
    for k in (
        "bot_flag_source",
        "botFlagSource",
        "bot_flag",
        "botFlag",
        "bot_flag_src",
    ):
        if k not in pl:
            continue
        v = pl.get(k)
        if v is None or v == "":
            continue
        if isinstance(v, str) and v.strip().lower() == "none":
            return 0
        if v == 0 or v == "0":
            return 0
        try:
            if isinstance(v, str) and v.strip().isdigit():
                return int(v.strip())
        except Exception:
            pass
        return v
    return None


def extract_bot_flag_source(
    access: str = "",
    sso: str = "",
    id_token: str = "",
) -> Any:
    """优先 access → sso → id_token；返回 claim 值（含 0）或 None（无 claim）。"""
    for tok in (access, sso, id_token):
        t = str(tok or "").strip()
        if t.lower().startswith("sso="):
            t = t[4:].strip()
        if not t or t.count(".") < 2:
            continue
        pl = decode_jwt_payload(t)
        raw = _pick_bot_flag_from_payload(pl)
        if raw is not None:
            return raw
    return None


def rfc3339_ns(ts: float | None = None) -> str:
    """2026-07-10T01:00:00.000000000Z"""
    if ts is None:
        ts = time.time()
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + ".000000000Z"


def _urlopen(req, proxy: str = "", timeout: int = 15):
    """urllib 请求，proxy 非空时走代理。"""
    if proxy:
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": proxy, "https": proxy})
        )
        return opener.open(req, timeout=timeout)
    return urllib.request.urlopen(req, timeout=timeout)


def _gen_pkce() -> tuple[str, str, str, str]:
    """生成 (code_verifier, code_challenge, state, nonce)。"""
    verifier = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).rstrip(b"=").decode()
    state = base64.urlsafe_b64encode(os.urandom(16)).rstrip(b"=").decode()
    nonce = base64.urlsafe_b64encode(os.urandom(16)).rstrip(b"=").decode()
    return verifier, challenge, state, nonce


def _parse_consent_code(body: str) -> str | None:
    """从 consent 提交的 text/x-component 响应里解析出 authorization code。"""
    text = body or ""
    for line in text.split("\n"):
        start = line.find("{")
        if start < 0:
            continue
        try:
            data = json.loads(line[start:])
        except Exception:
            continue
        if isinstance(data, dict) and data.get("code"):
            if data.get("success") is False:
                return None
            return data.get("code")
    m = re.search(r'"code"\s*:\s*"([^"]+)"', text)
    if m:
        return m.group(1)
    m = re.search(r"code=([A-Za-z0-9._~\-]+)", text)
    if m and "error" not in m.group(0).lower():
        return m.group(1)
    return None


def _discover_next_action(
    html: str,
    fallback: str = NEXT_ACTION_ID,
    *,
    session: Any = None,
) -> str:
    """从 consent 页 HTML/JS chunk 发现 submitOAuth2Consent 的 action id。"""
    html = html or ""
    for rx in (_NEXT_ACTION_RE, _NEXT_ACTION_RE2, _NEXT_ACTION_RE3):
        m = rx.search(html)
        if m:
            return m.group(1)
    # 尝试拉取页面引用的 next static chunk（action id 常在 JS 里）
    if session is not None:
        try:
            for m in re.finditer(
                r'src=["\']([^"\']+_next/static/chunks/[^"\']+\.js)["\']',
                html,
                re.I,
            ):
                src = m.group(1)
                if src.startswith("/"):
                    src = "https://accounts.x.ai" + src
                if not src.startswith("http"):
                    continue
                try:
                    jr = session.get(src, impersonate="chrome", timeout=12)
                    body = str(jr.text or "")
                    for rx in (_NEXT_ACTION_RE, _NEXT_ACTION_RE2):
                        mm = rx.search(body)
                        if mm:
                            return mm.group(1)
                except Exception:
                    continue
        except Exception:
            pass
    return fallback


def access_token_referrer(access_token: str) -> str:
    """返回 access_token JWT 里的 referrer claim（没有则空串）。"""
    return (decode_jwt_payload(access_token).get("referrer") or "").strip()


def sso_to_token(sso_cookie: str, proxy: str = "", log=print) -> dict | None:
    """SSO cookie → token dict (access/refresh/expires_in)。

    使用授权码流程（Authorization Code + PKCE）：
    authorize 注入 referrer=grok-build + plan=generic，
    consent 提交同样带 referrer=grok-build。proxy 非空时全程走代理。

    为何不用 Device Flow：早期 device flow 换的 token 常无 referrer claim，
    cli-chat-proxy 会 permission-denied；authorize/consent 注入是稳定路径。
    """
    proxies = {"http": proxy, "https": proxy} if proxy else None
    s = requests.Session()
    if proxies:
        s.proxies = proxies
    # accounts.x.ai / auth.x.ai 都要带 sso（与 grok-build 授权码流程一致）
    for domain in (".x.ai", "accounts.x.ai", "auth.x.ai"):
        s.cookies.set("sso", sso_cookie, domain=domain)
        s.cookies.set("sso-rw", sso_cookie, domain=domain)

    try:
        r = s.get("https://accounts.x.ai/", impersonate="chrome", timeout=15)
    except Exception as e:
        log(f"  ❌ 网络错误: {e}")
        return None
    if "sign-in" in r.url or "sign-up" in r.url:
        log("  ❌ sso 无效")
        return None
    log("  ✅ sso 有效")

    verifier, challenge, state, nonce = _gen_pkce()

    # 1) 打开 authorize 页，跟随重定向进入 consent
    log(f"  🔑 Authorization Code Flow (referrer={GROK_REFERRER}, plan={GROK_PLAN})...")
    authorize_params = urllib.parse.urlencode(
        {
            "client_id": CLIENT_ID,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "nonce": nonce,
            "plan": GROK_PLAN,
            "redirect_uri": REDIRECT_URI,
            "referrer": GROK_REFERRER,
            "response_type": "code",
            "scope": SCOPES,
            "state": state,
        }
    )
    try:
        r = s.get(
            f"{OIDC_ISSUER}/oauth2/authorize?{authorize_params}",
            impersonate="chrome",
            timeout=15,
            allow_redirects=True,
        )
    except Exception as e:
        log(f"  ❌ authorize 异常: {e}")
        return None
    final_url = str(r.url)
    if "sign-in" in final_url or "sign-up" in final_url:
        log("  ❌ sso 无效")
        return None
    if "/oauth2/consent" not in final_url:
        log(f"  ❌ authorize 未进入 consent: {final_url}")
        return None

    # 2) 提交 consent（allow），拿 authorization code
    # 固定 Next-Action 会随 x.ai 前端部署失效 → 404 Server action not found
    page_html = ""
    try:
        page_html = str(getattr(r, "text", None) or "")
    except Exception:
        page_html = ""
    action_id = _discover_next_action(page_html, NEXT_ACTION_ID)
    if action_id != NEXT_ACTION_ID:
        log(f"  🔑 consent next-action discovered={action_id[:16]}…")
    else:
        log(f"  🔑 consent next-action fallback={action_id[:16]}…")

    router_tree = (
        '["",{"children":["(app)",{"children":["(auth)",{"children":["oauth2",'
        '{"children":["consent",{"children":["__PAGE__",{}]}]}]}]}]},'
        '"$undefined","$undefined",16]'
    )
    consent_payload = json.dumps(
        [
            {
                "action": "allow",
                "clientId": CLIENT_ID,
                "redirectUri": REDIRECT_URI,
                "scope": SCOPES,
                "state": state,
                "codeChallenge": challenge,
                "codeChallengeMethod": "S256",
                "nonce": nonce,
                "principalType": "User",
                "principalId": "",
                "referrer": GROK_REFERRER,
            }
        ],
        separators=(",", ":"),
    )
    consent_headers = {
        "Content-Type": "text/plain;charset=UTF-8",
        "Accept": "text/x-component",
        "Origin": "https://accounts.x.ai",
        "Referer": final_url,
        "Next-Action": action_id,
        "next-action": action_id,
        "next-router-state-tree": urllib.parse.quote(router_tree, safe=""),
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
    }
    try:
        r = s.post(
            final_url,
            data=consent_payload,
            headers=consent_headers,
            impersonate="chrome",
            timeout=20,
            allow_redirects=True,
        )
        # 404 Server action not found：再拉一次 consent HTML 重新发现 action
        if r.status_code == 404 or "Server action not found" in str(r.text or ""):
            log("  ⚠ consent action 失效，重新抓取 consent 页…")
            try:
                r2 = s.get(final_url, impersonate="chrome", timeout=15, allow_redirects=True)
                action_id = _discover_next_action(
                    str(r2.text or ""), action_id, session=s
                )
                consent_headers["Next-Action"] = action_id
                consent_headers["next-action"] = action_id
                log(f"  🔑 retry next-action={action_id[:16]}…")
                r = s.post(
                    final_url,
                    data=consent_payload,
                    headers=consent_headers,
                    impersonate="chrome",
                    timeout=20,
                    allow_redirects=True,
                )
            except Exception as e2:
                log(f"  ❌ consent 重试异常: {e2}")
                return None
    except Exception as e:
        log(f"  ❌ consent 异常: {e}")
        return None
    if r.status_code < 200 or r.status_code >= 300:
        log(f"  ❌ consent HTTP {r.status_code}: {str(r.text)[:200]}")
        return None
    code = _parse_consent_code(str(r.text))
    if not code:
        # 重定向 Location 里带 code
        loc = ""
        try:
            loc = str(r.headers.get("location") or r.headers.get("Location") or "")
        except Exception:
            pass
        if "code=" in loc:
            code = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query).get("code", [None])[0]
        if not code and "code=" in str(r.url):
            code = urllib.parse.parse_qs(urllib.parse.urlparse(str(r.url)).query).get(
                "code", [None]
            )[0]
    if not code:
        log(f"  ❌ consent 未返回 code: {str(r.text)[:200]}")
        return None
    log("  ✅ 授权确认")

    # 3) 用 authorization code 换 token
    token_data = urllib.parse.urlencode(
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT_URI,
            "client_id": CLIENT_ID,
            "code_verifier": verifier,
        }
    )
    try:
        r = s.post(
            f"{OIDC_ISSUER}/oauth2/token",
            data=token_data,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": GROK_TOKEN_UA,
                "X-Grok-Client-Version": GROK_VERSION,
                "Accept": "*/*",
            },
            impersonate="chrome",
            timeout=15,
        )
    except Exception as e:
        log(f"  ❌ token 异常: {e}")
        return None
    if r.status_code < 200 or r.status_code >= 300:
        log(f"  ❌ token HTTP {r.status_code}: {str(r.text)[:200]}")
        return None
    try:
        token = r.json()
    except Exception:
        log(f"  ❌ token 返回非 JSON: {str(r.text)[:200]}")
        return None
    if not token.get("access_token"):
        log(f"  ❌ token 缺少 access_token: {token}")
        return None
    if not token.get("expires_in"):
        token["expires_in"] = 21600
    if not token.get("token_type"):
        token["token_type"] = "Bearer"

    # 校验 referrer claim
    ap = decode_jwt_payload(token["access_token"])
    ref = ap.get("referrer")
    if ref not in (GROK_REFERRER, "grok-build", "cli-proxy-api"):
        log(f"  ⚠️ access_token referrer={ref!r}（预期 {GROK_REFERRER!r} 或 grok-build）")
    else:
        log(f"  ✅ access_token referrer={ref!r}")
    log(
        f"  ✅ access_token (expires_in={token.get('expires_in')}s)"
        + (" + refresh_token" if token.get("refresh_token") else "")
    )
    return token


def token_to_auth_entry(token: dict, email: str = "") -> tuple[str, dict]:
    """
    返回 (top_level_key, entry)
    top_level_key 固定为 issuer::client_id（与 ~/.grok/auth.json 一致）
    """
    access = token.get("access_token") or token.get("key") or ""
    refresh = token.get("refresh_token") or ""
    payload = decode_jwt_payload(access)

    user_id = payload.get("sub") or payload.get("principal_id") or ""
    principal_id = payload.get("principal_id") or user_id
    principal_type = payload.get("principal_type") or "User"

    expires_in = int(token.get("expires_in") or 21600)
    if "exp" in payload:
        expires_at = rfc3339_ns(float(payload["exp"]))
    else:
        expires_at = rfc3339_ns(time.time() + expires_in)

    iat = payload.get("iat")
    create_time = rfc3339_ns(float(iat) if iat else time.time())

    entry = {
        "key": access,
        "auth_mode": "oidc",
        "create_time": create_time,
        "user_id": user_id,
        "email": email or "",
        "principal_type": principal_type,
        "principal_id": principal_id,
        "refresh_token": refresh,
        "expires_at": expires_at,
        "oidc_issuer": OIDC_ISSUER,
        "oidc_client_id": CLIENT_ID,
    }
    return AUTH_KEY, entry


def _iso_utc_from_unix(ts) -> str:
    """unix 秒 → CPA 认的 RFC3339（秒级，带 Z）。"""
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return ""


def _safe_email_for_filename(email: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in "._-@" else "_" for ch in email)
    return safe or "unknown"


def token_to_cpa_record(
    token: dict,
    email: str = "",
    headers: dict | None = None,
    sso: str = "",
) -> dict:
    """token dict → CLIProxyAPI 扁平 xai auth 记录。

    对齐 CPA TokenStorage + grokRegister-cpa-main token_to_cpa_record。
    """
    access = token.get("access_token") or token.get("key") or ""
    refresh = token.get("refresh_token") or ""
    id_token = token.get("id_token") or ""
    payload = decode_jwt_payload(access)
    id_payload = decode_jwt_payload(id_token) if id_token else {}

    if not email:
        email = id_payload.get("email") or payload.get("email") or ""
    sub = payload.get("sub") or id_payload.get("sub") or ""

    expired = ""
    expires_in = token.get("expires_in", None)
    if "exp" in payload:
        expired = _iso_utc_from_unix(payload["exp"])
        if expires_in is None and payload.get("iat") is not None:
            try:
                expires_in = max(int(payload["exp"]) - int(payload["iat"]), 0)
            except Exception:
                expires_in = 21600
    elif token.get("expires_in") is not None:
        try:
            expires_in = int(token["expires_in"])
            expired = _iso_utc_from_unix(int(time.time()) + expires_in)
        except Exception:
            expired = ""

    hdrs = dict(headers) if headers else dict(CPA_GROK_HEADERS)
    # 确保最新 CPA 关键头存在
    for k, v in DEFAULT_CLIENT_HEADERS.items():
        hdrs.setdefault(k, v)

    entry = {
        "type": "xai",
        "auth_kind": "oauth",
        "email": (email or "").strip(),
        "sub": (sub or "").strip(),
        "access_token": access,
        "refresh_token": refresh,
        "token_type": token.get("token_type", "Bearer"),
        "expires_in": expires_in,
        "expired": expired,
        "last_refresh": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "redirect_uri": REDIRECT_URI,
        "token_endpoint": CPA_TOKEN_ENDPOINT,
        "base_url": CPA_GROK_BASE_URL,
        "disabled": False,
        "headers": hdrs,
    }
    if id_token:
        entry["id_token"] = id_token.strip()
    # 强制写入 sso（号池无邮箱时靠 SSO SHA-256 匹配「已转 Auth」）
    sso_val = str(sso or "").strip()
    if sso_val.lower().startswith("sso="):
        sso_val = sso_val[4:].strip()
    if sso_val:
        entry["sso"] = sso_val
    # 侧车 bot_flag_source：列表优先读字段（0=None 合法）。
    # JWT 无 claim 时默认写 0，避免 Auth 列表永远显示 —
    flag = extract_bot_flag_source(access, sso_val, id_token.strip() if id_token else "")
    if flag is not None:
        entry["bot_flag_source"] = flag
    elif sso_val or access:
        entry["bot_flag_source"] = 0
    return entry


def cpa_auth_filename(record: dict, *, channel: str = "") -> str:
    """生成 CPA auth 文件名：xai-<email>.json；double 模式可带通道后缀。

    channel 例：pkce / device → xai-user_at_x.com-pkce.json
    """
    ident = str(record.get("email") or "").strip() or str(record.get("sub") or "").strip()
    safe = _safe_email_for_filename(ident)
    fname = safe if safe.lower().startswith("xai") else f"xai-{safe}"
    ch = str(channel or record.get("mint_channel") or "").strip().lower()
    # 仅允许安全后缀，避免路径注入
    if ch and ch.replace("_", "").replace("-", "").isalnum():
        fname = f"{fname}-{ch}"
    return f"{fname}.json"


def write_cpa_auth(auth_dir: Path, record: dict, *, channel: str = "") -> Path:
    """写出 CPA 可热加载的 xai-<email>[-channel].json（原子替换）。"""
    auth_dir.mkdir(parents=True, exist_ok=True)
    path = auth_dir / cpa_auth_filename(record, channel=channel)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return path


def upload_cpa_auth_remote(
    base_url: str,
    management_key: str,
    record: dict,
    timeout: int = 30,
    retries: int = 3,
    retry_backoff_sec: float = 1.5,
) -> str:
    """通过 CPA Management API 上传 auth 文件到远程实例。

    POST /v0/management/auth-files?name=<file.json>
    Header: Authorization: Bearer <management_key>
    Body: raw JSON auth record

    retries: 网络/5xx 重试次数（默认 3）；4xx 除 408/429 外不重试。
    timeout / retries 可被 config.json: cpa_remote_timeout / cpa_remote_retries 覆盖。
    """
    import time
    from pathlib import Path as _Path
    import requests as _requests

    base = str(base_url or "").strip().rstrip("/")
    key = str(management_key or "").strip()
    if not base:
        raise ValueError("cpa_remote_url 为空")
    if not key:
        raise ValueError("cpa_management_key 为空")
    # 去掉误带的 /v1
    if base.endswith("/v1"):
        base = base[:-3].rstrip("/")

    # 配置覆盖
    conf_path = _Path(__file__).resolve().parent / "config.json"
    try:
        conf = json.loads(conf_path.read_text(encoding="utf-8"))
        if conf.get("cpa_remote_timeout") is not None:
            timeout = int(conf.get("cpa_remote_timeout") or timeout)
        if conf.get("cpa_remote_retries") is not None:
            retries = int(conf.get("cpa_remote_retries") or retries)
        if conf.get("cpa_remote_retry_backoff_sec") is not None:
            retry_backoff_sec = float(
                conf.get("cpa_remote_retry_backoff_sec") or retry_backoff_sec
            )
    except Exception:
        pass
    timeout = max(5, min(int(timeout or 30), 180))
    retries = max(1, min(int(retries or 3), 8))
    retry_backoff_sec = max(0.2, min(float(retry_backoff_sec or 1.5), 30.0))

    name = cpa_auth_filename(record)
    url = f"{base}/v0/management/auth-files"
    body_bytes = json.dumps(record, ensure_ascii=False).encode("utf-8")
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            resp = _requests.post(
                url,
                params={"name": name},
                headers={
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                },
                data=body_bytes,
                timeout=timeout,
            )
            if resp.status_code < 400:
                return name
            body = (resp.text or "").strip()
            if len(body) > 300:
                body = body[:300] + "..."
            code = int(resp.status_code or 0)
            # 4xx 除 408/429 不重试
            if 400 <= code < 500 and code not in (408, 429):
                raise RuntimeError(
                    f"远程上传失败 HTTP {code}: {body or resp.reason}"
                )
            last_err = RuntimeError(
                f"远程上传失败 HTTP {code}: {body or resp.reason}"
            )
        except RuntimeError:
            raise
        except Exception as e:
            last_err = e
        if attempt < retries:
            time.sleep(retry_backoff_sec * attempt)
    raise RuntimeError(
        f"远程上传失败（已重试 {retries} 次）: {last_err}"
    )


def write_auth_json(path: Path, auth_key: str, entry: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {auth_key: entry}
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def merge_auth_json(path: Path, auth_key: str, entry: dict, unique: bool = True) -> None:
    """合并写入。unique=True 时 key 变成 issuer::client_id::user_id。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    existing: dict = {}
    if path.exists():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            existing = {}
    key = auth_key
    if unique and entry.get("user_id"):
        key = f"{auth_key}::{entry['user_id']}"
    existing[key] = entry
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(existing, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def load_sso_list(path: str | None, single: str | None) -> list[str]:
    if single:
        return [single.strip()]
    if not path:
        return []
    out = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "----" in line:
            parts = line.split("----")
            line = parts[-1].strip()
        out.append(line)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(
        description="SSO cookie → CPA xai auth (Authorization Code + PKCE)"
    )
    ap.add_argument("--sso", metavar="FILE", help="sso 列表文件")
    ap.add_argument("--sso-cookie", metavar="JWT", help="单个 sso cookie")
    ap.add_argument("--out", default=None, help="输出 auth.json 路径（单账号或 --merge）")
    ap.add_argument(
        "--out-dir",
        default=None,
        help="批量时每个账号写一个 {user_id}.json",
    )
    ap.add_argument("--merge", action="store_true", help="合并到 --out")
    ap.add_argument("--delay", type=int, default=0, help="每个间隔秒数")
    ap.add_argument("--email", default="", help="写入 entry.email（可选）")
    ap.add_argument(
        "--cpa-auth-dir",
        default=None,
        help="写出 CLIProxyAPI 扁平格式 xai-<email>.json 到该目录",
    )
    ap.add_argument(
        "--cpa-remote-url",
        default=None,
        help="远程 CPA 地址，如 http://host:8317",
    )
    ap.add_argument(
        "--cpa-management-key",
        default=None,
        help="远程 CPA 管理密钥（remote-management.secret-key 明文）",
    )
    ap.add_argument("--proxy", default="", help="授权码流程走代理")
    args = ap.parse_args()

    cookies = load_sso_list(args.sso, args.sso_cookie)
    if not cookies:
        ap.error("需要 --sso 或 --sso-cookie")

    if args.cpa_remote_url and not args.cpa_management_key:
        ap.error("使用 --cpa-remote-url 时必须同时提供 --cpa-management-key")
    if args.cpa_management_key and not args.cpa_remote_url:
        ap.error("使用 --cpa-management-key 时必须同时提供 --cpa-remote-url")

    if len(cookies) > 1 and not args.out_dir and not args.merge:
        args.out_dir = args.out_dir or "./auth_out"
        print(f"批量模式默认 --out-dir {args.out_dir}")

    if (
        args.out is None
        and args.out_dir is None
        and not args.cpa_auth_dir
        and not args.cpa_remote_url
        and len(cookies) == 1
    ):
        args.out = str(Path.home() / ".grok" / "auth.json")

    print(f"🚀 SSO → CPA auth (Auth Code+PKCE): {len(cookies)} 个, delay={args.delay}s")
    ok = 0
    fail = 0

    for i, sso in enumerate(cookies, 1):
        print(f"\n{'=' * 60}\n[{i}/{len(cookies)}] ...\n{'=' * 60}")
        try:
            token = sso_to_token(sso, proxy=args.proxy)
            if not token:
                fail += 1
                print(f"  ❌ [{i}] 失败")
                continue
            key, entry = token_to_auth_entry(token, email=args.email)
            uid = entry.get("user_id") or secrets.token_hex(4)

            if args.out_dir:
                p = Path(args.out_dir) / f"{uid}.json"
                write_auth_json(p, key, entry)
                print(f"  💾 {p}")
            if args.out:
                if args.merge or len(cookies) > 1:
                    merge_auth_json(Path(args.out), key, entry, unique=True)
                    print(f"  💾 merge → {args.out}")
                else:
                    write_auth_json(Path(args.out), key, entry)
                    print(f"  💾 {args.out}")

            if args.cpa_auth_dir or args.cpa_remote_url:
                record = token_to_cpa_record(token, email=args.email, sso=sso)
                if args.cpa_auth_dir:
                    cp = write_cpa_auth(Path(args.cpa_auth_dir), record)
                    print(f"  💾 CPA 本地 → {cp}")
                if args.cpa_remote_url:
                    name = upload_cpa_auth_remote(
                        args.cpa_remote_url,
                        args.cpa_management_key,
                        record,
                    )
                    print(f"  💾 CPA 远程 → {args.cpa_remote_url.rstrip('/')}/.../{name}")

            ok += 1
            print(f"  ✅ [{i}] 完成 user_id={uid[:12]}...")
        except Exception as e:
            fail += 1
            print(f"  ❌ [{i}] 异常: {e}")

        if args.delay > 0 and i < len(cookies):
            time.sleep(args.delay)

    print(f"\n{'=' * 60}\n📊 完成: {ok}/{len(cookies)} 成功, {fail} 失败")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
