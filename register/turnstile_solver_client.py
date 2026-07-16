# -*- coding: utf-8 -*-
"""外置 Turnstile Solver / YesCaptcha 客户端（可选）。

配置来自 register/config.json 或环境变量：
  turnstile_solver_enabled / TURNSTILE_SOLVER_ENABLED
  turnstile_solver_url     / TURNSTILE_SOLVER_URL   (默认 http://turnstile-solver:5072)
  yescaptcha_key           / YESCAPTCHA_KEY

协议对齐 grok1 TurnstileService：
  本地: GET {url}/turnstile?url=&sitekey= → taskId
        GET {url}/result?id= → solution.token
  YesCaptcha: createTask / getTaskResult
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import quote
from urllib.request import Request, urlopen

LogFn = Callable[[str], None]

_DEFAULT_SITE_URL = "https://accounts.x.ai"
_DEFAULT_SITEKEY = "0x4AAAAAAAhr9JGVDZbrZOo0"
_YESCAPTCHA_API = "https://api.yescaptcha.com"


def _lg(log: Optional[LogFn], msg: str) -> None:
    if log:
        try:
            log(msg)
            return
        except Exception:
            pass
    print(msg, flush=True)


def _load_cfg() -> dict[str, Any]:
    p = Path(__file__).resolve().parent / "config.json"
    try:
        if p.is_file():
            data = json.loads(p.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
    except Exception:
        pass
    return {}


def solver_enabled(cfg: Optional[dict[str, Any]] = None) -> bool:
    c = cfg if cfg is not None else _load_cfg()
    env = os.getenv("TURNSTILE_SOLVER_ENABLED", "").strip().lower()
    if env in ("1", "true", "yes", "on"):
        return True
    if env in ("0", "false", "no", "off"):
        return False
    if c.get("turnstile_solver_enabled") is True:
        return True
    # URL 显式配置且非空也视为可用意图（enabled 默认 false，需开关）
    return bool(c.get("turnstile_solver_enabled"))


def solver_url(cfg: Optional[dict[str, Any]] = None) -> str:
    c = cfg if cfg is not None else _load_cfg()
    u = (
        os.getenv("TURNSTILE_SOLVER_URL", "").strip()
        or str(c.get("turnstile_solver_url") or "").strip()
        or "http://turnstile-solver:5072"
    )
    return u.rstrip("/")


def yescaptcha_key(cfg: Optional[dict[str, Any]] = None) -> str:
    c = cfg if cfg is not None else _load_cfg()
    return (
        os.getenv("YESCAPTCHA_KEY", "").strip()
        or str(c.get("yescaptcha_key") or "").strip()
    )


def sitekey_default(cfg: Optional[dict[str, Any]] = None) -> str:
    c = cfg if cfg is not None else _load_cfg()
    return str(c.get("turnstile_sitekey") or _DEFAULT_SITEKEY).strip() or _DEFAULT_SITEKEY


def _http_json(
    method: str,
    url: str,
    *,
    body: Optional[dict] = None,
    timeout: float = 20.0,
) -> dict[str, Any]:
    data = None
    headers = {"Accept": "application/json", "User-Agent": "GrokRegisterAgent/turnstile-solver-client"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = Request(url, data=data, headers=headers, method=method.upper())
    with urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        if not raw.strip():
            return {}
        out = json.loads(raw)
        return out if isinstance(out, dict) else {}


def probe_solver(
    url: str = "",
    *,
    timeout: float = 5.0,
    log: Optional[LogFn] = None,
) -> dict[str, Any]:
    """探活本地 solver。返回 {ok, message, latency_ms, url}。"""
    base = (url or solver_url()).rstrip("/")
    if not base:
        return {"ok": False, "message": "未配置 solver URL", "url": "", "latency_ms": 0}
    t0 = time.time()
    try:
        req = Request(
            base + "/",
            headers={"User-Agent": "GrokRegisterAgent/probe"},
            method="GET",
        )
        with urlopen(req, timeout=timeout) as resp:
            status = int(getattr(resp, "status", 200) or 200)
            _ = resp.read(2048)
        ms = int((time.time() - t0) * 1000)
        if 200 <= status < 500:
            return {
                "ok": True,
                "message": f"solver 可达 HTTP {status}",
                "url": base,
                "latency_ms": ms,
            }
        return {
            "ok": False,
            "message": f"HTTP {status}",
            "url": base,
            "latency_ms": ms,
        }
    except Exception as e:
        ms = int((time.time() - t0) * 1000)
        return {
            "ok": False,
            "message": str(e) or "connect failed",
            "url": base,
            "latency_ms": ms,
        }


def _solve_local(
    siteurl: str,
    sitekey: str,
    *,
    base_url: str,
    max_wait: float = 90.0,
    log: Optional[LogFn] = None,
) -> str:
    q = f"{base_url}/turnstile?url={quote(siteurl, safe='')}&sitekey={quote(sitekey, safe='')}"
    data = _http_json("GET", q, timeout=30.0)
    task_id = str(data.get("taskId") or data.get("task_id") or "").strip()
    if not task_id:
        raise RuntimeError(f"solver create task failed: {data}")
    _lg(log, f"[turnstile-solver] taskId={task_id[:16]}…")
    deadline = time.time() + max(15.0, float(max_wait or 90))
    time.sleep(3.0)
    while time.time() < deadline:
        try:
            r = _http_json("GET", f"{base_url}/result?id={quote(task_id, safe='')}", timeout=15.0)
            sol = r.get("solution") if isinstance(r.get("solution"), dict) else {}
            tok = str((sol or {}).get("token") or r.get("token") or "").strip()
            if tok and tok != "CAPTCHA_FAIL" and len(tok) >= 80:
                _lg(log, f"[turnstile-solver] token len={len(tok)}")
                return tok
            if tok == "CAPTCHA_FAIL":
                _lg(log, "[turnstile-solver] CAPTCHA_FAIL")
                return ""
        except Exception as e:
            _lg(log, f"[turnstile-solver] poll: {e}")
        time.sleep(2.0)
    _lg(log, "[turnstile-solver] timeout")
    return ""


def _solve_yescaptcha(
    siteurl: str,
    sitekey: str,
    *,
    key: str,
    max_wait: float = 120.0,
    log: Optional[LogFn] = None,
) -> str:
    data = _http_json(
        "POST",
        f"{_YESCAPTCHA_API}/createTask",
        body={
            "clientKey": key,
            "task": {
                "type": "TurnstileTaskProxyless",
                "websiteURL": siteurl,
                "websiteKey": sitekey,
            },
        },
        timeout=30.0,
    )
    if int(data.get("errorId") or 0) != 0:
        raise RuntimeError(data.get("errorDescription") or str(data))
    task_id = str(data.get("taskId") or "").strip()
    if not task_id:
        raise RuntimeError(f"YesCaptcha no taskId: {data}")
    _lg(log, f"[yescaptcha] taskId={task_id[:16]}…")
    deadline = time.time() + max(20.0, float(max_wait or 120))
    time.sleep(5.0)
    while time.time() < deadline:
        r = _http_json(
            "POST",
            f"{_YESCAPTCHA_API}/getTaskResult",
            body={"clientKey": key, "taskId": task_id},
            timeout=20.0,
        )
        if int(r.get("errorId") or 0) != 0:
            _lg(log, f"[yescaptcha] error: {r.get('errorDescription')}")
            return ""
        if r.get("status") == "ready":
            tok = str((r.get("solution") or {}).get("token") or "").strip()
            if len(tok) >= 80:
                _lg(log, f"[yescaptcha] token len={len(tok)}")
                return tok
            return ""
        time.sleep(2.0)
    _lg(log, "[yescaptcha] timeout")
    return ""


def solve_turnstile(
    siteurl: str = _DEFAULT_SITE_URL,
    sitekey: str = "",
    *,
    prefer: str = "auto",
    max_wait: float = 90.0,
    log: Optional[LogFn] = None,
) -> str:
    """解 Turnstile，返回 token 或空串。

    prefer: auto | local | yescaptcha
      auto: 若 solver enabled 先本地；否则/失败再 YesCaptcha（有 key）
    """
    cfg = _load_cfg()
    sk = (sitekey or sitekey_default(cfg)).strip()
    url = (siteurl or _DEFAULT_SITE_URL).strip()
    pref = (prefer or "auto").strip().lower()
    local_on = solver_enabled(cfg)
    yc = yescaptcha_key(cfg)
    base = solver_url(cfg)

    errors: list[str] = []

    def try_local() -> str:
        if not local_on and pref != "local":
            return ""
        try:
            return _solve_local(url, sk, base_url=base, max_wait=max_wait, log=log)
        except Exception as e:
            errors.append(f"local:{e}")
            _lg(log, f"[turnstile-solver] local fail: {e}")
            return ""

    def try_yc() -> str:
        if not yc:
            return ""
        try:
            return _solve_yescaptcha(url, sk, key=yc, max_wait=max_wait, log=log)
        except Exception as e:
            errors.append(f"yc:{e}")
            _lg(log, f"[yescaptcha] fail: {e}")
            return ""

    if pref == "yescaptcha":
        return try_yc()
    if pref == "local":
        return try_local()

    # auto
    tok = try_local()
    if tok and len(tok) >= 80:
        return tok
    tok = try_yc()
    if tok and len(tok) >= 80:
        return tok
    if errors:
        _lg(log, f"[turnstile-solver] all failed: {'; '.join(errors)}")
    return ""
