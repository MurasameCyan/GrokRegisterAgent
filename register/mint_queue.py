# -*- coding: utf-8 -*-
"""
U1 · Mint 双池：与注册/授权延迟队列分离的 mint worker 池。

架构:
  注册成功 → auth_export_queue（SSO→g2 等轻量步骤）
           → 或直接 enqueue_mint（本模块）做 SSO→CPA Auth mint

config.json / 环境变量:
  cpa_mint_workers / CPA_MINT_WORKERS: mint 并发，默认 1，范围 0～8
    0 = 内联（由 auth_export_queue 线程直接 mint，不启独立池）
  cpa_mint_queue_max / CPA_MINT_QUEUE_MAX: 队列上限，默认 max(2, 2×workers)
"""
from __future__ import annotations

import json
import os
import queue
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

LogFn = Callable[[str], None]

_CONFIG = Path(__file__).resolve().parent / "config.json"

_q: queue.Queue[dict[str, Any] | None] | None = None
_workers: list[threading.Thread] = []
_lock = threading.Lock()
_started = False
_pending = 0
_done_ok = 0
_done_fail = 0
_worker_count = 0
_queue_max = 0


def _log(msg: str, log: LogFn | None = None) -> None:
    fn = log or (lambda m: print(m, flush=True))
    try:
        fn(msg)
    except Exception:
        print(msg, flush=True)


def _load_conf() -> dict[str, Any]:
    try:
        if _CONFIG.is_file():
            conf = json.loads(_CONFIG.read_text(encoding="utf-8"))
            return conf if isinstance(conf, dict) else {}
    except Exception:
        pass
    return {}


def load_mint_pool_settings() -> tuple[int, int]:
    """返回 (workers, queue_max)。workers=0 表示禁用独立 mint 池。"""
    conf = _load_conf()
    workers = 1
    try:
        workers = int(
            conf.get("cpa_mint_workers")
            if conf.get("cpa_mint_workers") is not None
            else conf.get("cpaMintWorkers")
            if conf.get("cpaMintWorkers") is not None
            else 1
        )
    except Exception:
        workers = 1
    env_w = os.environ.get("CPA_MINT_WORKERS", "").strip()
    if env_w.isdigit() or (env_w.startswith("-") and env_w[1:].isdigit()):
        workers = int(env_w)
    # -1 = auto → 1；0 = inline（不启池）
    if workers < 0:
        workers = 1
    workers = max(0, min(workers, 8))

    qmax = 0
    try:
        qmax = int(conf.get("cpa_mint_queue_max") or conf.get("cpaMintQueueMax") or 0)
    except Exception:
        qmax = 0
    env_q = os.environ.get("CPA_MINT_QUEUE_MAX", "").strip()
    if env_q.isdigit():
        qmax = int(env_q)
    if qmax <= 0:
        qmax = max(2, workers * 2) if workers > 0 else 4
    qmax = max(1, min(qmax, 64))
    return workers, qmax


def use_separate_mint_pool() -> bool:
    w, _ = load_mint_pool_settings()
    return w > 0


def queue_stats() -> dict[str, Any]:
    return {
        "pending": _pending,
        "queue_size": _q.qsize() if _q else 0,
        "done_ok": _done_ok,
        "done_fail": _done_fail,
        "workers": _worker_count,
        "queue_max": _queue_max,
        "separate_pool": use_separate_mint_pool(),
    }


def _process_mint_job(job: dict[str, Any]) -> None:
    global _done_ok, _done_fail
    from auth_export_queue import _run_mint_and_auth_push  # 复用 mint+推送逻辑

    email = str(job.get("email") or "")
    wid = threading.current_thread().name
    _log(f"[mint-queue][{wid}] ▶ mint email={email or '-'}")
    try:
        r = _run_mint_and_auth_push(
            sso=str(job.get("sso") or ""),
            email=email,
            proxy=str(job.get("proxy") or ""),
            mint_mode=str(job.get("mint_mode") or "pkce"),
            push_cpa=bool(job.get("push_cpa")),
            password=str(job.get("password") or ""),
            cloudflare_cookies=str(job.get("cloudflare_cookies") or ""),
            log=_log,
        )
        if r and r.get("ok"):
            _done_ok += 1
            _log(f"[mint-queue][{wid}] ✔ mint OK email={email or '-'}")
        else:
            _done_fail += 1
            _log(
                f"[mint-queue][{wid}] ✘ mint fail email={email or '-'} "
                f"err={(r or {}).get('error') or 'unknown'}"
            )
    except Exception as e:
        _done_fail += 1
        _log(f"[mint-queue][{wid}] ✘ 异常: {e}")


def _worker_loop() -> None:
    global _pending
    assert _q is not None
    while True:
        job = _q.get()
        try:
            if job is None:
                break
            _process_mint_job(job)
        finally:
            with _lock:
                _pending = max(0, _pending - 1)
            _q.task_done()


def ensure_mint_workers() -> None:
    global _q, _workers, _started, _worker_count, _queue_max
    workers, qmax = load_mint_pool_settings()
    if workers <= 0:
        return
    with _lock:
        alive = [t for t in _workers if t.is_alive()]
        _workers = alive
        if _started and alive and _q is not None:
            return
        _worker_count = workers
        _queue_max = qmax
        if _q is None:
            _q = queue.Queue(maxsize=qmax)
        need = workers - len(alive)
        for i in range(need):
            t = threading.Thread(
                target=_worker_loop,
                name=f"mint-w{len(alive) + i + 1}",
                daemon=True,
            )
            t.start()
            _workers.append(t)
        _started = True
        _log(f"[mint-queue] mint 池已启动 workers={workers} queue_max={qmax}")


def enqueue_mint(
    *,
    sso: str,
    email: str = "",
    password: str = "",
    proxy: str = "",
    mint_mode: str = "pkce",
    push_cpa: bool = False,
    cloudflare_cookies: str = "",
    log: Optional[LogFn] = None,
    block_sec: float = 120.0,
) -> dict[str, Any]:
    """入 mint 池。若 workers=0，返回 use_inline=True 由调用方内联 mint。"""
    global _pending
    sso = (sso or "").strip()
    if not sso:
        return {"queued": False, "error": "empty sso"}

    workers, _qmax = load_mint_pool_settings()
    if workers <= 0:
        return {"queued": False, "use_inline": True, "reason": "cpa_mint_workers=0"}

    ensure_mint_workers()
    assert _q is not None
    job = {
        "sso": sso,
        "email": (email or "").strip(),
        "password": (password or "").strip(),
        "proxy": (proxy or "").strip(),
        "mint_mode": (mint_mode or "pkce").strip().lower(),
        "push_cpa": bool(push_cpa),
        "cloudflare_cookies": (cloudflare_cookies or "").strip(),
        "enqueued_at": time.time(),
    }
    try:
        _q.put(job, timeout=max(1.0, float(block_sec)))
    except queue.Full:
        _log(f"[mint-queue] 背压：队列已满 email={email or '-'}", log)
        return {"queued": False, "error": "mint queue full", "backpressure": True}

    with _lock:
        _pending += 1
    _log(
        f"[mint-queue] 已入队 email={email or '-'} pending≈{_pending} "
        f"qsize={_q.qsize()}",
        log,
    )
    return {"queued": True, "pending": _pending, "workers": workers}


def wait_mint_idle(timeout: float = 600.0) -> bool:
    """等待 mint 队列排空。"""
    if _q is None:
        return True
    end = time.time() + timeout
    while time.time() < end:
        if _q.unfinished_tasks == 0:
            return True
        time.sleep(0.5)
    return _q.unfinished_tasks == 0
