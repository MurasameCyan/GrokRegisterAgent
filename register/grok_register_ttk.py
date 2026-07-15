# -*- coding: utf-8 -*-
"""
Compatibility shim: regkit / browser.token_harvester import ``grok_register_ttk``.

本仓库主引擎是 DrissionPage_example，在此转发常用符号，避免 hybrid 因缺模块失败。
"""
from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

# 主注册引擎
import DrissionPage_example as _engine  # noqa: E402

# 浏览器
start_browser = _engine.start_browser
stop_browser = _engine.stop_browser
restart_browser = getattr(_engine, "restart_browser", None)
open_signup_page = _engine.open_signup_page
click_email_signup_button = _engine.click_email_signup_button
getTurnstileToken = _engine.getTurnstileToken
refresh_active_page = getattr(_engine, "refresh_active_page", None)


def shutdown_browser(*_a, **_k):
    return stop_browser()


def _get_page():
    return getattr(_engine, "page", None)


def _get_browser():
    return getattr(_engine, "browser", None)


# 邮件（若引擎侧无同名则从 email_register 兜底）
try:
    from email_register import create_temp_email, get_oai_code  # noqa: F401
except Exception:  # pragma: no cover
    create_temp_email = None  # type: ignore
    get_oai_code = None  # type: ignore

# 可选 post-success（本仓库用 auth 队列，hybrid 侧可不依赖）
schedule_post_registration = getattr(_engine, "schedule_post_registration", None)
wait_post_success_queue = getattr(_engine, "wait_post_success_queue", None)
cleanup_runtime_memory = getattr(_engine, "cleanup_runtime_memory", None)
apply_resolved_proxy_to_config = getattr(_engine, "apply_resolved_proxy_to_config", None)
sleep_with_cancel = getattr(_engine, "sleep_with_cancel", None)
cli_log = getattr(_engine, "cli_log", print)
config = getattr(_engine, "config", {}) or {}


class CliStopController:
    def __init__(self):
        self._stop = False

    def stop(self):
        self._stop = True

    def should_stop(self):
        return bool(self._stop)


def now_beijing(fmt: str = "%Y%m%d_%H%M%S") -> str:
    try:
        from datetime import datetime, timezone, timedelta

        return datetime.now(timezone(timedelta(hours=8))).strftime(fmt)
    except Exception:
        from datetime import datetime

        return datetime.now().strftime(fmt)


def build_profile():
    """返回 (given_name, family_name, password)。"""
    import secrets
    import string

    given_pool = [
        "Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Avery", "Quinn",
        "Jamie", "Skyler", "Cameron", "Drew", "Reese", "Blake", "Hayden",
    ]
    family_pool = [
        "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
        "Davis", "Wilson", "Anderson", "Thomas", "Jackson", "White", "Harris",
    ]
    alphabet = string.ascii_letters + string.digits
    password = "".join(secrets.choice(alphabet) for _ in range(12)) + "aA1!"
    return secrets.choice(given_pool), secrets.choice(family_pool), password


def get_email_and_token():
    """返回 (email, mail_token/jwt)。"""
    from email_register import create_temp_email

    email, password, jwt = create_temp_email()
    # create_temp_email -> (email, password, jwt) 或变体
    if isinstance(email, tuple):
        # 防御
        return email
    return str(email), str(jwt or password or "")
