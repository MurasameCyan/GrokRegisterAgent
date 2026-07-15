# -*- coding: utf-8 -*-
"""P3: 用 access_token 开启 Grok NSFW 设置（可选，不挡主流程）。"""
from __future__ import annotations

import json
from typing import Any, Callable, Optional

LogFn = Callable[[str], None]


def _noop(_: str) -> None:
    return None


def enable_nsfw_for_token(
    access_token: str,
    *,
    proxy: str = "",
    timeout: float = 20.0,
    log: Optional[LogFn] = None,
) -> dict[str, Any]:
    """尝试开启 NSFW / 相关用户设置。

    优先 REST 风格 endpoint；失败返回 ok=False 但不抛异常。
    """
    log = log or _noop
    access = str(access_token or "").strip()
    if not access:
        return {"ok": False, "error": "empty access_token"}

    headers = {
        "Authorization": f"Bearer {access}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Origin": "https://grok.com",
        "Referer": "https://grok.com/",
    }
    payloads = [
        (
            "https://grok.com/rest/app-chat/set-user-settings",
            {"enableNsfw": True, "enable_nsfw": True},
        ),
        (
            "https://grok.x.ai/rest/app-chat/set-user-settings",
            {"enableNsfw": True},
        ),
        (
            "https://grok.com/rest/user/settings",
            {"nsfw": True, "enableNsfw": True},
        ),
    ]
    last_err = ""
    try:
        from curl_cffi import requests as cf_requests

        proxies = {"http": proxy, "https": proxy} if proxy else None
        for url, body in payloads:
            try:
                r = cf_requests.post(
                    url,
                    json=body,
                    headers=headers,
                    proxies=proxies,
                    impersonate="chrome120",
                    timeout=timeout,
                )
                if r.status_code in (200, 201, 204):
                    log(f"[nsfw] OK via {url} status={r.status_code}")
                    return {"ok": True, "url": url, "status": r.status_code}
                last_err = f"HTTP {r.status_code}: {(r.text or '')[:120]}"
                # 403/404 试下一个
                if r.status_code in (401,):
                    return {"ok": False, "error": last_err, "status": r.status_code}
            except Exception as e:
                last_err = str(e)[:200]
    except ImportError:
        import urllib.error
        import urllib.request

        opener = urllib.request.build_opener()
        if proxy:
            opener = urllib.request.build_opener(
                urllib.request.ProxyHandler({"http": proxy, "https": proxy})
            )
        for url, body in payloads:
            try:
                req = urllib.request.Request(
                    url,
                    data=json.dumps(body).encode("utf-8"),
                    headers=headers,
                    method="POST",
                )
                with opener.open(req, timeout=timeout) as resp:
                    log(f"[nsfw] OK via {url} status={getattr(resp, 'status', 200)}")
                    return {
                        "ok": True,
                        "url": url,
                        "status": getattr(resp, "status", 200),
                    }
            except urllib.error.HTTPError as e:
                last_err = f"HTTP {e.code}"
            except Exception as e:
                last_err = str(e)[:200]

    log(f"[nsfw] skip/fail: {last_err or 'unknown'}")
    return {"ok": False, "error": last_err or "all endpoints failed"}
