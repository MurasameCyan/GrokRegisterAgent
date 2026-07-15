# -*- coding: utf-8 -*-
"""账号侧车标签（NSFW 等），供 SSO 号池 / Auth 列表展示。

落盘: register/data/account_tags.json
  {
    "by_email": { "a@b.com": { "nsfw_enabled": true, "nsfw_at": "..." } },
    "by_sso_hash": { "sha256...": { ... } }
  }
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

_LOCK = threading.Lock()
_PATH = Path(__file__).resolve().parent / "data" / "account_tags.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_sso(sso: str) -> str:
    s = str(sso or "").strip()
    if s.lower().startswith("sso="):
        s = s[4:].strip()
    return s


def sso_hash(sso: str) -> str:
    t = normalize_sso(sso)
    if not t or len(t) < 8:
        return ""
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


def _load() -> dict[str, Any]:
    try:
        if _PATH.is_file():
            data = json.loads(_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                data.setdefault("by_email", {})
                data.setdefault("by_sso_hash", {})
                return data
    except Exception:
        pass
    return {"by_email": {}, "by_sso_hash": {}}


def _save(data: dict[str, Any]) -> None:
    _PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = _PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(_PATH)


def set_nsfw_tag(
    *,
    enabled: bool,
    email: str = "",
    sso: str = "",
    error: str = "",
    steps: Any = None,
) -> dict[str, Any]:
    """写入 NSFW 开启结果（成功/失败都记）。"""
    tag = {
        "nsfw_enabled": bool(enabled),
        "nsfw_attempted": True,
        "nsfw_at": _now_iso(),
        "nsfw_error": (error or "")[:300] if not enabled else "",
    }
    if steps is not None:
        try:
            tag["nsfw_steps"] = steps
        except Exception:
            pass
    with _LOCK:
        data = _load()
        email_k = str(email or "").strip().lower()
        if email_k:
            prev = dict(data["by_email"].get(email_k) or {})
            prev.update(tag)
            data["by_email"][email_k] = prev
        h = sso_hash(sso)
        if h:
            prev = dict(data["by_sso_hash"].get(h) or {})
            prev.update(tag)
            data["by_sso_hash"][h] = prev
        _save(data)
    return tag


def get_tag(*, email: str = "", sso: str = "") -> dict[str, Any]:
    with _LOCK:
        data = _load()
    email_k = str(email or "").strip().lower()
    if email_k and email_k in data.get("by_email", {}):
        return dict(data["by_email"][email_k] or {})
    h = sso_hash(sso)
    if h and h in data.get("by_sso_hash", {}):
        return dict(data["by_sso_hash"][h] or {})
    return {}


def dump_all() -> dict[str, Any]:
    with _LOCK:
        return _load()


def patch_auth_file_nsfw(path: str | Path, *, enabled: bool, error: str = "") -> bool:
    """把 nsfw 字段写回 CPA auth JSON（不挡主流程）。"""
    p = Path(path)
    if not p.is_file():
        return False
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(doc, dict):
            return False
        doc["nsfw_enabled"] = bool(enabled)
        doc["nsfw_attempted"] = True
        doc["nsfw_at"] = _now_iso()
        if not enabled and error:
            doc["nsfw_error"] = str(error)[:300]
        elif enabled:
            doc.pop("nsfw_error", None)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(p)
        return True
    except Exception:
        return False
