# -*- coding: utf-8 -*-
"""注册长跑：定期 GC / 可选清临时文件。"""
from __future__ import annotations

import gc
import os
import time
from pathlib import Path
from typing import Callable, Optional

LogFn = Callable[[str], None]

_last_gc_at = 0.0
_success_since_gc = 0


def cleanup_runtime_memory(
    *,
    log: Optional[LogFn] = None,
    force: bool = False,
    min_interval_sec: float = 30.0,
) -> dict:
    """触发 Python GC；可选打日志。"""
    global _last_gc_at, _success_since_gc
    now = time.time()
    if not force and (now - _last_gc_at) < min_interval_sec:
        return {"ok": True, "skipped": True, "reason": "interval"}
    collected = 0
    try:
        collected = int(gc.collect() or 0)
        try:
            gc.collect(2)
        except Exception:
            pass
    except Exception as e:
        if log:
            log(f"[gc] collect fail: {e}")
        return {"ok": False, "error": str(e)}
    _last_gc_at = now
    _success_since_gc = 0
    if log:
        log(f"[gc] cleanup_runtime_memory collected={collected}")
    return {"ok": True, "collected": collected}


def on_register_success(
    *,
    recycle_every: int = 5,
    log: Optional[LogFn] = None,
) -> dict:
    """每成功 N 次：GC + 建议重启浏览器。

    返回: { need_browser_recycle: bool, success_since_gc: int }
    """
    global _success_since_gc
    _success_since_gc += 1
    n = max(0, int(recycle_every or 0))
    need = n > 0 and _success_since_gc >= n
    if need:
        cleanup_runtime_memory(log=log, force=True)
        if log:
            log(f"[gc] 已达 recycle_every={n} 成功，建议重启浏览器")
        prev = _success_since_gc
        _success_since_gc = 0
        return {
            "need_browser_recycle": True,
            "success_since_gc": prev,
        }
    # 轻量 GC（不强制）
    if _success_since_gc % 2 == 0:
        cleanup_runtime_memory(log=log, force=False, min_interval_sec=20.0)
    return {
        "need_browser_recycle": False,
        "success_since_gc": _success_since_gc,
    }


def reset_success_counter() -> None:
    global _success_since_gc
    _success_since_gc = 0


def load_recycle_every(conf: dict | None = None) -> int:
    conf = conf or {}
    try:
        v = conf.get("browser_recycle_every")
        if v is None:
            v = conf.get("browserRecycleEvery")
        if v is None:
            v = os.environ.get("BROWSER_RECYCLE_EVERY", "5")
        return max(0, int(v))
    except Exception:
        return 5


def load_max_mail_retry(conf: dict | None = None) -> int:
    conf = conf or {}
    try:
        v = conf.get("max_mail_retry")
        if v is None:
            v = conf.get("maxMailRetry")
        if v is None:
            v = os.environ.get("MAX_MAIL_RETRY", "3")
        return max(1, min(10, int(v)))
    except Exception:
        return 3


def clear_temp_profiles(base: Path | None = None, log: Optional[LogFn] = None) -> int:
    """尽力清理 register 下过期临时目录（best-effort）。"""
    root = base or Path(__file__).resolve().parent
    removed = 0
    for name in ("tmp", "tmp_profiles", ".browser_tmp"):
        d = root / name
        if not d.is_dir():
            continue
        try:
            for p in d.iterdir():
                try:
                    if p.is_file() and (time.time() - p.stat().st_mtime) > 86400:
                        p.unlink(missing_ok=True)
                        removed += 1
                except Exception:
                    pass
        except Exception:
            pass
    if log and removed:
        log(f"[gc] cleared temp files={removed}")
    return removed
