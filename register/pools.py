"""邮箱域名池 / 代理池轮换。

配置来自 config.json：
  mail_domains: ["a.com", "b.com"]  或  mail.domains
  proxy_pool:   ["http://1:1", "http://2:2"]  或 proxies
  proxy_mode:   "round_robin" | "random"（默认 round_robin）
  email_domain_mode: 同上
"""
from __future__ import annotations

import itertools
import json
import os
import random
import threading
from pathlib import Path
from typing import List, Optional

_lock = threading.Lock()
_proxy_cycle = None
_domain_cycle = None
_proxy_list: List[str] = []
_domain_list: List[str] = []
_proxy_mode = "round_robin"
_domain_mode = "round_robin"
_loaded = False


def _config_path() -> Path:
    return Path(__file__).resolve().parent / "config.json"


def _parse_lines(raw) -> List[str]:
    """支持 list / 多行字符串 / 逗号分隔。"""
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
    global _proxy_cycle, _domain_cycle, _proxy_list, _domain_list
    global _proxy_mode, _domain_mode, _loaded
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
        single = str(conf.get("mail_domain") or "").strip()
        if single:
            domains = [single]

    proxies = _parse_lines(conf.get("proxy_pool") or conf.get("proxies"))
    if not proxies:
        # 单代理仍作为池的唯一项（可选）
        single_p = str(conf.get("browser_proxy") or conf.get("proxy") or "").strip()
        if single_p:
            proxies = [single_p]

    _domain_list = domains
    _proxy_list = proxies
    _domain_mode = str(conf.get("email_domain_mode") or conf.get("mail_domain_mode") or "round_robin").lower()
    _proxy_mode = str(conf.get("proxy_mode") or "round_robin").lower()
    _domain_cycle = itertools.cycle(_domain_list) if _domain_list else None
    _proxy_cycle = itertools.cycle(_proxy_list) if _proxy_list else None
    _loaded = True


def list_domains() -> List[str]:
    reload_pools()
    return list(_domain_list)


def list_proxies() -> List[str]:
    reload_pools()
    return list(_proxy_list)


def next_mail_domain(fallback: str = "") -> str:
    """轮换/随机取一个邮箱域名。"""
    reload_pools()
    with _lock:
        if not _domain_list:
            return (fallback or "").strip()
        if _domain_mode == "random":
            return random.choice(_domain_list)
        assert _domain_cycle is not None
        return next(_domain_cycle)


def next_proxy(fallback: str = "") -> str:
    """轮换/随机取一个代理 URL；池空时返回 fallback。"""
    reload_pools()
    with _lock:
        if not _proxy_list:
            return (fallback or "").strip()
        if _proxy_mode == "random":
            return random.choice(_proxy_list)
        assert _proxy_cycle is not None
        return next(_proxy_cycle)


def peek_status() -> dict:
    reload_pools()
    return {
        "domains": list(_domain_list),
        "proxies": list(_proxy_list),
        "domain_mode": _domain_mode,
        "proxy_mode": _proxy_mode,
        "config": str(_config_path()),
    }
