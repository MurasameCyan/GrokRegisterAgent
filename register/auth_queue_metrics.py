#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""写出授权队列 metrics 供 server 读取。

落盘: register/data/auth_queue_metrics.json
由 auth_export_queue 周期性/入队后更新。
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

_PATH = Path(__file__).resolve().parent / "data" / "auth_queue_metrics.json"
_LOCK = threading.Lock()


def write_metrics(stats: dict[str, Any]) -> None:
    payload = {
        **dict(stats or {}),
        "updated_at": time.time(),
        "updated_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    with _LOCK:
        try:
            _PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp = _PATH.with_suffix(".json.tmp")
            tmp.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            tmp.replace(_PATH)
        except Exception:
            pass


def read_metrics() -> dict[str, Any]:
    try:
        if _PATH.is_file():
            return json.loads(_PATH.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {
        "pending": 0,
        "queue_size": 0,
        "done_ok": 0,
        "done_fail": 0,
        "workers": 0,
        "queue_max": 0,
        "updated_at": 0,
    }
