# -*- coding: utf-8 -*-
"""推送注册成功的 SSO 到 grok2api（Web 导入 + Convert to Build）。

移植自 grok-register-web-master/core/grok2api_client.py，适配本项目 config.json / 设置字段。

流程：
  1. POST /api/admin/v1/auth/login  → accessToken
  2. POST /api/admin/v1/accounts/web/import  (SSE)  → Web 账号
  3. POST /api/admin/v1/accounts/web/convert-to-build  (SSE)  → Build
  可选：更新 egress-nodes（CF cookie + UA）
"""
from __future__ import annotations

import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

LogFn = Callable[[str], None]


class Grok2APIError(RuntimeError):
    pass


def _noop(msg: str) -> None:
    pass


def _decode_jwt_payload(token: str) -> dict:
    try:
        import base64

        segment = token.split(".")[1]
        segment += "=" * (-len(segment) % 4)
        return json.loads(base64.urlsafe_b64decode(segment))
    except Exception:
        return {}


def _post_form(url: str, data: dict, timeout: int = 15) -> dict:
    payload = urllib.parse.urlencode(data).encode()
    request = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")[:300]
        raise Grok2APIError(f"{url} returned HTTP {exc.code}: {body}") from exc


def _poll_token(device_code: str, interval: int, expires_in: int, timeout: int = 60) -> dict:
    deadline = time.time() + min(int(expires_in), timeout)
    while time.time() < deadline:
        time.sleep(interval)
        try:
            return _post_form(
                "https://auth.x.ai/oauth2/token",
                {
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                    "client_id": "b1a00492-073a-47ea-816f-4c329264a828",
                    "device_code": device_code,
                },
            )
        except Grok2APIError as exc:
            message = str(exc)
            if "authorization_pending" in message:
                continue
            if "slow_down" in message:
                interval += 5
                continue
            raise
    raise Grok2APIError("Device Flow token polling timed out")


def sso_to_build_credential(sso_cookie: str, email: str = "") -> dict[str, Any]:
    """Device Flow：SSO → Grok Build credential（本地换 token，不依赖 grok2api 的 convert）。"""
    from curl_cffi import requests as curl_requests

    CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
    OIDC_ISSUER = "https://auth.x.ai"
    SCOPES = (
        "openid profile email offline_access grok-cli:access "
        "api:access conversations:read conversations:write"
    )
    session = curl_requests.Session()
    session.cookies.set("sso", sso_cookie, domain=".x.ai")
    response = session.get("https://accounts.x.ai/", impersonate="chrome", timeout=15)
    if "sign-in" in response.url or "sign-up" in response.url:
        raise Grok2APIError("SSO cookie is invalid")

    device = _post_form(
        f"{OIDC_ISSUER}/oauth2/device/code",
        {"client_id": CLIENT_ID, "scope": SCOPES},
    )
    verification_url = device.get("verification_uri_complete")
    user_code = device.get("user_code")
    if not verification_url or not user_code or not device.get("device_code"):
        raise Grok2APIError("Device Flow response is incomplete")

    session.get(verification_url, impersonate="chrome", timeout=15)
    response = session.post(
        f"{OIDC_ISSUER}/oauth2/device/verify",
        data={"user_code": user_code},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        impersonate="chrome",
        timeout=15,
        allow_redirects=True,
    )
    if "consent" not in response.url:
        raise Grok2APIError(f"Device verification failed: {response.url}")

    response = session.post(
        f"{OIDC_ISSUER}/oauth2/device/approve",
        data={
            "user_code": user_code,
            "action": "allow",
            "principal_type": "User",
            "principal_id": "",
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        impersonate="chrome",
        timeout=15,
        allow_redirects=True,
    )
    if "done" not in response.url:
        raise Grok2APIError(f"Device approval failed: {response.url}")

    token = _poll_token(
        device["device_code"],
        int(device.get("interval", 5)),
        int(device.get("expires_in", 1800)),
    )
    access_token = token.get("access_token", "")
    refresh_token = token.get("refresh_token", "")
    if not access_token and not refresh_token:
        raise Grok2APIError("Device Flow returned no access or refresh token")

    claims = _decode_jwt_payload(access_token)
    return {
        "provider": "grok_build",
        "name": email or claims.get("email") or claims.get("sub") or "Grok Build account",
        "client_id": CLIENT_ID,
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": token.get("token_type", "Bearer"),
        "expires_in": int(token.get("expires_in", 0)),
        "email": email or claims.get("email", ""),
        "user_id": claims.get("sub") or claims.get("principal_id", ""),
        "principal_id": claims.get("principal_id", ""),
        "team_id": claims.get("team_id", ""),
    }


class Grok2APIClient:
    def __init__(
        self,
        base_url: str,
        username: str,
        password: str,
        timeout: int = 30,
    ):
        import requests

        self.base_url = base_url.rstrip("/")
        self.username = username
        self.password = password
        self.timeout = timeout
        self.session = requests.Session()

    def _login(self) -> str:
        response = self.session.post(
            f"{self.base_url}/api/admin/v1/auth/login",
            json={"username": self.username, "password": self.password},
            timeout=self.timeout,
        )
        if response.status_code != 200:
            raise Grok2APIError(f"grok2api login failed: HTTP {response.status_code}")
        payload = response.json()
        token = payload.get("data", {}).get("tokens", {}).get("accessToken")
        if not token:
            raise Grok2APIError("grok2api login response has no access token")
        return token

    def _run_sse_task(
        self,
        path: str,
        json_body: dict | None = None,
        files=None,
        result_event: str = "complete",
    ) -> dict:
        token = self._login()
        response = self.session.post(
            f"{self.base_url}{path}",
            headers={"Authorization": f"Bearer {token}", "Accept": "text/event-stream"},
            files=files,
            json=json_body,
            timeout=max(self.timeout, 120),
        )
        if response.status_code != 200:
            raise Grok2APIError(f"grok2api task failed: HTTP {response.status_code}")
        result = None
        for block in response.text.replace("\r\n", "\n").split("\n\n"):
            event = ""
            data = ""
            for line in block.splitlines():
                if line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    data += line[5:].strip()
            if not data:
                continue
            payload = json.loads(data)
            if event == "error":
                raise Grok2APIError(
                    payload.get("message") or payload.get("code") or "grok2api task failed"
                )
            if event == result_event:
                result = payload
        if result is None:
            raise Grok2APIError("grok2api task returned no completion event")
        return result

    def import_build_credential(self, credential: dict) -> dict:
        token = self._login()
        document = json.dumps({"accounts": [credential]}, ensure_ascii=False).encode()
        response = self.session.post(
            f"{self.base_url}/api/admin/v1/accounts/import",
            headers={"Authorization": f"Bearer {token}", "Accept": "text/event-stream"},
            files={"file": ("grok-build-account.json", document, "application/json")},
            timeout=max(self.timeout, 120),
        )
        if response.status_code != 200:
            raise Grok2APIError(f"grok2api import failed: HTTP {response.status_code}")
        result = None
        for block in response.text.replace("\r\n", "\n").split("\n\n"):
            event = ""
            data = ""
            for line in block.splitlines():
                if line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    data += line[5:].strip()
            if not data:
                continue
            payload = json.loads(data)
            if event == "error":
                raise Grok2APIError(
                    payload.get("message") or payload.get("code") or "grok2api import failed"
                )
            if event == "complete":
                result = payload
        if result is None:
            raise Grok2APIError("grok2api import returned no completion event")
        return result

    def import_web_sso_and_convert(self, sso_cookie: str, email: str = "") -> dict[str, Any]:
        token = self._login()
        account_name = (email or "").strip() or f"Grok Web {secrets.token_hex(4)}"
        document = json.dumps(
            {
                "provider": "grok_web",
                "accounts": [
                    {
                        "name": account_name,
                        "sso_token": sso_cookie.strip(),
                        "tier": "auto",
                    }
                ],
            },
            ensure_ascii=False,
        ).encode()
        response = self.session.post(
            f"{self.base_url}/api/admin/v1/accounts/web/import",
            headers={"Authorization": f"Bearer {token}", "Accept": "text/event-stream"},
            files={"file": ("registered-web-account.json", document, "application/json")},
            timeout=max(self.timeout, 120),
        )
        if response.status_code != 200:
            raise Grok2APIError(f"grok2api web import failed: HTTP {response.status_code}")
        imported = None
        for block in response.text.replace("\r\n", "\n").split("\n\n"):
            event = ""
            data = ""
            for line in block.splitlines():
                if line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    data += line[5:].strip()
            if not data:
                continue
            payload = json.loads(data)
            if event == "error":
                raise Grok2APIError(
                    payload.get("message")
                    or payload.get("code")
                    or "grok2api web import failed"
                )
            if event == "complete":
                imported = payload
        if imported is None:
            raise Grok2APIError("grok2api web import returned no completion event")

        lookup = self.session.get(
            f"{self.base_url}/api/admin/v1/accounts",
            headers={"Authorization": f"Bearer {token}"},
            params={"provider": "grok_web", "search": account_name, "page": 1, "pageSize": 20},
            timeout=self.timeout,
        )
        if lookup.status_code != 200:
            raise Grok2APIError(f"grok2api account lookup failed: HTTP {lookup.status_code}")
        payload = lookup.json().get("data", {})
        items = payload.get("items") or payload.get("data") or []
        account = next((item for item in items if item.get("name") == account_name), None)
        if not account or not account.get("id"):
            raise Grok2APIError(f"grok2api could not locate imported Web account {account_name}")

        converted = self._run_sse_task(
            "/api/admin/v1/accounts/web/convert-to-build",
            json_body={"ids": [str(account["id"])]},
        )
        return {"import": imported, "conversion": converted}

    def upsert_web_egress_context(self, user_agent: str, cloudflare_cookies: str) -> dict:
        if not user_agent or not cloudflare_cookies:
            raise Grok2APIError("Web egress context requires User-Agent and Cloudflare cookies")
        token = self._login()
        headers = {"Authorization": f"Bearer {token}"}
        response = self.session.get(
            f"{self.base_url}/api/admin/v1/egress-nodes",
            headers=headers,
            params={"scope": "grok_web", "page": 1, "pageSize": 100},
            timeout=self.timeout,
        )
        if response.status_code != 200:
            raise Grok2APIError(f"grok2api egress lookup failed: HTTP {response.status_code}")
        data = response.json().get("data", {})
        items = data.get("items") or data.get("data") or []
        existing = next((item for item in items if item.get("name") == "grok-register-web"), None)
        body = {
            "name": "grok-register-web",
            "scope": "grok_web",
            "enabled": True,
            "userAgent": user_agent,
            "cloudflareCookies": cloudflare_cookies,
        }
        if existing:
            url = f"{self.base_url}/api/admin/v1/egress-nodes/{existing['id']}"
            result = self.session.put(url, headers=headers, json=body, timeout=self.timeout)
        else:
            url = f"{self.base_url}/api/admin/v1/egress-nodes"
            body["proxyURL"] = ""
            result = self.session.post(url, headers=headers, json=body, timeout=self.timeout)
        if result.status_code not in (200, 201):
            raise Grok2APIError(f"grok2api egress update failed: HTTP {result.status_code}")
        return result.json().get("data", {})


def upload_registered_sso(
    settings: dict[str, Any],
    sso_cookie: str,
    email: str = "",
    user_agent: str = "",
    cloudflare_cookies: str = "",
    log: LogFn | None = None,
) -> dict[str, Any] | None:
    """按 settings 决定是否上传；返回 import/conversion 结果或 None（未启用）。"""
    log = log or _noop
    # 兼容：push_sso / push_auth / grok2api_auto_upload
    def _truthy(v: Any) -> bool:
        if v is True:
            return True
        if v is False or v is None:
            return False
        return str(v).lower() in ("1", "true", "yes", "on")

    push_sso = settings.get("push_sso_to_grok2api")
    if push_sso is None:
        push_sso = settings.get("pushSsoToGrok2api")
    push_auth = settings.get("push_auth_to_grok2api")
    if push_auth is None:
        push_auth = settings.get("pushAuthToGrok2api")
    auto = settings.get("grok2api_auto_upload")
    if auto is None:
        auto = settings.get("grok2apiAutoUpload")
    # SSO 或 Auth 任一目标开，或旧 auto_upload
    if not (_truthy(push_sso) or _truthy(push_auth) or _truthy(auto)):
        return None

    base_url = str(
        settings.get("grok2api_url") or settings.get("grok2apiUrl") or ""
    ).strip()
    username = str(
        settings.get("grok2api_username") or settings.get("grok2apiUsername") or ""
    ).strip()
    password = str(
        settings.get("grok2api_password") or settings.get("grok2apiPassword") or ""
    )
    if not base_url or not username or not password:
        raise Grok2APIError(
            "grok2api auto upload is enabled but URL/username/password is incomplete"
        )

    client = Grok2APIClient(base_url, username, password)
    if user_agent and cloudflare_cookies:
        log("[grok2api] Updating Web egress Cloudflare context...")
        try:
            client.upsert_web_egress_context(user_agent, cloudflare_cookies)
        except Exception as e:
            log(f"[grok2api] egress update skipped: {e}")

    # 固定 web_convert（UI 已移除上传模式；与 grok-register-web 一致）
    mode = "web_convert"
    log(f"[grok2api] Uploading SSO mode={mode} email={email or '-'}")
    result = client.import_web_sso_and_convert(sso_cookie, email=email)
    result["mode"] = "web_convert"
    return result


def load_grok2api_settings_from_config(config_path: str | None = None) -> dict[str, Any]:
    """从 register/config.json 读取 grok2api 段。"""
    import os
    from pathlib import Path

    if not config_path:
        config_path = os.path.join(os.path.dirname(__file__), "config.json")
    p = Path(config_path)
    if not p.is_file():
        return {}
    try:
        conf = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}
    # 扁平或嵌套
    g = conf.get("grok2api") if isinstance(conf.get("grok2api"), dict) else {}
    out = dict(g) if g else {}
    for k in (
        "grok2api_auto_upload",
        "grok2api_url",
        "grok2api_username",
        "grok2api_password",
        "grok2api_upload_mode",
    ):
        if k in conf and k not in out:
            out[k] = conf[k]
    return out
