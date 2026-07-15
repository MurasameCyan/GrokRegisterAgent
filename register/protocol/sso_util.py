"""Normalize xAI SSO cookies (set-cookie chain wrapper → session JWT)."""
from __future__ import annotations

import base64
import json
import re
from typing import Any, Optional
from urllib.parse import parse_qs, urlparse


def _b64json(segment: str) -> Optional[dict]:
    try:
        pad = "=" * ((4 - len(segment) % 4) % 4)
        return json.loads(base64.urlsafe_b64decode(segment + pad))
    except Exception:
        return None


def decode_jwt_payload(token: str) -> Optional[dict]:
    token = (token or "").strip()
    if token.startswith("sso="):
        token = token[4:]
    parts = token.split(".")
    if len(parts) < 2:
        return None
    return _b64json(parts[1])


def is_wrapper_sso(token: str) -> bool:
    """True if token is set-cookie hop JWT (config.token + success_url), not session sso."""
    payload = decode_jwt_payload(token)
    if not isinstance(payload, dict):
        return False
    cfg = payload.get("config")
    if not isinstance(cfg, dict):
        return False
    return bool(cfg.get("success_url") and (cfg.get("token") or cfg.get("success_url")))


def is_session_sso(token: str) -> bool:
    """Heuristic: real session cookies are short JWTs with session claims, not set-cookie wrappers."""
    token = (token or "").strip()
    if not token or len(token) < 40:
        return False
    if is_wrapper_sso(token):
        return False
    payload = decode_jwt_payload(token)
    if not isinstance(payload, dict):
        return False
    # historical session tokens often ~150 chars and start with eyJ0eXAi
    if token.startswith("eyJ0eXAi") or "session" in payload or "user" in payload:
        return True
    # any non-wrapper JWT of moderate length
    return 40 <= len(token) <= 800 and "config" not in payload


def unwrap_success_url(token: str) -> str:
    payload = decode_jwt_payload(token)
    if not isinstance(payload, dict):
        return ""
    cfg = payload.get("config") or {}
    return str(cfg.get("success_url") or "").strip()


def materialize_sso_via_browser(page: Any, wrapper_or_sso: str, log=None, timeout: float = 45.0) -> str:
    """Use live Chromium tab to follow set-cookie chain and return session sso."""
    import time

    log = log or (lambda _m: None)
    token = (wrapper_or_sso or "").strip()
    if not token:
        return ""
    if is_session_sso(token) and not is_wrapper_sso(token):
        return token

    success = unwrap_success_url(token) if is_wrapper_sso(token) else ""
    # inject cookie then open success or accounts
    try:
        page.run_js(
            """
const v = String(arguments[0] || '');
if (!v) return false;
document.cookie = 'sso=' + v + '; path=/; domain=.x.ai; Secure; SameSite=Lax';
document.cookie = 'sso-rw=' + v + '; path=/; domain=.x.ai; Secure; SameSite=Lax';
return true;
            """,
            token,
        )
    except Exception as e:
        log(f"[sso] inject cookie: {e}")

    urls = []
    if success:
        urls.append(success)
    urls.append("https://accounts.x.ai/")
    urls.append("https://grok.com/")

    deadline = time.time() + timeout
    for url in urls:
        if time.time() >= deadline:
            break
        try:
            try:
                page.get(url, timeout=30)
            except TypeError:
                page.get(url)
            time.sleep(1.2)
        except Exception as e:
            log(f"[sso] navigate {url[:60]}: {e}")
            continue
        # poll cookies
        for _ in range(12):
            if time.time() >= deadline:
                break
            try:
                cookies = page.cookies(all_domains=True, all_info=True) or page.cookies() or []
            except Exception:
                cookies = []
            for item in cookies:
                if isinstance(item, dict):
                    name = str(item.get("name") or "")
                    value = str(item.get("value") or "")
                else:
                    name = str(getattr(item, "name", "") or "")
                    value = str(getattr(item, "value", "") or "")
                if name == "sso" and value and is_session_sso(value):
                    log(f"[sso] materialized session len={len(value)}")
                    return value
            time.sleep(0.5)

    # last try: read any sso even if still wrapper
    try:
        cookies = page.cookies(all_domains=True, all_info=True) or []
        for item in cookies:
            if isinstance(item, dict) and item.get("name") == "sso" and item.get("value"):
                return str(item.get("value"))
    except Exception:
        pass
    return token if is_session_sso(token) else ""


def materialize_sso_via_http(
    wrapper: str,
    *,
    proxy: str = "",
    extra_cookies: Optional[dict] = None,
    log=None,
    timeout: float = 30.0,
) -> str:
    """Best-effort pure HTTP exchange (often needs fresh CF cookies)."""
    log = log or (lambda _m: None)
    if not is_wrapper_sso(wrapper):
        return wrapper if is_session_sso(wrapper) else ""
    try:
        from curl_cffi import requests as cf
    except Exception as e:
        log(f"[sso] curl_cffi missing: {e}")
        return ""

    success = unwrap_success_url(wrapper)
    if not success:
        return ""
    s = cf.Session()
    if proxy:
        s.proxies = {"http": proxy, "https": proxy}
    for name, value in (extra_cookies or {}).items():
        if not name or value is None:
            continue
        for d in (".x.ai", "accounts.x.ai", "auth.x.ai", ".grok.com"):
            try:
                s.cookies.set(str(name), str(value), domain=d)
            except Exception:
                pass
    for d in (".x.ai", "accounts.x.ai"):
        try:
            s.cookies.set("sso", wrapper, domain=d)
            s.cookies.set("sso-rw", wrapper, domain=d)
        except Exception:
            pass

    url = success
    for hop in range(8):
        try:
            r = s.get(url, impersonate="chrome131", timeout=timeout, allow_redirects=True)
        except TypeError:
            r = s.get(url, timeout=timeout, allow_redirects=True)
        except Exception as e:
            log(f"[sso] hop {hop} fail: {e}")
            break
        # inspect jar for short session sso
        try:
            for c in s.cookies.jar:
                if c.name == "sso" and c.value and is_session_sso(c.value):
                    log(f"[sso] http materialize len={len(c.value)}")
                    return c.value
        except Exception:
            jar = {}
            try:
                jar = dict(s.cookies)
            except Exception:
                pass
            for name in ("sso", "sso-rw"):
                v = jar.get(name) or ""
                if is_session_sso(v):
                    return v
        final = getattr(r, "url", "") or ""
        if "sign-in" in final or "auth-error" in final:
            log(f"[sso] http landed {final[:100]}")
            break
        # follow nested success_url if still wrapper in location/body
        m = re.search(r"https://auth\.[^\s\"']+set-cookie\?q=[^\s\"']+", getattr(r, "text", "") or "")
        if m:
            url = m.group(0)
            continue
        break
    return ""
