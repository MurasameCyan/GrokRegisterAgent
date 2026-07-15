# -*- coding: utf-8 -*-
"""
Plan-C hybrid 注册挂点（可选）。

config.register_mode == "hybrid" 时，主循环优先走本模块；
完整协议栈（regkit protocol + BrowserTokenSession）未随仓库打包时，
本适配层会返回 unavailable，由调用方回退 browser Plan A。

勿整库硬拷 grok-regkit；需要时再逐步迁入 protocol/ 与 browser/。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, Optional

LogFn = Callable[[str], None]

_CONFIG = Path(__file__).resolve().parent / "config.json"


def _noop(_: str) -> None:
    return None


def load_register_mode() -> str:
    """browser | hybrid；默认 browser。"""
    try:
        if _CONFIG.is_file():
            conf = json.loads(_CONFIG.read_text(encoding="utf-8"))
            m = str(conf.get("register_mode") or conf.get("registerMode") or "").strip().lower()
            if m == "hybrid":
                return "hybrid"
    except Exception:
        pass
    return "browser"


def hybrid_stack_available() -> bool:
    """检测 regkit 风格协议栈是否可 import（本仓库默认可选）。"""
    try:
        # 可选：将 regkit 的 protocol/browser 放到 register 旁或 PYTHONPATH
        import importlib.util

        for name in ("protocol.grpc_client", "protocol.session", "browser.token_harvester"):
            if importlib.util.find_spec(name) is None:
                return False
        return True
    except Exception:
        return False


def run_hybrid_registration(
    output_path: str,
    *,
    log: Optional[LogFn] = None,
    extract_numbers: bool = False,
) -> Optional[dict[str, Any]]:
    """
    尝试 hybrid 注册一轮。

    成功：返回与 run_single_registration 类似的 dict（至少含 sso / email）。
    不可用或失败：返回 None（调用方应回退 browser）。
    """
    lg = log or (lambda m: print(m, flush=True))
    _ = extract_numbers  # 兼容签名

    if not hybrid_stack_available():
        lg(
            "[hybrid] 协议栈未安装（需要 protocol.* + browser.token_harvester）。"
            " 回退 browser 主路径。可将 regkit 的 protocol/ browser/ 放入 PYTHONPATH 后重试。"
        )
        return None

    try:
        # 延迟 import：避免未安装时污染默认 browser 路径
        from hybrid_register_regkit import register_one_hybrid  # type: ignore

        accounts = Path(output_path)
        ok = register_one_hybrid(
            log=lg,
            proxy="",
            accounts_file=accounts,
            post_success=True,
        )
        if not ok:
            lg("[hybrid] register_one_hybrid 返回 False")
            return None
        # regkit 成功时通常已写 accounts；尽量读末行 sso（弱约定）
        return {"sso": "", "email": "", "plan": "hybrid", "ok": True}
    except ImportError as e:
        lg(f"[hybrid] regkit 适配入口不可用: {e} → 回退 browser")
        return None
    except Exception as e:
        lg(f"[hybrid] 异常: {e} → 回退 browser")
        return None
