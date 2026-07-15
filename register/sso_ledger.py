# -*- coding: utf-8 -*-
"""
W3 · SSO 指纹账本：成功落盘/入队前原子去重。

文件: register/data/sso_identities.json
  {
    "by_hash": {
      "sha256hex": {
        "email": "...",
        "first_seen": "ISO",
        "last_seen": "ISO",
        "count": 1
      }
    }
  }
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

_ROOT = Path(__file__).resolve().parent
_DEFAULT_PATH = _ROOT / "data" / "sso_identities.json"
_lock = threading.RLock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sso_fingerprint(sso: str) -> str:
    t = str(sso or "").strip()
    if t.lower().startswith("sso="):
        t = t[4:].strip()
    if not t or len(t) < 8:
        return ""
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


def ledger_path() -> Path:
    env = os.environ.get("SSO_LEDGER_PATH", "").strip()
    if env:
        return Path(env)
    return _DEFAULT_PATH


def _load(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {"by_hash": {}}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return {"by_hash": {}}
        bh = raw.get("by_hash")
        if not isinstance(bh, dict):
            raw["by_hash"] = {}
        return raw
    except Exception:
        return {"by_hash": {}}


def _save(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def is_duplicate(sso: str, path: Optional[Path] = None) -> bool:
    fp = sso_fingerprint(sso)
    if not fp:
        return False
    p = path or ledger_path()
    with _lock:
        data = _load(p)
        return fp in (data.get("by_hash") or {})


def register_sso(
    sso: str,
    *,
    email: str = "",
    path: Optional[Path] = None,
    allow_duplicate: bool = False,
) -> dict[str, Any]:
    """
    登记 SSO 指纹。

    返回:
      { ok, duplicate, fingerprint, email, count }
    若 duplicate 且 not allow_duplicate：不更新 count 的「首次」语义，ok=False。
    """
    fp = sso_fingerprint(sso)
    if not fp:
        return {"ok": False, "duplicate": False, "error": "empty sso", "fingerprint": ""}

    p = path or ledger_path()
    email_n = str(email or "").strip().lower()
    with _lock:
        data = _load(p)
        bh: dict[str, Any] = data.setdefault("by_hash", {})
        prev = bh.get(fp)
        if prev and not allow_duplicate:
            # 更新 last_seen / count 便于审计，但标记 duplicate
            try:
                prev["last_seen"] = _now_iso()
                prev["count"] = int(prev.get("count") or 1) + 1
                if email_n and not prev.get("email"):
                    prev["email"] = email_n
                bh[fp] = prev
                _save(p, data)
            except Exception:
                pass
            return {
                "ok": False,
                "duplicate": True,
                "fingerprint": fp,
                "email": str(prev.get("email") or email_n),
                "count": int(prev.get("count") or 1),
                "first_seen": prev.get("first_seen"),
            }

        now = _now_iso()
        if prev:
            entry = dict(prev)
            entry["last_seen"] = now
            entry["count"] = int(entry.get("count") or 1) + 1
            if email_n:
                entry["email"] = email_n
        else:
            entry = {
                "email": email_n,
                "first_seen": now,
                "last_seen": now,
                "count": 1,
            }
        bh[fp] = entry
        _save(p, data)
        return {
            "ok": True,
            "duplicate": bool(prev),
            "fingerprint": fp,
            "email": email_n,
            "count": int(entry.get("count") or 1),
            "first_seen": entry.get("first_seen"),
        }


def claim_sso(
    sso: str,
    *,
    email: str = "",
    path: Optional[Path] = None,
) -> dict[str, Any]:
    """原子：若未见过则登记并 ok=True；若已见过则 duplicate=True, ok=False。"""
    return register_sso(sso, email=email, path=path, allow_duplicate=False)
