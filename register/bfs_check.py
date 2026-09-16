# -*- coding: utf-8 -*-
"""BFS claim 检测：xAI access_token JWT payload 里的 `bfs` 字段。

**实测结论：`bfs` 不是风险信号，命中不代表号有问题。**
全量样本按 JWT iat 分天统计显示：该 claim 只在一段短窗口内出现，窗口内近乎
全量覆盖且取值恒定，窗口前后均为 0 —— 属上游一次性开关，而非按号评估的风控
标记。命中组的测活存活率不低于未命中组（403 更少，disabled 两组均为 0）。
因此 flagged 仅作溯源标记，**禁止据此丢号或降级**。
（完整数据与复现脚本见本机 docs/bfs-signal-findings.md，未入库。）

判定语义（与 botFlagSource / policy=deny 不是同一信号）：
- payload 里**只要存在 bfs key** 即 flagged，哪怕值是 0 / null / ""。
- JWT 无法解码 → `unknown`，**绝不伪造为 clean**。
- 只读解码，不验签；服务端已签发的 claim 无法改写。

状态取值：
    "flagged"  payload 含 bfs key（实测=注册于该上游窗口，非风险）
    "clean"    payload 解码成功且无 bfs key（当前上游默认状态）
    "unknown"  没有 token / 不是 JWT / payload 解不出来
"""

from __future__ import annotations

import base64
import json
from typing import Any

__all__ = [
    "BFS_CLAIM_KEYS",
    "BFS_FLAGGED",
    "BFS_CLEAN",
    "BFS_UNKNOWN",
    "decode_jwt_payload_safe",
    "read_bfs_from_token",
    "extract_bfs",
    "bfs_sidecar_fields",
    "read_bfs_from_auth_record",
]

# xAI 目前只用 `bfs`；保留驼峰/下划线变体以防上游改名
BFS_CLAIM_KEYS: tuple[str, ...] = ("bfs", "BFS", "bot_flag_score", "botFlagScore")

BFS_FLAGGED = "flagged"
BFS_CLEAN = "clean"
BFS_UNKNOWN = "unknown"


def _b64url_json(seg: str) -> dict[str, Any] | None:
    try:
        pad = "=" * (-len(seg) % 4)
        raw = base64.urlsafe_b64decode(seg + pad)
        obj = json.loads(raw.decode("utf-8", errors="replace"))
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


def _normalize_token(token: Any) -> str:
    t = str(token or "").strip()
    if t.lower().startswith("sso="):
        t = t[4:].strip()
    return t


def decode_jwt_payload_safe(token: Any) -> dict[str, Any] | None:
    """只读解码 JWT payload；失败返回 None（区别于空 dict）。"""
    t = _normalize_token(token)
    parts = t.split(".")
    if len(parts) < 2 or not parts[1]:
        return None
    return _b64url_json(parts[1])


def read_bfs_from_token(token: Any) -> dict[str, Any]:
    """单个 token 的 BFS 判定。

    返回 {"bfs_status", "bfs_present", "bfs_value"}。
    bfs_value 保留 claim 原值（可能是 None / 0 / 2 / 字符串）。
    """
    t = _normalize_token(token)
    if not t:
        return {"bfs_status": BFS_UNKNOWN, "bfs_present": False, "bfs_value": None}
    pl = decode_jwt_payload_safe(t)
    if pl is None:
        return {"bfs_status": BFS_UNKNOWN, "bfs_present": False, "bfs_value": None}
    for k in BFS_CLAIM_KEYS:
        if k in pl:
            # key 存在即标记，值本身不参与判定
            return {
                "bfs_status": BFS_FLAGGED,
                "bfs_present": True,
                "bfs_value": pl.get(k),
            }
    return {"bfs_status": BFS_CLEAN, "bfs_present": False, "bfs_value": None}


def extract_bfs(
    access: Any = "",
    id_token: Any = "",
    sso: Any = "",
) -> dict[str, Any]:
    """按 access → id_token → sso 顺序判定。

    任一 token 命中 bfs 即 flagged。
    全部解不开（或都没给）→ unknown。
    至少一个解码成功且都无 bfs → clean。
    `bfs_source` 记录判定依据来自哪个 token。
    """
    saw_decodable = False
    for name, tok in (("access_token", access), ("id_token", id_token), ("sso", sso)):
        t = _normalize_token(tok)
        if not t:
            continue
        r = read_bfs_from_token(t)
        if r["bfs_status"] == BFS_FLAGGED:
            return {**r, "bfs_source": name}
        if r["bfs_status"] == BFS_CLEAN:
            saw_decodable = True
    if saw_decodable:
        return {
            "bfs_status": BFS_CLEAN,
            "bfs_present": False,
            "bfs_value": None,
            "bfs_source": "",
        }
    return {
        "bfs_status": BFS_UNKNOWN,
        "bfs_present": False,
        "bfs_value": None,
        "bfs_source": "",
    }


def bfs_sidecar_fields(
    access: Any = "",
    id_token: Any = "",
    sso: Any = "",
) -> dict[str, Any]:
    """给 CPA auth JSON 用的侧车字段。

    `bfs` 为布尔标记位（与 lij768423 面板导出对齐），`bfs_value` 为 claim 原值。
    """
    r = extract_bfs(access, id_token, sso)
    out: dict[str, Any] = {
        "bfs": bool(r["bfs_present"]),
        "bfs_status": r["bfs_status"],
    }
    if r["bfs_present"]:
        out["bfs_value"] = r["bfs_value"]
    if r.get("bfs_source"):
        out["bfs_source"] = r["bfs_source"]
    return out


def read_bfs_from_auth_record(data: dict[str, Any]) -> dict[str, Any]:
    """从已落盘的 CPA auth JSON 读 BFS：侧车字段优先，其次重新解码 token。"""
    if not isinstance(data, dict):
        return {"bfs_status": BFS_UNKNOWN, "bfs_present": False, "bfs_value": None}
    if "bfs_status" in data:
        st = str(data.get("bfs_status") or "").strip().lower()
        if st in (BFS_FLAGGED, BFS_CLEAN, BFS_UNKNOWN):
            return {
                "bfs_status": st,
                "bfs_present": st == BFS_FLAGGED,
                "bfs_value": data.get("bfs_value"),
            }
    if "bfs" in data:
        raw = data.get("bfs")
        # 兼容旧写法：bfs 可能是布尔标记位，也可能直接存 claim 值
        if isinstance(raw, bool):
            present = raw
        elif raw is None:
            present = False
        elif isinstance(raw, str):
            present = raw.strip().lower() not in ("", "0", "false", "no", "clean")
        else:
            present = True
        return {
            "bfs_status": BFS_FLAGGED if present else BFS_CLEAN,
            "bfs_present": bool(present),
            "bfs_value": data.get("bfs_value", raw if present else None),
        }
    sso = str(data.get("sso") or "").strip()
    if not sso:
        extra = data.get("extra")
        if isinstance(extra, dict):
            sso = str(extra.get("sso") or "").strip()
    return extract_bfs(
        data.get("access_token") or data.get("key") or "",
        data.get("id_token") or "",
        sso,
    )
