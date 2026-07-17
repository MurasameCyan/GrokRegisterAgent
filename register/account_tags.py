# -*- coding: utf-8 -*-
"""账号侧车标签（NSFW 等），供 SSO 号池 / Auth 列表展示。

落盘优先级（写用第一可写路径；读合并候选）:
  1) $DATA_DIR/account_tags.json   ← Docker 持久卷 ./data:/data，重建镜像不丢
  2) register/data/account_tags.json  ← 兼容旧数据（entrypoint 须 exclude data/）
  {
    "by_email": { "a@b.com": { "nsfw_enabled": true, "nsfw_at": "..." } },
    "by_sso_hash": { "sha256...": { ... } }
  }
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

_LOCK = threading.Lock()

# 与 Node settingsStore / docker-compose DATA_DIR 默认一致
_DEFAULT_DATA_DIR = "/data"


def _data_dir() -> Path:
    raw = (os.environ.get("DATA_DIR") or "").strip()
    if raw:
        return Path(raw).expanduser()
    # Docker/生产默认；本地开发也可设 DATA_DIR
    return Path(_DEFAULT_DATA_DIR)


def _path_candidates() -> list[Path]:
    """读/写候选路径。DATA_DIR 优先，避免 hot-sync 覆盖 register/data。"""
    out: list[Path] = []
    out.append(_data_dir() / "account_tags.json")
    # 兼容旧路径（可能已被 rsync 清过）
    reg = Path(__file__).resolve().parent
    out.append(reg / "data" / "account_tags.json")
    out.append(reg / "account_tags.json")
    # 去重保序
    seen: set[str] = set()
    uniq: list[Path] = []
    for p in out:
        try:
            k = str(p.resolve())
        except Exception:
            k = str(p)
        if k not in seen:
            seen.add(k)
            uniq.append(p)
    return uniq


def _primary_path() -> Path:
    """写路径：始终 DATA_DIR（持久卷），不写会随镜像重建被清掉的路径。"""
    return _data_dir() / "account_tags.json"


def primary_tags_path() -> str:
    """供日志/诊断。"""
    return str(_primary_path())


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


def _merge_tag_maps(base: dict[str, Any], extra: dict[str, Any]) -> dict[str, Any]:
    """合并 by_email / by_sso_hash；extra 覆盖同 key。"""
    out = {
        "by_email": dict(base.get("by_email") or {}),
        "by_sso_hash": dict(base.get("by_sso_hash") or {}),
    }
    for k, v in (extra.get("by_email") or {}).items():
        if isinstance(v, dict):
            prev = dict(out["by_email"].get(k) or {})
            prev.update(v)
            out["by_email"][k] = prev
    for k, v in (extra.get("by_sso_hash") or {}).items():
        if isinstance(v, dict):
            prev = dict(out["by_sso_hash"].get(k) or {})
            prev.update(v)
            out["by_sso_hash"][k] = prev
    return out


def _load() -> dict[str, Any]:
    """从所有候选路径合并读取（DATA_DIR 最后写入优先）。"""
    merged: dict[str, Any] = {"by_email": {}, "by_sso_hash": {}}
    for path in reversed(_path_candidates()):  # 低优先级先，高优先级后覆盖
        try:
            if not path.is_file():
                continue
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                data.setdefault("by_email", {})
                data.setdefault("by_sso_hash", {})
                merged = _merge_tag_maps(merged, data)
        except Exception:
            continue
    return merged


def _save(data: dict[str, Any]) -> Path:
    """只写 DATA_DIR 持久路径；返回写入路径。"""
    path = _primary_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    payload = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(path)
    # 可选：再镜像到 register/data（仅备份；失败忽略）。主源始终是 DATA_DIR。
    try:
        legacy = Path(__file__).resolve().parent / "data" / "account_tags.json"
        if path.resolve() != legacy.resolve():
            legacy.parent.mkdir(parents=True, exist_ok=True)
            legacy.write_text(payload, encoding="utf-8")
    except Exception:
        pass
    return path


def set_nsfw_tag(
    *,
    enabled: bool,
    email: str = "",
    sso: str = "",
    error: str = "",
    steps: Any = None,
) -> dict[str, Any]:
    """写入 NSFW 开启结果（成功/失败都记）。始终落盘到 DATA_DIR。"""
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
        if not email_k and not h:
            # 无键无法索引：仍写入空操作避免静默丢
            raise ValueError("set_nsfw_tag requires email or sso")
        written = _save(data)
        tag["_written_to"] = str(written)
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


# auth 文件上应保留的 NSFW 字段（重 mint / 探针回写时不得抹掉）
NSFW_AUTH_KEYS = (
    "nsfw_enabled",
    "nsfw_attempted",
    "nsfw_at",
    "nsfw_error",
    "nsfw_steps",
)


def preserve_nsfw_fields(
    new_doc: dict[str, Any],
    old_doc: dict[str, Any] | None,
) -> dict[str, Any]:
    """把旧 auth JSON 的 nsfw_* 合并进新文档（仅当新文档尚未标记 attempted）。"""
    if not isinstance(new_doc, dict):
        return new_doc
    if new_doc.get("nsfw_attempted") is True:
        return new_doc
    if not isinstance(old_doc, dict):
        return new_doc
    if old_doc.get("nsfw_attempted") is not True:
        return new_doc
    for k in NSFW_AUTH_KEYS:
        if k in old_doc:
            new_doc[k] = old_doc[k]
    return new_doc


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


def set_zdr_tag(
    *,
    closed: bool,
    email: str = "",
    sso: str = "",
    error: str = "",
    steps: Any = None,
) -> dict[str, Any]:
    """写入 ZDR 关闭结果：closed=True → 关；False → 开。"""
    tag = {
        "zdr_closed": bool(closed),
        "zdr_attempted": True,
        "zdr_at": _now_iso(),
        "zdr_error": (error or "")[:300] if not closed else "",
    }
    if steps is not None:
        try:
            tag["zdr_steps"] = steps
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


def patch_auth_file_zdr(path: str | Path, *, closed: bool, error: str = "") -> bool:
    """把 zdr 字段写回 CPA auth JSON（不挡主流程）。"""
    p = Path(path)
    if not p.is_file():
        return False
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(doc, dict):
            return False
        doc["zdr_closed"] = bool(closed)
        doc["zdr_attempted"] = True
        doc["zdr_at"] = _now_iso()
        if not closed and error:
            doc["zdr_error"] = str(error)[:300]
        elif closed:
            doc.pop("zdr_error", None)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(p)
        return True
    except Exception:
        return False
