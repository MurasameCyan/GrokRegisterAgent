"""AuthManagement gRPC-web + Next.js sign-up server action client."""
from __future__ import annotations

import json
import re
import uuid
from urllib.parse import unquote

from .pb_codec import (
    encode_create_email_validation_code,
    encode_verify_email_validation_code,
    encode_validate_password,
    unwrap_grpc_web,
    scan_strings,
)
from .session import ProtocolSession

BASE = "https://accounts.x.ai/auth_mgmt.AuthManagement"
SIGNUP_URL = "https://accounts.x.ai/sign-up?redirect=grok-com"
# Percent-encoded form matches browser capture (next-router-state-tree header)
DEFAULT_ROUTER_STATE = (
    "%5B%22%22%2C%7B%22children%22%3A%5B%22(app)%22%2C%7B%22children%22%3A%5B%22(auth)%22%2C%7B%22children%22%3A%5B%22sign-up%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C16%5D"
)


class AuthManagementClient:
    def __init__(self, session: ProtocolSession):
        self.session = session
        self.next_action: str = ""
        self.router_state_tree: str = DEFAULT_ROUTER_STATE

    def _rpc(self, method: str, body: bytes, timeout: int = 30):
        url = f"{BASE}/{method}"
        resp = self.session.post_bytes(url, body, timeout=timeout)
        raw = resp.content or b""
        payload = unwrap_grpc_web(raw)
        return {
            "status": resp.status_code,
            "headers": dict(resp.headers),
            "raw": raw,
            "payload": payload,
            "strings": scan_strings(payload),
            "cookies": self.session.cookies_dict(),
        }

    def bootstrap_and_discover_action(self, timeout: int = 30) -> dict:
        r = self.session.bootstrap(timeout=timeout)
        html = ""
        try:
            html = r.text or ""
        except Exception:
            html = ""
        for pat in [
            r'next-action["\']?\s*[:=]\s*["\']([a-f0-9]{40,})["\']',
            r'createUserAndSession[^"]{0,120}([a-f0-9]{40,})',
            r'createServerReference\)?\([\'"]([a-f0-9]{40,})[\'"]',
        ]:
            m2 = re.search(pat, html, re.I)
            if m2:
                self.next_action = m2.group(1)
                break
        if not self.next_action and html:
            found = self.discover_next_action_from_html(html, timeout=timeout)
            if found:
                self.next_action = found
        return {
            "status": r.status_code,
            "cookies": self.session.cookies_dict(),
            "next_action": self.next_action,
            "html_len": len(html),
        }

    def discover_next_action_from_html(self, html: str, timeout: int = 30) -> str:
        """Scan Next.js chunks for createServerReference(hash) of sign-up submit only."""
        chunks = re.findall(r"/_next/static/chunks/[^\"']+\.js", html or "")
        # Must contain signup submit markers — avoid picking unrelated server actions.
        must_any = ("emailValidationCode", "createUserAndSessionRequest", "castleRequestToken")
        best = ""
        for c in chunks:
            url = c if c.startswith("http") else ("https://accounts.x.ai" + c)
            try:
                r = self.session.get(url, timeout=min(20, timeout))
                text = (r.text or "") if r is not None else ""
            except Exception:
                continue
            if not text or not any(k in text for k in must_any):
                continue
            # Prefer createServerReference in the same chunk as signup payload fields.
            m = re.search(
                r"createServerReference\)?\([\'\"]([a-f0-9]{40,})[\'\"]",
                text,
            )
            if m:
                return m.group(1)
            # Hash near emailValidationCode / createUserAndSessionRequest
            for key in ("emailValidationCode", "createUserAndSessionRequest"):
                idx = text.find(key)
                if idx < 0:
                    continue
                window = text[max(0, idx - 400) : idx + 400]
                m2 = re.search(
                    r"createServerReference\)?\([\'\"]([a-f0-9]{40,})[\'\"]",
                    window,
                )
                if m2:
                    return m2.group(1)
                m3 = re.search(r"[\'\"]([a-f0-9]{40,64})[\'\"]", window)
                if m3 and not best:
                    best = m3.group(1)
        return best

    def discover_next_action(self, timeout: int = 45) -> str:
        """Bootstrap page + chunk scan; caches on self.next_action."""
        if self.next_action:
            return self.next_action
        info = self.bootstrap_and_discover_action(timeout=timeout)
        return str(info.get("next_action") or self.next_action or "")

    def create_email_validation_code(self, email: str, castle_token: str, timeout: int = 30):
        body = encode_create_email_validation_code(email, castle_token)
        return self._rpc("CreateEmailValidationCode", body, timeout=timeout)

    def verify_email_validation_code(self, email: str, code: str, timeout: int = 30):
        body = encode_verify_email_validation_code(email, code)
        return self._rpc("VerifyEmailValidationCode", body, timeout=timeout)

    def validate_password(self, email: str, password: str, timeout: int = 30):
        body = encode_validate_password(email, password)
        return self._rpc("ValidatePassword", body, timeout=timeout)

    def create_user_via_server_action(
        self,
        *,
        email: str,
        code: str,
        given_name: str,
        family_name: str,
        password: str,
        turnstile_token: str,
        castle_token: str,
        next_action: str = "",
        conversion_id: str = "",
        timeout: int = 45,
    ):
        action = (next_action or self.next_action or "").strip()
        if not action:
            raise RuntimeError("next-action hash missing — capture or scrape first")
        clean_code = str(code or "").replace("-", "").strip()
        payload = [
            {
                "emailValidationCode": clean_code,
                "createUserAndSessionRequest": {
                    "email": email,
                    "givenName": given_name,
                    "familyName": family_name,
                    "clearTextPassword": password,
                    "tosAcceptedVersion": 1,
                },
                "turnstileToken": turnstile_token,
                "conversionId": conversion_id or str(uuid.uuid4()),
                "castleRequestToken": castle_token,
            }
        ]
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        # Browser capture used percent-encoded next-router-state-tree
        tree = self.router_state_tree
        headers = {
            "content-type": "text/plain;charset=UTF-8",
            "accept": "text/x-component",
            "next-action": action,
            "next-router-state-tree": tree,
            "origin": "https://accounts.x.ai",
            "referer": SIGNUP_URL,
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "cors",
            "sec-fetch-dest": "empty",
        }
        resp = self.session.post_raw(SIGNUP_URL, body, headers=headers, timeout=timeout)
        cookies = self.session.cookies_dict()
        text = ""
        try:
            text = resp.text or ""
        except Exception:
            text = ""

        sso = cookies.get("sso") or cookies.get("sso-rw") or ""
        if not sso:
            # curl_cffi may expose multiple set-cookie values
            sc_parts: list[str] = []
            try:
                raw_h = getattr(resp, "headers", None)
                if raw_h is not None:
                    if hasattr(raw_h, "get_list"):
                        sc_parts.extend(raw_h.get_list("set-cookie") or [])
                        sc_parts.extend(raw_h.get_list("Set-Cookie") or [])
                    for k, v in dict(raw_h).items():
                        if str(k).lower() == "set-cookie" and v:
                            sc_parts.append(str(v))
            except Exception:
                pass
            blob = "\n".join(sc_parts)
            m = re.search(r"\bsso=([^;\s]+)", blob)
            if m:
                sso = m.group(1)
            if not sso:
                m = re.search(r"\bsso-rw=([^;\s]+)", blob)
                if m:
                    sso = m.group(1)

        if not sso and text:
            # sometimes JWT appears in RSC stream
            m = re.search(r"\bsso[\"']?\s*[:=]\s*[\"']([^\"']{20,})[\"']", text)
            if m:
                sso = m.group(1)
            if not sso:
                m = re.search(r"(eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)", text)
                if m and "session" in text.lower():
                    sso = m.group(1)

        return {
            "status": resp.status_code,
            "headers": dict(resp.headers),
            "text": text[:4000],
            "cookies": cookies,
            "sso": sso,
        }
