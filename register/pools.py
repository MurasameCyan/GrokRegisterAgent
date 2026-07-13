"""邮箱域名池 / 代理池轮换。

配置来自 config.json：
  mail_domains: ["a.com", "b.com"]  或  mail.domains
  proxy_pool:   ["http://1:1", "http://2:2"]  或 proxies
  proxy_mode:   "round_robin" | "random"（默认 round_robin）
  email_domain_mode: 同上

重要：每轮 start_browser / create_temp_email 会 reload_pools(force=True)。
若用 itertools.cycle 在 force 时重建，轮换指针永远回到第 0 项。
因此使用持久化下标 _domain_idx / _proxy_idx，列表内容未变时保留进度。
"""
from __future__ import annotations

import json
import os
import random
import threading
from pathlib import Path
from typing import List

_lock = threading.Lock()
_proxy_list: List[str] = []
_domain_list: List[str] = []
_proxy_mode = "round_robin"
_domain_mode = "round_robin"
_domain_idx = 0
_proxy_idx = 0
_loaded = False


def _config_path() -> Path:
    return Path(__file__).resolve().parent / "config.json"


def _strip_proxy_comment(line: str) -> str:
    """去掉代理行尾 #备注（如 http://u:p@ip:port#香港-01 或 #%E9%A6%99%E6%B8%AF-02）。"""
    s = (line or "").strip()
    if not s or s.startswith("#"):
        return ""
    scheme_idx = s.find("://")
    search_from = scheme_idx + 3 if scheme_idx >= 0 else 0
    hash_idx = s.find("#", search_from)
    if hash_idx >= 0:
        return s[:hash_idx].strip()
    return s


def _parse_lines(raw, *, strip_proxy_hash: bool = False) -> List[str]:
    """支持 list / 多行字符串 / 逗号分隔。

    strip_proxy_hash=True 时剥离行尾 #备注（代理池专用）。
    """
    if raw is None:
        return []
    if isinstance(raw, list):
        items = [str(x).strip() for x in raw]
    else:
        text = str(raw).replace("\r\n", "\n").replace(",", "\n")
        items = [ln.strip() for ln in text.split("\n")]
    out: List[str] = []
    for it in items:
        if not it or it.startswith("#"):
            continue
        if strip_proxy_hash:
            it = _strip_proxy_comment(it)
            if not it:
                continue
        out.append(it)
    # 去重保序
    seen = set()
    uniq: List[str] = []
    for it in out:
        if it in seen:
            continue
        seen.add(it)
        uniq.append(it)
    return uniq


def reload_pools(force: bool = False) -> None:
    """重读 config。force=True 时也保留轮换下标（列表未变时）。"""
    global _proxy_list, _domain_list
    global _proxy_mode, _domain_mode, _loaded
    global _domain_idx, _proxy_idx
    if _loaded and not force:
        return
    conf: dict = {}
    path = _config_path()
    try:
        if path.is_file():
            conf = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        conf = {}

    # 域名：优先池；否则单 domain
    domains = _parse_lines(conf.get("mail_domains") or conf.get("mail_domain_pool"))
    if not domains and isinstance(conf.get("mail"), dict):
        domains = _parse_lines(conf["mail"].get("domains"))
    if not domains:
        single = str(conf.get("mail_domain") or "").strip().lstrip("@")
        if single:
            domains = [single]
    # 规范化域名：去掉 @ 前缀
    domains = [d.lstrip("@") for d in domains if d]

    proxies = _parse_lines(conf.get("proxy_pool") or conf.get("proxies"), strip_proxy_hash=True)
    if not proxies:
        # 单代理仍作为池的唯一项（可选）
        single_p = _strip_proxy_comment(
            str(conf.get("browser_proxy") or conf.get("proxy") or "")
        )
        if single_p:
            proxies = [single_p]

    domain_mode = str(
        conf.get("email_domain_mode") or conf.get("mail_domain_mode") or "round_robin"
    ).lower()
    proxy_mode = str(conf.get("proxy_mode") or "round_robin").lower()

    with _lock:
        # 列表内容未变：保留下标；变了：重置为 0（或对旧下标取模，尽量不跳）
        if domains != _domain_list:
            if _domain_list and domains:
                # 尽量按「下一跳」对齐：若旧当前项仍在新列表，则从其后一项开始
                try:
                    old_cur = _domain_list[_domain_idx % len(_domain_list)]
                    if old_cur in domains:
                        _domain_idx = (domains.index(old_cur) + 1) % len(domains)
                    else:
                        _domain_idx = 0
                except Exception:
                    _domain_idx = 0
            else:
                _domain_idx = 0
        if proxies != _proxy_list:
            if _proxy_list and proxies:
                try:
                    old_cur = _proxy_list[_proxy_idx % len(_proxy_list)]
                    if old_cur in proxies:
                        _proxy_idx = (proxies.index(old_cur) + 1) % len(proxies)
                    else:
                        _proxy_idx = 0
                except Exception:
                    _proxy_idx = 0
            else:
                _proxy_idx = 0

        _domain_list = domains
        _proxy_list = proxies
        _domain_mode = domain_mode
        _proxy_mode = proxy_mode
        _loaded = True


def list_domains() -> List[str]:
    reload_pools()
    with _lock:
        return list(_domain_list)


def list_proxies() -> List[str]:
    reload_pools()
    with _lock:
        return list(_proxy_list)


def next_mail_domain(fallback: str = "") -> str:
    """轮换/随机取一个邮箱域名。"""
    reload_pools()
    with _lock:
        if not _domain_list:
            return (fallback or "").strip().lstrip("@")
        if _domain_mode == "random":
            return random.choice(_domain_list)
        # round_robin：用持久下标，force reload 不会回到 0
        global _domain_idx
        i = _domain_idx % len(_domain_list)
        item = _domain_list[i]
        _domain_idx = (i + 1) % len(_domain_list)
        return item


def next_proxy(fallback: str = "") -> str:
    """轮换/随机取一个代理 URL；池空时返回 fallback。"""
    reload_pools()
    with _lock:
        if not _proxy_list:
            return (fallback or "").strip()
        if _proxy_mode == "random":
            return random.choice(_proxy_list)
        global _proxy_idx
        i = _proxy_idx % len(_proxy_list)
        item = _proxy_list[i]
        _proxy_idx = (i + 1) % len(_proxy_list)
        return item


def peek_status() -> dict:
    reload_pools()
    with _lock:
        return {
            "domains": list(_domain_list),
            "proxies": list(_proxy_list),
            "domain_mode": _domain_mode,
            "proxy_mode": _proxy_mode,
            "domain_idx": _domain_idx,
            "proxy_idx": _proxy_idx,
            "config": str(_config_path()),
        }
