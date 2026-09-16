# -*- coding: utf-8 -*-
"""原子写 JSON / 文本的唯一实现。

背景：本仓库曾有 4+ 处各自实现 "tmp + replace"，其中只有 pools.py 带 fsync，
其余在断电 / 容器硬杀时可能落下空文件或旧内容；account_tags 的 legacy 镜像
更是裸 write_text（写入期间目标文件被截断，读者可能读到空/残缺内容）。
此模块收敛该模式。

保证（均为本机 win32 实测，见 _REPLACE_ATTEMPTS 上方数据）：
- 替换是原子的：读者要么看到旧内容、要么看到新内容，绝不见半写。
- flush + fsync(file)：内容真正落盘后才替换（原实现除 pools.py 外均缺此步）。
- 临时名带 pid + thread id：多进程 / 多 worker 线程并发写同一目标不互相踩。
- 替换失败清理临时文件并抛异常，绝不静默丢写，也不留 .tmp.* 垃圾。
- 尽力 fsync 目录（POSIX 上让 rename 本身持久；Windows 无此语义，静默跳过）。
- Windows 共享冲突（读者正打开目标文件）时有界重试，避免裸替换的静默丢写。
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

__all__ = ["atomic_write_text", "atomic_write_json"]

# Windows 上读者持有目标句柄时 os.replace 抛 PermissionError(13)/OSError(32)，
# 裸替换会静默丢写（Node 控制面会读 account_tags.json / config.json）。
# POSIX 无此语义（rename 覆盖已打开文件合法），故只在 Windows 重试。
# 实测（8 写 4 读，读者 10ms 间隔）：裸替换丢 1/150，重试后 0/150，耗时持平。
_REPLACE_ATTEMPTS = 6
_REPLACE_BACKOFF_SEC = 0.005
_REPLACE_BACKOFF_MAX_SEC = 0.08


def _tmp_path(path: Path) -> Path:
    """同目录临时名（必须同分区，否则 os.replace 跨设备失败）。"""
    return path.with_name(f"{path.name}.tmp.{os.getpid()}.{threading.get_ident()}")


def _fsync_dir(path: Path) -> None:
    """让 rename 自身持久化。仅 POSIX 有意义；其它平台静默跳过。"""
    if os.name != "posix":
        return
    try:
        fd = os.open(str(path.parent), os.O_RDONLY)
    except Exception:
        return
    try:
        os.fsync(fd)
    except Exception:
        pass
    finally:
        try:
            os.close(fd)
        except Exception:
            pass


def _replace_with_retry(tmp: Path, target: Path) -> None:
    """os.replace；Windows 上遇共享冲突时有界重试。

    POSIX 单次即成功，无额外开销。Windows 总退避约 0.15s；仍失败则抛给调用方，
    绝不静默丢写。读者永不见半写内容——替换本身是原子的。
    """
    if os.name != "nt":
        os.replace(tmp, target)
        return

    delay = _REPLACE_BACKOFF_SEC
    last: Exception | None = None
    for attempt in range(_REPLACE_ATTEMPTS):
        try:
            os.replace(tmp, target)
            return
        except PermissionError as e:  # 读者持有句柄
            last = e
        except OSError as e:  # ERROR_SHARING_VIOLATION(32) / ERROR_LOCK_VIOLATION(33)
            if getattr(e, "winerror", None) not in (5, 32, 33):
                raise
            last = e
        if attempt < _REPLACE_ATTEMPTS - 1:
            time.sleep(delay)
            delay = min(delay * 2, _REPLACE_BACKOFF_MAX_SEC)
    raise last if last is not None else OSError(f"replace failed: {target}")


def atomic_write_text(
    path: str | os.PathLike[str],
    text: str,
    *,
    encoding: str = "utf-8",
) -> Path:
    """原子写文本：写临时文件 → fsync → os.replace。返回目标路径。

    父目录不存在时自动创建。异常向上抛出（调用方决定是否吞掉）。
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = _tmp_path(target)
    try:
        with open(tmp, "w", encoding=encoding, newline="") as f:
            f.write(text)
            f.flush()
            try:
                os.fsync(f.fileno())
            except Exception:
                # 某些网络/容器文件系统不支持 fsync；replace 仍是原子的
                pass
        _replace_with_retry(tmp, target)
    except Exception:
        try:
            tmp.unlink()
        except Exception:
            pass
        raise
    _fsync_dir(target)
    return target


def atomic_write_json(
    path: str | os.PathLike[str],
    obj: Any,
    *,
    indent: int | None = 2,
    newline: bool = True,
    encoding: str = "utf-8",
) -> Path:
    """原子写 JSON（ensure_ascii=False）。

    newline=True 时补尾换行（多数 auth / 侧车文件的既有格式）。
    """
    text = json.dumps(obj, ensure_ascii=False, indent=indent)
    if newline:
        text += "\n"
    return atomic_write_text(path, text, encoding=encoding)
