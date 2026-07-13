"""CPA xAI auth JSON schema aligned with CLIProxyAPI internal/auth/xai."""

from __future__ import annotations

import base64
import json
import random
import re
import uuid
from datetime import datetime, timezone
from typing import Any

# Must match CLIProxyAPI internal/auth/xai/types.go
CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
ISSUER = "https://auth.x.ai"
DEFAULT_TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token"
DEFAULT_REDIRECT_URI = "http://127.0.0.1:56121/callback"
# Free Build promo path (NOT api.x.ai)
DEFAULT_BASE_URL = "https://cli-chat-proxy.grok.com/v1"

# Current Grok Build CLI client version (keep in sync with real grok-shell).
GROK_CLIENT_VERSION = "0.2.93"

# grok-pager / grok-shell identity captured from a working Grok Build request.
# The chat endpoint requires these to match a real Grok Build client, not the
# older grok-shell defaults.
DEFAULT_CLIENT_HEADERS: dict[str, str] = {
    "User-Agent": f"grok-pager/{GROK_CLIENT_VERSION} grok-shell/{GROK_CLIENT_VERSION} (linux; x86_64)",
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-grok-client-identifier": "grok-pager",
    "x-grok-client-version": GROK_CLIENT_VERSION,
}

# Platform variants for randomized device fingerprints.
_PLATFORMS = [
    ("linux", "x86_64"),
    ("linux", "aarch64"),
    ("macos", "arm64"),
    ("macos", "x86_64"),
    ("windows", "x86_64"),
]

# Deterministic namespace so the same seed always yields the same agent id
# (idempotent per account), while different accounts get different ids.
_AGENT_NS = uuid.UUID("6f1d2c3b-4a5e-6f70-8192-a3b4c5d6e7f8")


def random_agent_id(seed: str = "") -> str:
    """Return a UUID device/agent id.

    With a seed (email/sub) it is deterministic (UUIDv5) so re-minting the same
    account keeps a stable machine code; without a seed it is random (UUIDv4).
    """
    seed = (seed or "").strip()
    if seed:
        return str(uuid.uuid5(_AGENT_NS, seed))
    return str(uuid.uuid4())


def random_client_headers(seed: str = "", *, agent_id: str | None = None) -> dict[str, str]:
    """Build grok-pager client headers with a randomized device fingerprint.

    Adds ``x-grok-agent-id`` (the real Grok Build device id header) plus a
    platform-randomized User-Agent so each account looks like a distinct
    machine (mitigates same-machine-code ban propagation).
    """
    seed = (seed or "").strip()
    rnd = random.Random(seed) if seed else random.Random()
    plat, arch = rnd.choice(_PLATFORMS)
    aid = (agent_id or "").strip() or random_agent_id(seed)
    return {
        "User-Agent": f"grok-pager/{GROK_CLIENT_VERSION} grok-shell/{GROK_CLIENT_VERSION} ({plat}; {arch})",
        "X-XAI-Token-Auth": "xai-grok-cli",
        "x-grok-client-identifier": "grok-pager",
        "x-grok-client-version": GROK_CLIENT_VERSION,
        "x-grok-agent-id": aid,
    }


def _sanitize_file_segment(value: str) -> str:
    """Mirror CPA CredentialFileName sanitize rules."""
    value = (value or "").strip()
    if not value:
        return ""
    out: list[str] = []
    for ch in value:
        if (
            ("a" <= ch <= "z")
            or ("A" <= ch <= "Z")
            or ("0" <= ch <= "9")
            or ch in {"@", ".", "_", "-"}
        ):
            out.append(ch)
        else:
            out.append("-")
    return "".join(out).strip("-")


def credential_file_name(email: str = "", sub: str = "") -> str:
    """Return CPA auth filename: xai-<email>.json."""
    email_s = _sanitize_file_segment(email)
    if email_s:
        return f"xai-{email_s}.json"
    sub_s = _sanitize_file_segment(sub)
    if sub_s:
        return f"xai-{sub_s}.json"
    ts = int(datetime.now(tz=timezone.utc).timestamp() * 1000)
    return f"xai-{ts}.json"


def jwt_payload(token: str) -> dict[str, Any]:
    parts = token.split(".")
    if len(parts) < 2:
        raise ValueError("not a JWT")
    pad = "=" * (-len(parts[1]) % 4)
    return json.loads(base64.urlsafe_b64decode(parts[1] + pad))


def expired_from_access_token(access_token: str) -> tuple[str, int, str]:
    """Return (expired_rfc3339_z, expires_in, sub)."""
    pl = jwt_payload(access_token)
    exp = int(pl["exp"])
    iat = int(pl["iat"]) if pl.get("iat") is not None else exp - 21600
    expired = datetime.fromtimestamp(exp, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    sub = str(pl.get("sub") or pl.get("principal_id") or "").strip()
    return expired, max(exp - iat, 0), sub


def build_cpa_xai_auth(
    *,
    email: str,
    access_token: str,
    refresh_token: str,
    sub: str | None = None,
    id_token: str | None = None,
    expires_in: int | None = None,
    expired: str | None = None,
    last_refresh: str | None = None,
    base_url: str = DEFAULT_BASE_URL,
    token_endpoint: str = DEFAULT_TOKEN_ENDPOINT,
    redirect_uri: str = DEFAULT_REDIRECT_URI,
    headers: dict[str, str] | None = None,
    disabled: bool = False,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a CPA-importable xAI OAuth auth object."""
    access_token = (access_token or "").strip()
    refresh_token = (refresh_token or "").strip()
    if not access_token:
        raise ValueError("access_token is required")
    if not refresh_token:
        raise ValueError("refresh_token is required (CPA cannot renew without it)")

    try:
        exp_s, exp_in, sub_jwt = expired_from_access_token(access_token)
    except Exception:
        exp_s, exp_in, sub_jwt = "", 21600, ""

    if not expired:
        expired = exp_s
    if expires_in is None:
        expires_in = exp_in or 21600
    if not sub:
        sub = sub_jwt
    if not last_refresh:
        last_refresh = datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Free promo must hit cli-chat-proxy; refuse silent api.x.ai default for free path.
    base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
    if not re.search(r"/v1$", base_url):
        # CPA joins baseURL + "/responses"
        if base_url.endswith("cli-chat-proxy.grok.com"):
            base_url = base_url + "/v1"

    payload: dict[str, Any] = {
        "type": "xai",
        "auth_kind": "oauth",
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "Bearer",
        "expires_in": int(expires_in),
        "expired": expired,
        "last_refresh": last_refresh,
        "email": (email or "").strip(),
        "sub": (sub or "").strip(),
        "base_url": base_url,
        "token_endpoint": token_endpoint,
        "redirect_uri": redirect_uri,
        "disabled": bool(disabled),
        "headers": dict(headers or DEFAULT_CLIENT_HEADERS),
    }
    if id_token:
        payload["id_token"] = id_token.strip()
    if extra:
        for k, v in extra.items():
            if k not in payload:
                payload[k] = v
    return payload
