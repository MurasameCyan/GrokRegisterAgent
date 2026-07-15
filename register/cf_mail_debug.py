#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Cloudflare 临时邮箱鉴权 / 创建 / 收信调试脚本。

用法示例:
  python cf_mail_debug.py --base https://xxx.workers.dev --mode x-admin-auth --key YOUR_PASS
  python cf_mail_debug.py --base https://xxx.workers.dev --mode none
  python cf_mail_debug.py --base https://xxx.workers.dev --mode bearer --key TOKEN --domain example.com

读 config.json 默认值（mail_api_base / mail_admin_auth / cloudflare_auth_mode / mail_domain）。
"""
from __future__ import annotations

import argparse
import json
import re
import secrets
import string
import sys
import time
from pathlib import Path
from typing import Any, Optional

_ROOT = Path(__file__).resolve().parent


def _load_config() -> dict[str, Any]:
    p = _ROOT / "config.json"
    try:
        if p.is_file():
            return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def build_auth_headers(auth_mode: str, api_key: str, content_type: bool = False) -> dict[str, str]:
    headers: dict[str, str] = {}
    if content_type:
        headers["Content-Type"] = "application/json"
    key = (api_key or "").strip()
    mode = (auth_mode or "none").strip().lower()
    if not key or mode in ("none", "anonymous", "anon", "public"):
        return headers
    if mode in ("x-admin-auth", "admin"):
        headers["x-admin-auth"] = key
    elif mode in ("x-api-key", "apikey", "api-key"):
        headers["X-API-Key"] = key
    elif mode in ("bearer", "authorization"):
        headers["Authorization"] = f"Bearer {key}"
    return headers


def extract_code(text: str, subject: str = "") -> Optional[str]:
    if subject:
        m = re.search(r"\b([A-Z0-9]{3}-[A-Z0-9]{3})\b", subject, re.IGNORECASE)
        if m:
            return m.group(1)
    m = re.search(r"\b([A-Z0-9]{3}-[A-Z0-9]{3})\b", text, re.IGNORECASE)
    if m:
        return m.group(1)
    for p in [
        r"verification\s+code[:\s]+(\d{4,8})",
        r"your\s+code[:\s]+(\d{4,8})",
        r"\b(\d{6})\b",
    ]:
        m = re.search(p, text, re.IGNORECASE)
        if m:
            return m.group(1)
    return None


def main() -> int:
    conf = _load_config()
    ap = argparse.ArgumentParser(description="CF temp email debug")
    ap.add_argument(
        "--base",
        default=str(conf.get("mail_api_base") or "").strip(),
        help="Worker API root",
    )
    ap.add_argument(
        "--mode",
        default=str(
            conf.get("cloudflare_auth_mode")
            or conf.get("mail_auth_mode")
            or "x-admin-auth"
        ).strip(),
        choices=["none", "x-admin-auth", "bearer", "x-api-key", "query-key"],
        help="auth mode",
    )
    ap.add_argument(
        "--key",
        default=str(conf.get("mail_admin_auth") or "").strip(),
        help="admin password / API key",
    )
    ap.add_argument(
        "--domain",
        default=str(conf.get("mail_domain") or "").strip().lstrip("@"),
        help="domain for admin create",
    )
    ap.add_argument(
        "--path",
        default="",
        help="override create path e.g. /admin/new_address or /api/new_address",
    )
    ap.add_argument("--poll", type=int, default=0, help="poll inbox seconds (0=skip)")
    ap.add_argument("--proxy", default=str(conf.get("proxy") or "").strip())
    args = ap.parse_args()

    base = (args.base or "").rstrip("/")
    if not base:
        print("ERROR: --base / mail_api_base required", file=sys.stderr)
        return 2

    mode = args.mode.strip().lower()
    path = (args.path or "").strip()
    if not path:
        path = "/api/new_address" if mode == "none" else "/admin/new_address"
    if not path.startswith("/"):
        path = f"/{path}"

    create_url = f"{base}{path}"
    if mode == "query-key" and args.key:
        create_url += ("&" if "?" in create_url else "?") + f"key={args.key}"

    headers = build_auth_headers(mode, args.key, content_type=True)
    is_admin = path.rstrip("/").lower().endswith("/admin/new_address")
    local = "".join(
        secrets.choice(string.ascii_lowercase + string.digits) for _ in range(10)
    )
    if is_admin:
        if not args.domain:
            print("ERROR: admin create needs --domain", file=sys.stderr)
            return 2
        payload: dict[str, Any] = {
            "name": local,
            "domain": args.domain,
            "enablePrefix": False,
        }
    else:
        payload = {}
        if args.domain:
            payload["domain"] = args.domain

    print(f"[*] POST {create_url}")
    print(f"[*] mode={mode} headers={list(headers.keys())} payload={payload}")

    try:
        from curl_cffi import requests as cf_req

        proxies = (
            {"http": args.proxy, "https": args.proxy} if args.proxy else None
        )
        resp = cf_req.post(
            create_url,
            json=payload,
            headers=headers,
            proxies=proxies,
            impersonate="chrome131",
            timeout=20,
        )
        print(f"[*] status={resp.status_code}")
        print(f"[*] body={(resp.text or '')[:500]}")
        if resp.status_code not in (200, 201):
            return 1
        data = resp.json() if resp.text else {}
        address = str(data.get("address") or "")
        jwt = str(data.get("jwt") or "")
        print(f"[*] address={address}")
        print(f"[*] jwt_len={len(jwt)}")
        if not jwt:
            return 1
        if args.poll > 0:
            print(f"[*] poll inbox {args.poll}s…")
            end = time.time() + args.poll
            while time.time() < end:
                r = cf_req.get(
                    f"{base}/api/mails",
                    params={"limit": 10, "offset": 0},
                    headers={"Authorization": f"Bearer {jwt}"},
                    proxies=proxies,
                    impersonate="chrome131",
                    timeout=15,
                )
                if r.status_code == 200:
                    body = r.json() if r.text else {}
                    results = body.get("results") if isinstance(body, dict) else body
                    if isinstance(results, list) and results:
                        for m in results:
                            if not isinstance(m, dict):
                                continue
                            subj = str(m.get("subject") or "")
                            text = str(
                                m.get("raw") or m.get("text") or m.get("html") or ""
                            )
                            code = extract_code(text, subj)
                            print(f"  mail: {subj[:60]} code={code}")
                        return 0
                time.sleep(2)
            print("[*] no mail within poll window")
        return 0
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
