#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本项目启动/自检清单（对照 clean 包 + 已落地能力）。

用法:
  python optimization_checks.py
退出码: 0=全 pass, 1=有 fail
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent
CHECKS: list[tuple[str, Callable[[], bool]]] = []


def check(name: str):
    def decorator(func: Callable[[], bool]):
        CHECKS.append((name, func))
        return func

    return decorator


def _source(filename: str) -> str:
    p = ROOT / filename
    if not p.is_file():
        return ""
    return p.read_text(encoding="utf-8", errors="replace")


def _config() -> dict:
    p = ROOT / "config.json"
    if not p.is_file():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


@check("tab-pool-module")
def check_tab_pool() -> bool:
    return (ROOT / "tab_pool.py").is_file() and "threading.local" in _source("tab_pool.py")


@check("auth-export-queue-workers")
def check_auth_queue() -> bool:
    src = _source("auth_export_queue.py")
    return "load_worker_settings" in src and "queue.Queue" in src and "backpressure" in src


@check("has-grok-45-probe")
def check_grok45() -> bool:
    return "probe_models" in _source("cpa_probe.py") and "has_grok_45" in _source("auth_service.py")


@check("nsfw-grpc-path")
def check_nsfw() -> bool:
    src = _source("nsfw_toggle.py")
    return (
        "UpdateUserFeatureControls" in src
        and "always_show_nsfw_content" in src
        and "encode_grpc_nsfw_settings" in src
    )


@check("turnstile-reuse")
def check_turnstile() -> bool:
    src = _source("DrissionPage_example.py")
    return "_inject_turnstile_token" in src and "二次" in src


@check("cf-mail-multi-auth")
def check_cf_mail() -> bool:
    return "cloudflare_auth_mode" in _source("email_register.py") or "build_cf_auth_headers" in _source(
        "email_register.py"
    )


@check("browser-device-mint")
def check_browser_mint() -> bool:
    return (ROOT / "browser_device_mint.py").is_file()


@check("runtime-gc")
def check_gc() -> bool:
    return (ROOT / "runtime_gc.py").is_file() and "cleanup_runtime_memory" in _source("runtime_gc.py")


@check("mail-retry-helper")
def check_mail_retry() -> bool:
    # 主流程应支持 max_mail_retry / AccountRetryNeeded
    src = _source("DrissionPage_example.py")
    return "max_mail_retry" in src or "AccountRetryNeeded" in src or "load_max_mail_retry" in _source(
        "runtime_gc.py"
    )


@check("account-tags-nsfw")
def check_tags() -> bool:
    return (ROOT / "account_tags.py").is_file()


@check("sub2api-export")
def check_sub2api() -> bool:
    return (ROOT / "cpa_to_sub2api.py").is_file()


@check("config-readable")
def check_config() -> bool:
    # config 可缺省（WebUI 生成）；有则须是 dict
    p = ROOT / "config.json"
    if not p.is_file():
        return True
    return isinstance(_config(), dict)


def main() -> int:
    print("=== GrokRegisterAgent optimization_checks ===")
    failed = 0
    for name, fn in CHECKS:
        try:
            ok = bool(fn())
        except Exception as e:
            ok = False
            print(f"  FAIL  {name}: exception {e}")
            failed += 1
            continue
        if ok:
            print(f"  PASS  {name}")
        else:
            print(f"  FAIL  {name}")
            failed += 1
    print(f"--- {len(CHECKS) - failed}/{len(CHECKS)} passed ---")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
