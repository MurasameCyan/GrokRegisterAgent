# -*- coding: utf-8 -*-
"""
交付状态机（轻量 JSON，对齐 master2 durable 思路）：

  pending → uploading → success | failed
  失败可重试（后台 scan + retry）

文件: register/data/delivery_jobs.json
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

LogFn = Callable[[str], None]

_ROOT = Path(__file__).resolve().parent
_DEFAULT_PATH = _ROOT / "data" / "delivery_jobs.json"
_lock = threading.RLock()

# channel: sso_g2 | auth_cpa | sub2api | nsfw
VALID_STATUS = frozenset({"pending", "uploading", "success", "failed"})


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def store_path() -> Path:
    env = os.environ.get("DELIVERY_STORE_PATH", "").strip()
    if env:
        return Path(env)
    return _DEFAULT_PATH


def _load(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {"jobs": []}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return {"jobs": []}
        jobs = raw.get("jobs")
        if not isinstance(jobs, list):
            raw["jobs"] = []
        return raw
    except Exception:
        return {"jobs": []}


def _save(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def create_job(
    *,
    channel: str,
    email: str = "",
    sso_fp: str = "",
    payload: Optional[dict[str, Any]] = None,
    max_attempts: int = 5,
) -> dict[str, Any]:
    job = {
        "id": uuid.uuid4().hex[:16],
        "channel": str(channel or "").strip(),
        "email": str(email or "").strip().lower(),
        "sso_fp": str(sso_fp or "").strip(),
        "status": "pending",
        "attempts": 0,
        "max_attempts": max(1, int(max_attempts)),
        "error": "",
        "payload": payload if isinstance(payload, dict) else {},
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
        "next_retry_at": 0.0,
    }
    p = store_path()
    with _lock:
        data = _load(p)
        data["jobs"].append(job)
        # 简单裁剪：保留最近 2000
        if len(data["jobs"]) > 2000:
            data["jobs"] = data["jobs"][-2000:]
        _save(p, data)
    return dict(job)


def update_job(
    job_id: str,
    *,
    status: Optional[str] = None,
    error: str = "",
    bump_attempt: bool = False,
    retry_after_sec: float = 0,
    extra: Optional[dict[str, Any]] = None,
) -> Optional[dict[str, Any]]:
    p = store_path()
    with _lock:
        data = _load(p)
        found = None
        for j in data["jobs"]:
            if str(j.get("id")) == str(job_id):
                found = j
                break
        if not found:
            return None
        if status and status in VALID_STATUS:
            found["status"] = status
        if error is not None:
            found["error"] = str(error or "")[:500]
        if bump_attempt:
            found["attempts"] = int(found.get("attempts") or 0) + 1
        if retry_after_sec and retry_after_sec > 0:
            found["next_retry_at"] = time.time() + float(retry_after_sec)
        else:
            found["next_retry_at"] = 0.0
        if extra and isinstance(extra, dict):
            pl = found.get("payload") if isinstance(found.get("payload"), dict) else {}
            pl.update(extra)
            found["payload"] = pl
        found["updated_at"] = _now_iso()
        _save(p, data)
        return dict(found)


def list_retryable(*, now: Optional[float] = None, limit: int = 50) -> list[dict[str, Any]]:
    """pending / failed / 超时 uploading 且 attempts < max 且 next_retry 已到。"""
    now = time.time() if now is None else now
    p = store_path()
    out: list[dict[str, Any]] = []
    with _lock:
        data = _load(p)
        for j in data["jobs"]:
            st = str(j.get("status") or "")
            if st not in ("pending", "failed", "uploading"):
                continue
            # uploading 超过 15 分钟视为僵死，允许补传
            if st == "uploading":
                try:
                    # updated_at ISO → 粗略：用 next_retry 或 created 时间戳字段没有则放行超时
                    ua = str(j.get("updated_at") or "")
                    # 无可靠解析时用 next_retry_at 作辅助；否则用 payload 内 started 无则按 attempts 判断
                    # 简化：uploading 且 next_retry_at 为 0 且 attempts>=1 → 需 age；用文件 mtime 不可
                    # 用 attempts + 无 next：默认 900s 僵死窗口，记录在 payload._upload_since
                    pl = j.get("payload") if isinstance(j.get("payload"), dict) else {}
                    since = float(pl.get("_upload_since") or 0)
                    if since and (now - since) < 900:
                        continue
                    if not since:
                        # 刚 mark_uploading 的写入 _upload_since
                        continue
                except Exception:
                    continue
            if int(j.get("attempts") or 0) >= int(j.get("max_attempts") or 5):
                continue
            nra = float(j.get("next_retry_at") or 0)
            if nra and nra > now:
                continue
            out.append(dict(j))
            if len(out) >= limit:
                break
    return out


def mark_uploading(job_id: str) -> Optional[dict[str, Any]]:
    return update_job(
        job_id,
        status="uploading",
        bump_attempt=True,
        extra={"_upload_since": time.time()},
    )


def mark_success(job_id: str) -> Optional[dict[str, Any]]:
    return update_job(job_id, status="success", error="")


def mark_failed(job_id: str, error: str, *, retry_after_sec: float = 60) -> Optional[dict[str, Any]]:
    return update_job(
        job_id,
        status="failed",
        error=error,
        retry_after_sec=retry_after_sec,
    )




def has_success_for_email(channel: str, email: str) -> bool:
    em = str(email or '').strip().lower()
    ch = str(channel or '').strip()
    if not em or not ch:
        return False
    p = store_path()
    with _lock:
        data = _load(p)
        for j in data.get('jobs') or []:
            if not isinstance(j, dict):
                continue
            if str(j.get('channel') or '') != ch:
                continue
            if str(j.get('status') or '') != 'success':
                continue
            if str(j.get('email') or '').strip().lower() == em:
                return True
    return False


def success_emails_for_channel(channel: str) -> set:
    ch = str(channel or '').strip()
    out = set()
    if not ch:
        return out
    p = store_path()
    with _lock:
        data = _load(p)
        for j in data.get('jobs') or []:
            if not isinstance(j, dict):
                continue
            if str(j.get('channel') or '') != ch:
                continue
            if str(j.get('status') or '') != 'success':
                continue
            em = str(j.get('email') or '').strip().lower()
            if em:
                out.add(em)
    return out



def stamp_auth_file_push_flags(
    paths: list[str] | list[Path] | str | Path | None,
    *,
    pushed_cpa: bool = False,
    pushed_s2a: bool = False,
) -> int:
    """Write pushed_cpa / pushed_s2a flags into auth JSON files. Returns stamped count."""
    if not paths:
        return 0
    if isinstance(paths, (str, Path)):
        paths = [paths]
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    n = 0
    for raw in paths:
        p = Path(str(raw or "")).expanduser()
        if not p.is_file():
            continue
        try:
            doc = json.loads(p.read_text(encoding="utf-8"))
            if not isinstance(doc, dict):
                continue
            if pushed_cpa:
                doc["pushed_cpa"] = True
                doc["pushedCpa"] = True
                doc["pushed_cpa_at"] = now
                doc["pushedCpaAt"] = now
            if pushed_s2a:
                doc["pushed_s2a"] = True
                doc["pushedS2a"] = True
                doc["pushed_s2a_at"] = now
                doc["pushedS2aAt"] = now
            tmp = p.with_suffix(p.suffix + ".tmp")
            tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(p)
            n += 1
        except Exception:
            continue
    return n


def mark_accounts_pushed_g2a(email: str = "", sso: str = "") -> bool:
    """Best-effort: set pushedG2a on matching accounts.json row."""
    em = str(email or "").strip().lower()
    if not em and not sso:
        return False
    import os
    candidates = []
    data = os.environ.get("DATA_DIR", "").strip()
    if data:
        candidates.append(Path(data) / "accounts.json")
    candidates.extend(
        [
            Path("/data/accounts.json"),
            Path(__file__).resolve().parent.parent / "data" / "accounts.json",
            Path.cwd() / "data" / "accounts.json",
        ]
    )
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for ap in candidates:
        if not ap.is_file():
            continue
        try:
            arr = json.loads(ap.read_text(encoding="utf-8"))
            if not isinstance(arr, list):
                continue
            changed = False
            for row in arr:
                if not isinstance(row, dict):
                    continue
                hit = False
                if em and str(row.get("email") or "").strip().lower() == em:
                    hit = True
                if hit and row.get("pushedG2a") is not True:
                    row["pushedG2a"] = True
                    row["pushedG2aAt"] = now
                    changed = True
            if changed:
                tmp = ap.with_suffix(".tmp")
                tmp.write_text(json.dumps(arr, ensure_ascii=False, indent=2), encoding="utf-8")
                tmp.replace(ap)
                return True
        except Exception:
            continue
    return False


# ── 后台补传 worker ──────────────────────────────────────────
_retry_thread: Optional[threading.Thread] = None
_retry_stop = threading.Event()
_handlers: dict[str, Callable[[dict[str, Any], LogFn], bool]] = {}


def register_channel_handler(
    channel: str, handler: Callable[[dict[str, Any], LogFn], bool]
) -> None:
    """handler(job, log) -> True 表示成功。"""
    _handlers[str(channel)] = handler


def _default_log(msg: str) -> None:
    print(msg, flush=True)


def process_retryable_once(log: Optional[LogFn] = None) -> int:
    """处理一批可重试任务，返回成功数。"""
    log = log or _default_log
    jobs = list_retryable(limit=20)
    ok_n = 0
    for job in jobs:
        ch = str(job.get("channel") or "")
        handler = _handlers.get(ch)
        if not handler:
            continue
        jid = str(job.get("id"))
        mark_uploading(jid)
        try:
            ok = bool(handler(job, log))
        except Exception as e:
            ok = False
            mark_failed(jid, str(e)[:300], retry_after_sec=min(600, 30 * (int(job.get("attempts") or 1))))
            log(f"[delivery] {ch} retry err job={jid}: {e}")
            continue
        if ok:
            mark_success(jid)
            ok_n += 1
            log(f"[delivery] ✔ {ch} job={jid} email={job.get('email') or '-'}")
        else:
            att = int(job.get("attempts") or 0) + 1
            mark_failed(
                jid,
                job.get("error") or "handler returned false",
                retry_after_sec=min(600, 30 * att),
            )
            log(f"[delivery] ✘ {ch} job={jid} will retry")
    return ok_n


def ensure_retry_worker(interval_sec: float = 60.0, log: Optional[LogFn] = None) -> None:
    global _retry_thread
    log = log or _default_log
    with _lock:
        if _retry_thread is not None and _retry_thread.is_alive():
            return
        _retry_stop.clear()

        def _loop() -> None:
            log(f"[delivery] 补传 worker 已启动 interval={interval_sec}s")
            while not _retry_stop.is_set():
                try:
                    process_retryable_once(log)
                except Exception as e:
                    log(f"[delivery] worker 异常: {e}")
                _retry_stop.wait(interval_sec)

        t = threading.Thread(target=_loop, name="delivery-retry", daemon=True)
        t.start()
        _retry_thread = t
