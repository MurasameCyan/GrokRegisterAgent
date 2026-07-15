# -*- coding: utf-8 -*-
"""
注册成功后的「授权队列」：不阻塞注册主循环。

注册机只负责提取 SSO 并入队；本队列在随机延迟后依次：
  1) SSO 推送 grok2api（若 push_sso_to_grok2api / 自动）
  2) SSO→CPA Auth 转换 mint（若 auto_auth_export）
  3) Auth 推送 CPA（mint 时 skip_remote=False 且配置了 cpa_remote + 自动推送）

多 worker + 背压：
  auth_export_workers / AUTH_EXPORT_WORKERS：并发 worker 数，默认 2，范围 1～8
  auth_export_queue_max / AUTH_EXPORT_QUEUE_MAX：队列上限，默认 2×workers；满则入队阻塞/失败

config.json:
  auto_auth_export: true
  auto_auth_delay_min_sec / max_sec: 默认 60～120
  push_sso_to_grok2api / push_auth_to_cpa / cpa_remote_url / ...
  cpa_mint_mode: pkce|device|double
"""
from __future__ import annotations

import json
import os
import queue
import random
import threading
import time
from pathlib import Path  # used by NSFW/sub2api helpers
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
_enqueue_block_sec = 120.0


def _noop(_: str) -> None:
    return None


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


def _truthy(v: Any) -> bool:
    if v is True:
        return True
    if v is False or v is None:
        return False
    return str(v).lower() in ("1", "true", "yes", "on")


def load_delay_range() -> tuple[int, int]:
    """返回 (min_sec, max_sec)，默认 60～120。"""
    conf = _load_conf()
    lo, hi = 60, 120
    try:
        lo = int(conf.get("auto_auth_delay_min_sec") or conf.get("autoAuthDelayMinSec") or lo)
        hi = int(conf.get("auto_auth_delay_max_sec") or conf.get("autoAuthDelayMaxSec") or hi)
    except Exception:
        pass
    env_lo = os.environ.get("AUTO_AUTH_DELAY_MIN_SEC", "").strip()
    env_hi = os.environ.get("AUTO_AUTH_DELAY_MAX_SEC", "").strip()
    if env_lo.isdigit():
        lo = int(env_lo)
    if env_hi.isdigit():
        hi = int(env_hi)
    lo = max(0, min(lo, 3600))
    hi = max(lo, min(hi, 7200))
    return lo, hi


def load_mint_mode() -> str:
    conf = _load_conf()
    m = str(conf.get("cpa_mint_mode") or conf.get("cpaMintMode") or "pkce").strip().lower()
    if m in ("device", "double", "pkce"):
        return m
    if m in ("auto", "c", "merged", "both"):
        return "double"
    return "pkce"


def load_auto_auth_export() -> bool:
    conf = _load_conf()
    if "auto_auth_export" in conf:
        return _truthy(conf.get("auto_auth_export"))
    if "autoAuthExport" in conf:
        return _truthy(conf.get("autoAuthExport"))
    return True


def load_worker_settings() -> tuple[int, int, float]:
    """返回 (workers, queue_max, enqueue_block_sec)。"""
    conf = _load_conf()
    workers = 2
    try:
        workers = int(
            conf.get("auth_export_workers")
            or conf.get("authExportWorkers")
            or os.environ.get("AUTH_EXPORT_WORKERS")
            or workers
        )
    except Exception:
        workers = 2
    workers = max(1, min(8, workers))

    qmax = 0
    try:
        raw = conf.get("auth_export_queue_max")
        if raw is None:
            raw = conf.get("authExportQueueMax")
        if raw is None:
            raw = os.environ.get("AUTH_EXPORT_QUEUE_MAX", "")
        if str(raw).strip() != "":
            qmax = int(raw)
    except Exception:
        qmax = 0
    if qmax <= 0:
        qmax = max(4, workers * 2)
    qmax = max(workers, min(qmax, 64))

    block_sec = 120.0
    try:
        block_sec = float(
            conf.get("auth_export_enqueue_block_sec")
            or conf.get("authExportEnqueueBlockSec")
            or os.environ.get("AUTH_EXPORT_ENQUEUE_BLOCK_SEC")
            or block_sec
        )
    except Exception:
        block_sec = 120.0
    block_sec = max(5.0, min(block_sec, 600.0))
    return workers, qmax, block_sec


def load_push_flags() -> dict[str, bool]:
    """自动推送开关（注册入队后由队列执行；与「允许推送」区分）。"""
    conf = _load_conf()
    push_sso = conf.get("push_sso_to_grok2api")
    if push_sso is None:
        push_sso = conf.get("pushSsoToGrok2api")
    # 兼容旧 grok2api_auto_upload
    auto_g2 = conf.get("grok2api_auto_upload")
    if auto_g2 is None:
        auto_g2 = conf.get("grok2apiAutoUpload")
    if push_sso is None and _truthy(auto_g2):
        do_sso_g2 = True
    else:
        do_sso_g2 = _truthy(push_sso)

    push_cpa = conf.get("push_auth_to_cpa")
    if push_cpa is None:
        push_cpa = conf.get("pushAuthToCpa")
    if push_cpa is None:
        push_cpa = conf.get("cpa_remote_push_enabled")
    do_cpa = _truthy(push_cpa)

    return {
        "sso_g2": do_sso_g2,
        "auth_cpa": do_cpa,
        "auto_auth": load_auto_auth_export(),
    }


def queue_stats() -> dict[str, int]:
    qsize = 0
    try:
        if _q is not None:
            qsize = _q.qsize()
    except Exception:
        qsize = 0
    return {
        "pending": max(0, _pending),
        "queue_size": qsize,
        "done_ok": _done_ok,
        "done_fail": _done_fail,
        "workers": _worker_count,
        "queue_max": _queue_max,
    }


def _run_sso_push_g2(
    *,
    sso: str,
    email: str,
    user_agent: str = "",
    cloudflare_cookies: str = "",
    log: LogFn,
) -> dict[str, Any]:
    try:
        from grok2api_client import (
            load_grok2api_settings_from_config,
            upload_registered_sso,
        )

        settings = load_grok2api_settings_from_config()
        conf = _load_conf()
        for k in (
            "grok2api_auto_upload",
            "push_sso_to_grok2api",
            "push_auth_to_grok2api",
            "grok2api_url",
            "grok2api_username",
            "grok2api_password",
            "grok2api_upload_mode",
        ):
            if k in conf and k not in settings:
                settings[k] = conf[k]
        # 强制本步只按 SSO 推送开关
        settings["push_sso_to_grok2api"] = True
        up = upload_registered_sso(
            settings,
            sso,
            email=email or "",
            user_agent=user_agent or "",
            cloudflare_cookies=cloudflare_cookies or "",
            log=log,
        )
        if up is None:
            return {"attempted": False, "ok": False, "skipped": True}
        log(f"[auth-queue] ✔ SSO→grok2api 成功 mode={up.get('mode')}")
        return {"attempted": True, "ok": True, "mode": up.get("mode"), "result": up}
    except Exception as e:
        log(f"[auth-queue] ✘ SSO→grok2api 失败: {e}")
        return {"attempted": True, "ok": False, "error": str(e)[:300]}


def _maybe_nsfw_and_sub2api(
    mint_result: dict[str, Any],
    *,
    conf: dict[str, Any],
    proxy: str,
    log: LogFn,
) -> None:
    """P3：mint 成功后可选开 NSFW + 导出 sub2api。"""
    if not mint_result or not mint_result.get("ok"):
        return
    # NSFW：对主 access 试一次（从写好的 auth 文件读 token）
    if _truthy(conf.get("enable_nsfw") or conf.get("enableNsfw")):
        try:
            from nsfw_toggle import enable_nsfw_for_token

            paths = mint_result.get("paths") or (
                [mint_result.get("path")] if mint_result.get("path") else []
            )
            for p in paths:
                if not p:
                    continue
                try:
                    doc = json.loads(Path(str(p)).read_text(encoding="utf-8"))
                    at = str(doc.get("access_token") or "")
                    if at:
                        enable_nsfw_for_token(at, proxy=proxy or "", log=log)
                        break
                except Exception:
                    continue
        except Exception as e:
            log(f"[auth-queue] nsfw skip: {e}")
    # sub2api 导出
    try:
        from cpa_to_sub2api import export_after_cpa_result

        export_after_cpa_result(mint_result, config=conf, log=log)
    except Exception as e:
        log(f"[auth-queue] sub2api skip: {e}")


def _run_mint_and_auth_push(
    *,
    sso: str,
    email: str,
    proxy: str,
    mint_mode: str,
    push_cpa: bool,
    log: LogFn,
    password: str = "",
) -> dict[str, Any]:
    try:
        from auth_service import sso_to_cpa_auth

        # skip_remote=False 时 mint 成功会按 config 推 CPA；
        # 若未开自动推 CPA，则 skip_remote=True 只写本地
        # require_grok_45=True：无 grok-4.5 的假活 token 不推 CPA
        r = sso_to_cpa_auth(
            sso=sso,
            email=email,
            proxy=proxy,
            mint_mode=mint_mode,
            skip_remote=not push_cpa,
            require_grok_45=True,
            log=log,
        )
        if r and r.get("ok"):
            paths = r.get("paths") or ([r.get("path")] if r.get("path") else [])
            log(
                f"[auth-queue] ✔ Auth mint OK email={r.get('email') or email or '-'} "
                f"mode={r.get('mint_mode') or mint_mode} "
                f"has_grok_45={r.get('has_grok_45')} "
                f"files={', '.join(str(p) for p in paths if p) or r.get('filename') or '-'}"
            )
            remote = r.get("remote")
            if push_cpa:
                if remote and remote.get("ok"):
                    log(f"[auth-queue] ✔ Auth→CPA 推送 OK name={remote.get('name')}")
                elif remote and not remote.get("ok"):
                    log(f"[auth-queue] ✘ Auth→CPA 推送失败: {remote.get('error')}")
                elif not remote:
                    log(
                        "[auth-queue] ⚠ 已开 Auth→CPA 自动推送，但未配置 cpa_remote_url/key 或跳过"
                    )
            # P3：可选 NSFW + sub2api（失败不挡主流程）
            conf = _load_conf()
            _maybe_nsfw_and_sub2api(r, conf=conf, proxy=proxy, log=log)
            return r
        # 可选：SSO 失败时密码路径 browser Device 兜底（P2）
        err = (r or {}).get("error") or "mint failed"
        if password and "require_grok_45" not in str(err):
            try:
                from browser_device_mint import mint_with_password_browser

                log(f"[auth-queue] 尝试 browser Device mint（密码路径）email={email or '-'}")
                br = mint_with_password_browser(
                    email=email,
                    password=password,
                    proxy=proxy,
                    log=log,
                )
                if br.get("ok") and br.get("access_token"):
                    from auth_service import tokens_to_cpa_auth

                    r2 = tokens_to_cpa_auth(
                        access_token=br["access_token"],
                        refresh_token=br.get("refresh_token") or "",
                        id_token=br.get("id_token"),
                        expires_in=br.get("expires_in"),
                        email=email,
                        sso=sso,
                        proxy=proxy,
                        skip_remote=not push_cpa,
                        require_grok_45=True,
                        mint_channel="browser_device",
                        log=log,
                    )
                    if r2 and r2.get("ok"):
                        log("[auth-queue] ✔ browser Device mint OK")
                        return r2
                    r = r2 or r
            except ImportError:
                pass
            except Exception as be:
                log(f"[auth-queue] browser Device mint 失败: {be}")
        log(
            f"[auth-queue] ✘ Auth mint 失败 email={email or '-'} "
            f"err={(r or {}).get('error') or 'unknown'}"
        )
        return r or {"ok": False, "error": "mint failed"}
    except Exception as e:
        log(f"[auth-queue] ✘ Auth mint 异常 email={email or '-'}: {e}")
        return {"ok": False, "error": str(e)}


def _process_job(job: dict[str, Any]) -> None:
    global _pending, _done_ok, _done_fail
    delay = int(job.get("delay_sec") or 0)
    email = str(job.get("email") or "")
    sso = str(job.get("sso") or "")
    proxy = str(job.get("proxy") or "")
    password = str(job.get("password") or "")
    mint_mode = str(job.get("mint_mode") or load_mint_mode())
    ua = str(job.get("user_agent") or "")
    cf = str(job.get("cloudflare_cookies") or "")
    flags = job.get("flags") if isinstance(job.get("flags"), dict) else load_push_flags()
    do_sso_g2 = bool(flags.get("sso_g2"))
    do_auth = bool(flags.get("auto_auth"))
    do_cpa = bool(flags.get("auth_cpa"))
    wid = threading.current_thread().name

    run_at = float(job.get("run_at") or 0)
    if run_at > 0:
        wait = run_at - time.time()
    else:
        wait = float(delay)
    if wait > 0:
        _log(
            f"[auth-queue][{wid}] 等待 {wait:.0f}s 后执行授权流水线"
            f" email={email or '-'} "
            f"sso_g2={'开' if do_sso_g2 else '关'} "
            f"mint={'开' if do_auth else '关'} "
            f"cpa={'开' if do_cpa else '关'} "
            f"· 队列剩余≈{(_q.qsize() if _q else 0)}"
        )
        end = time.time() + wait
        while time.time() < end:
            time.sleep(min(5.0, max(0.1, end - time.time())))

    if not sso:
        _log(f"[auth-queue][{wid}] ✘ 跳过空 SSO email={email or '-'}")
        _done_fail += 1
        return

    if not (do_sso_g2 or do_auth):
        _log(
            f"[auth-queue][{wid}] 跳过 email={email or '-'}：未开 SSO 推送且未开自动转换 Auth"
        )
        _done_ok += 1
        return

    _log(
        f"[auth-queue][{wid}] ▶ 授权流水线开始 email={email or '-'} "
        f"mode={mint_mode if do_auth else '-'}"
    )
    step_ok = True
    # 1) SSO → grok2api
    if do_sso_g2:
        g2 = _run_sso_push_g2(
            sso=sso,
            email=email,
            user_agent=ua,
            cloudflare_cookies=cf,
            log=_log,
        )
        if g2.get("attempted") and not g2.get("ok") and not g2.get("skipped"):
            step_ok = False
    # 2) mint + 3) Auth→CPA（mint 内 remote；has_grok_45 门禁）
    if do_auth:
        mint_r = _run_mint_and_auth_push(
            sso=sso,
            email=email,
            proxy=proxy,
            mint_mode=mint_mode,
            push_cpa=do_cpa,
            password=password,
            log=_log,
        )
        if not mint_r.get("ok"):
            step_ok = False
    elif do_cpa:
        _log(
            f"[auth-queue][{wid}] ⚠ 已开 Auth→CPA 但未开自动转换 Auth，无法推送（先 mint）"
        )

    if step_ok:
        _done_ok += 1
        _log(f"[auth-queue][{wid}] ✔ 流水线完成 email={email or '-'}")
    else:
        _done_fail += 1
        _log(f"[auth-queue][{wid}] ✘ 流水线部分失败 email={email or '-'}")


def _worker_loop() -> None:
    global _pending
    assert _q is not None
    while True:
        job = _q.get()
        try:
            if job is None:
                break
            _process_job(job)
        except Exception as e:
            global _done_fail
            _done_fail += 1
            _log(f"[auth-queue] worker 异常: {e}")
        finally:
            with _lock:
                _pending = max(0, _pending - 1)
            _q.task_done()


def ensure_worker() -> None:
    global _q, _workers, _started, _worker_count, _queue_max, _enqueue_block_sec
    with _lock:
        alive = [t for t in _workers if t.is_alive()]
        _workers = alive
        if _started and alive and _q is not None:
            return
        workers, qmax, block_sec = load_worker_settings()
        _worker_count = workers
        _queue_max = qmax
        _enqueue_block_sec = block_sec
        if _q is None:
            _q = queue.Queue(maxsize=qmax)
        # 补齐 worker
        need = workers - len(alive)
        for i in range(need):
            t = threading.Thread(
                target=_worker_loop,
                name=f"auth-export-w{len(alive) + i + 1}",
                daemon=True,
            )
            t.start()
            _workers.append(t)
        _started = True
        _log(
            f"[auth-queue] 授权后台队列已启动 workers={workers} queue_max={qmax} "
            f"（注册只交 SSO，不阻塞）"
        )


def enqueue_sso_to_auth(
    *,
    sso: str,
    email: str = "",
    proxy: str = "",
    mint_mode: str = "",
    user_agent: str = "",
    cloudflare_cookies: str = "",
    password: str = "",
    delay_min_sec: int | None = None,
    delay_max_sec: int | None = None,
    log: Optional[LogFn] = None,
) -> dict[str, Any]:
    """入队授权流水线（SSO 推送 + Auth 转换 + Auth 推送）。

    兼容旧名 enqueue_sso_to_auth。
    队列满时阻塞最多 enqueue_block_sec，超时返回 backpressure 错误（不丢已入队任务）。
    """
    global _pending
    sso = (sso or "").strip()
    if not sso:
        return {"queued": False, "error": "empty sso"}

    lo, hi = load_delay_range()
    if delay_min_sec is not None:
        lo = max(0, int(delay_min_sec))
    if delay_max_sec is not None:
        hi = max(lo, int(delay_max_sec))
    delay = random.randint(lo, hi) if hi > lo else lo
    run_at = time.time() + delay
    mode = (mint_mode or load_mint_mode() or "pkce").strip().lower()
    flags = load_push_flags()

    # 全关则仍入队但 worker 会 skip；也可直接不入队
    if not flags["sso_g2"] and not flags["auto_auth"]:
        _log(
            f"[auth-queue] 未入队：自动转换 Auth 与 SSO→g2 均关 email={email or '-'}",
            log,
        )
        return {
            "queued": False,
            "error": "auto_auth_export and push_sso both off",
            "skipped": True,
            "flags": flags,
        }

    ensure_worker()
    assert _q is not None
    job = {
        "sso": sso,
        "email": (email or "").strip(),
        "password": (password or "").strip(),
        "proxy": (proxy or "").strip(),
        "mint_mode": mode,
        "user_agent": (user_agent or "").strip(),
        "cloudflare_cookies": (cloudflare_cookies or "").strip(),
        "flags": flags,
        "delay_sec": delay,
        "run_at": run_at,
        "enqueued_at": time.time(),
    }
    try:
        _q.put(job, timeout=_enqueue_block_sec)
    except queue.Full:
        _log(
            f"[auth-queue] ✘ 入队失败：队列已满 queue_max={_queue_max} "
            f"pending≈{_pending} email={email or '-'}（背压，未丢已入队任务）",
            log,
        )
        return {
            "queued": False,
            "error": f"queue full (max={_queue_max})",
            "backpressure": True,
            "pending": _pending,
            "flags": flags,
        }
    with _lock:
        _pending += 1
    _log(
        f"[auth-queue] 已入队授权流水线 email={email or '-'} "
        f"delay={delay}s（{lo}～{hi}） "
        f"sso_g2={'开' if flags['sso_g2'] else '关'} "
        f"mint={'开' if flags['auto_auth'] else '关'} "
        f"cpa={'开' if flags['auth_cpa'] else '关'} "
        f"mode={mode} · 排队中≈{_pending} workers={_worker_count}",
        log,
    )
    return {
        "queued": True,
        "delay_sec": delay,
        "run_at": run_at,
        "pending": _pending,
        "mint_mode": mode,
        "flags": flags,
        "workers": _worker_count,
        "queue_max": _queue_max,
    }


# 语义更清晰的别名
enqueue_authorization = enqueue_sso_to_auth


def wait_queue_idle(timeout: float = 0) -> bool:
    """进程退出前等待队列清空。timeout<=0 表示只检查、不等。"""
    if _q is None:
        return True
    if timeout <= 0:
        return _q.unfinished_tasks == 0
    end = time.time() + timeout
    while time.time() < end:
        if _q.unfinished_tasks == 0 and _pending <= 0:
            return True
        time.sleep(0.5)
    return _q.unfinished_tasks == 0 and _pending <= 0


def shutdown_workers(timeout: float = 30.0) -> None:
    """发送停止信号并等待 worker 退出（可选，进程结束前调用）。"""
    global _started
    if _q is None:
        return
    with _lock:
        n = len([t for t in _workers if t.is_alive()])
    for _ in range(n):
        try:
            _q.put(None, timeout=2.0)
        except queue.Full:
            break
    end = time.time() + max(1.0, timeout)
    for t in list(_workers):
        remain = end - time.time()
        if remain <= 0:
            break
        t.join(timeout=remain)
    with _lock:
        _started = False
