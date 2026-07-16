"""邮箱域名池 / 代理池轮换。

配置来自 config.json：
  mail_domains: ["a.com", "b.com"]  或  mail.domains
  proxy_pool:   ["http://1:1", "http://2:2"]  或 proxies
  proxy_mode:   "round_robin" | "random"（默认 round_robin）
  email_domain_mode: 同上
  proxy_ip_interval_sec: 同一 IP/代理两次用于注册的最小间隔秒数（0=不限制）

重要：每轮 start_browser / create_temp_email 会 reload_pools(force=True)。
若用 itertools.cycle 在 force 时重建，轮换指针永远回到第 0 项。
因此使用持久化下标 _domain_idx / _proxy_idx，列表内容未变时保留进度。

IP 间隔：acquire_proxy_for_register 在间隔未到时 sleep 等待（队列暂停），
而非跳过代理。
"""
from __future__ import annotations

import json
import os
import random
import re
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlparse

_lock = threading.Lock()
_proxy_list: List[str] = []
_domain_list: List[str] = []
_proxy_mode = "round_robin"
_domain_mode = "round_robin"
_domain_idx = 0
_proxy_idx = 0
_loaded = False
# 同一 IP 最小使用间隔（秒）；0 关闭
_proxy_ip_interval_sec = 0.0
# proxy_key -> 上次成功占用时间戳
_proxy_last_used: Dict[str, float] = {}


def _config_path() -> Path:
    return Path(__file__).resolve().parent / "config.json"


_HOST_PORT_RE = re.compile(
    r"^(?:([^@\s/]+)@)?((?:\d{1,3}(?:\.\d{1,3}){3}|\[?[0-9a-fA-F:]+\]?|[\w.-]+):(\d{1,5}))$",
    re.I,
)


def _gra_api_base() -> str:
    return (
        os.environ.get("GRA_API_BASE")
        or os.environ.get("GRA_SERVER_URL")
        or "http://127.0.0.1:6657"
    ).rstrip("/")


def _gra_internal_headers() -> dict:
    """Node requireApiAuth 接受的内部密钥头（注册子进程由 Node 注入 GRA_INTERNAL_KEY）。"""
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    key = (
        os.environ.get("GRA_INTERNAL_KEY")
        or os.environ.get("GRA_INTERNAL_TOKEN")
        or ""
    ).strip()
    if key:
        headers["X-GRA-Internal"] = key
    return headers


def _read_config_dict() -> dict:
    try:
        path = _config_path()
        if path.is_file():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def is_cf_proxy_mode() -> bool:
    """config.cf_proxy_enabled：CF 独立代理（本地 127.0.0.1:port），非代理池。"""
    conf = _read_config_dict()
    raw = conf.get("cf_proxy_enabled")
    if isinstance(raw, bool):
        return raw
    s = str(raw or "").strip().lower()
    return s in ("1", "true", "yes", "on", "enabled")



def is_singbox_proxy_mode() -> bool:
    """config.singbox_enabled：sing-box 本地 mixed（127.0.0.1:2080），节点由 Node 管理。"""
    conf = _read_config_dict()
    raw = conf.get("singbox_enabled")
    if isinstance(raw, bool):
        return raw
    s = str(raw or "").strip().lower()
    return s in ("1", "true", "yes", "on", "enabled")


def rotate_singbox_node(reason: str = "注册失败") -> bool:
    """通知 Node 切换 sing-box 出站节点（端口不变，浏览器需 restart 才能用新链路）。"""
    url = f"{_gra_api_base()}/api/singbox/rotate"
    body = json.dumps(
        {"reason": str(reason or "注册失败")[:160]},
        ensure_ascii=False,
    )
    try:
        import urllib.request

        req = urllib.request.Request(
            url,
            data=body.encode("utf-8"),
            headers=_gra_internal_headers(),
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=12) as resp:
            raw = resp.read().decode("utf-8", "replace")
        try:
            data = json.loads(raw) if raw else {}
        except Exception:
            data = {}
        rotated = bool(data.get("rotated"))
        msg = data.get("message") or raw[:120]
        to_name = data.get("to") or data.get("selectedName") or ""
        if rotated or data.get("running"):
            print(
                f"[*] sing-box 节点已切换: {msg}"
                + (f" · {to_name}" if to_name else ""),
                flush=True,
            )
            return True
        print(f"[Warn] sing-box 节点切换未生效: {msg}", flush=True)
        return False
    except Exception as e:
        print(f"[Warn] sing-box 节点切换回调失败（{url}）: {e}", flush=True)
        return False

def is_local_loopback_proxy(proxy: str) -> bool:
    """是否本机环回代理（CF cfwp / 本地转发）。不可当池节点剔除。"""
    p = str(proxy or "").strip()
    if not p:
        return False
    try:
        raw = p
        if "://" not in raw:
            raw = "http://" + raw
        u = urlparse(raw.split("#", 1)[0])
        host = (u.hostname or "").lower()
        return host in ("127.0.0.1", "localhost", "::1")
    except Exception:
        pl = p.lower()
        return "127.0.0.1" in pl or "localhost" in pl


def should_skip_proxy_demote(proxy: str) -> bool:
    """CF 独立代理 / 本机环回：禁止 demote 与本轮池剔除。

    sing-box 模式：不在此跳过——应走 rotate_singbox_node（见 demote_proxy_to_pending）。
    """
    if is_singbox_proxy_mode():
        return False
    if is_cf_proxy_mode():
        return True
    return is_local_loopback_proxy(proxy)


def remove_proxy_from_local_pool(proxy: str) -> int:
    """从本进程内存代理池立即剔除（按 host:port 身份键）。

    Node 降级只改 settings，本进程 config.json 与 _proxy_list 不会自动同步；
    若不本地剔除，后续 acquire 仍会抽到已死代理。

    CF 独立代理 / 127.0.0.1 环回：不剔除（单节点，剔除后只剩「无可用节点」假失败）。
    """
    p = str(proxy or "").strip()
    if not p:
        return 0
    if should_skip_proxy_demote(p):
        return 0
    key = proxy_identity_key(p)
    if not key:
        return 0
    removed = 0
    with _lock:
        global _proxy_list, _proxy_idx
        before = list(_proxy_list)
        nxt: List[str] = []
        for u in before:
            if proxy_identity_key(u) == key:
                removed += 1
                continue
            nxt.append(u)
        if removed:
            _proxy_list = nxt
            if _proxy_list:
                _proxy_idx = _proxy_idx % len(_proxy_list)
            else:
                _proxy_idx = 0
            try:
                _proxy_last_used.pop(key, None)
            except Exception:
                pass
    if removed:
        # 同步改写 register/config.json 的 proxy_pool，避免 force reload 又读回死代理
        try:
            path = _config_path()
            if path.is_file():
                conf = json.loads(path.read_text(encoding="utf-8"))
                pool = conf.get("proxy_pool") or conf.get("proxies")
                if isinstance(pool, list):
                    conf["proxy_pool"] = [
                        x
                        for x in pool
                        if proxy_identity_key(str(x or "")) != key
                    ]
                    path.write_text(
                        json.dumps(conf, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )
                elif isinstance(pool, str) and pool.strip():
                    lines = []
                    for ln in pool.replace("\r\n", "\n").split("\n"):
                        raw = ln.strip()
                        if not raw or raw.startswith("#"):
                            lines.append(ln)
                            continue
                        if proxy_identity_key(raw) == key:
                            continue
                        lines.append(ln)
                    conf["proxy_pool"] = "\n".join(lines)
                    path.write_text(
                        json.dumps(conf, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )
        except Exception:
            pass
    return removed


def demote_proxy_to_pending(proxy: str, reason: str = "注册失败") -> bool:
    """注册使用失败：本地立即剔除 + 通知 Node 把该代理从可用池降到待定池。

    端点：POST {GRA_API_BASE}/api/proxy/demote
    已降级过（Node moved=0）仍视为成功：本进程本地已剔除即可换代理。
    失败仅打日志，不抛异常。

    CF 独立代理（cfwp 本地端口）不 demote：无「池」可降，剔除只会误报无节点。
    """
    p = str(proxy or "").strip()
    if not p:
        return False
    if is_singbox_proxy_mode():
        return rotate_singbox_node(str(reason or "注册失败"))
    if should_skip_proxy_demote(p):
        print(
            f"[*] CF/本机代理不降级、不剔除: {p[:72]}… · {str(reason or '')[:100]}",
            flush=True,
        )
        return False
    # 先本地剔除：保证同轮/同进程立刻不会再抽到
    local_n = remove_proxy_from_local_pool(p)
    url = f"{_gra_api_base()}/api/proxy/demote"
    body = json.dumps({"proxies": [p], "reason": str(reason or "注册失败")[:80]}, ensure_ascii=False)
    try:
        import urllib.request

        req = urllib.request.Request(
            url,
            data=body.encode("utf-8"),
            headers=_gra_internal_headers(),
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            raw = resp.read().decode("utf-8", "replace")
        try:
            data = json.loads(raw) if raw else {}
        except Exception:
            data = {}
        moved = int(data.get("moved") or 0)
        msg = data.get("message") or raw[:120]
        if moved > 0:
            print(f"[*] 代理已降级→待定池: {p[:64]}… · {msg}")
            return True
        # Node 侧可能已降过：本地已剔除则算成功，避免刷「未生效」+ 继续用死代理
        if local_n > 0:
            print(f"[*] 代理已从本轮池剔除: {p[:64]}… · Node: {msg}")
            return True
        print(f"[Warn] 代理降级未生效: {msg}")
        return False
    except Exception as e:
        if local_n > 0:
            print(
                f"[*] 代理已从本轮池剔除（Node 回调失败仍可换代理）: {p[:64]}… · {e}"
            )
            return True
        print(f"[Warn] 代理降级回调失败（{url}）: {e}")
        return False


def bump_proxy_register_success(proxy: str, delta: int = 1) -> bool:
    """已废弃：无代理池后不再写成功计数。保留空实现避免旧调用崩溃。"""
    _ = (proxy, delta)
    return False


def _infer_proxy_scheme_from_hint(hint: str) -> str:
    """从备注/CSV 协议列推断 scheme（与 Node shared/settings 对齐）。

    - socks5 → socks5；socks4a → socks4a；socks4 → socks4
    - 笼统 socks → socks5
    - http / **https（列表）/ 空 → http**
      HTTPS 表示支持 HTTPS 隧道，不是 https:// 代理协议
    """
    t = str(hint or "")
    if not t.strip():
        return "http"
    low = t.lower()
    if re.search(r"\bsocks\s*5h?\b", low) or re.search(r"\bsocks5h?\b", low):
        return "socks5"
    if re.search(r"\bsocks\s*4a\b", low) or "socks4a" in low:
        return "socks4a"
    if re.search(r"\bsocks\s*4\b", low) or re.search(r"\bsocks4\b", low):
        return "socks4"
    if re.search(r"\bsocks\b", low):
        return "socks5"
    return "http"


def _ensure_proxy_scheme(address: str, hint: str = "") -> str:
    """无 scheme 时按 hint 补协议头；已有 scheme 规范化 socks 别名。"""
    s = (address or "").strip()
    if not s:
        return ""
    s = re.sub(r"^[`'\"<\s]+", "", s)
    s = re.sub(r"[`'\">\s]+$", "", s).strip()
    if not s:
        return ""
    if re.match(r"^[a-z][a-z0-9+.-]*://", s, re.I):
        s = re.sub(r"^socks5h://", "socks5://", s, flags=re.I)
        s = re.sub(r"^socks://", "socks5://", s, flags=re.I)
        return s
    return f"{_infer_proxy_scheme_from_hint(hint)}://{s}"


def _extract_csv_proxy_addr(line: str) -> str:
    """从 CSV 取出 host:port（无 scheme），否则空串。"""
    s = (line or "").strip()
    if not s or "://" in s or "," not in s:
        return ""
    parts = [p.strip() for p in s.split(",") if p.strip()]
    if len(parts) < 2:
        return ""
    if parts[0].isdigit() and _HOST_PORT_RE.match(parts[1]):
        return parts[1]
    if _HOST_PORT_RE.match(parts[0]):
        return parts[0]
    for p in parts:
        if _HOST_PORT_RE.match(p):
            return p
    return ""


def _extract_csv_proxy_with_scheme(line: str) -> str:
    """CSV 行 → 带 scheme 的地址。`…,SOCKS5,…` → socks5://；`…,HTTPS,…` → http://"""
    s = (line or "").strip()
    addr = _extract_csv_proxy_addr(s)
    if not addr:
        return ""
    parts = [p.strip() for p in s.split(",") if p.strip()]
    meta = [p for p in parts if p != addr and not p.isdigit()]
    return _ensure_proxy_scheme(addr, " · ".join(meta))


def _is_csv_proxy_line(line: str) -> bool:
    return bool(_extract_csv_proxy_addr(line))


def _strip_proxy_comment(line: str) -> str:
    """去掉代理行尾备注并规范化 scheme（与 Node shared/proxyApi 对齐）。

    支持：
    - `http://u:p@ip:port#香港-01` / `#%E9%A6%99%E6%B8%AF-02`
    - `8.216.35.12:8888（日本，elite，SOCKS5）` → socks5://…
    - `ip:port(Japan, elite, HTTPS)` → http://…（HTTPS≠https 代理）
    - `18,172.64.149.71:80,美国,HTTP,平均` → http://…
    """
    s = (line or "").strip()
    if not s or s.startswith("#"):
        return ""
    csv_url = _extract_csv_proxy_with_scheme(s)
    if csv_url:
        return csv_url

    label_parts: list[str] = []
    # 尾部全角/半角括号备注（保留文本作 scheme hint）
    for _ in range(3):
        m = re.search(r"[（(]([^）)]*)[）)]\s*$", s)
        if not m:
            break
        label_parts.append(m.group(1).strip())
        s = s[: m.start()].strip()

    scheme_idx = s.find("://")
    search_from = scheme_idx + 3 if scheme_idx >= 0 else 0
    hash_idx = s.find("#", search_from)
    if hash_idx >= 0:
        label_parts.append(s[hash_idx + 1 :].strip())
        s = s[:hash_idx].strip()

    hint = " · ".join(x for x in label_parts if x) or s
    return _ensure_proxy_scheme(s, hint)


def _split_proxy_pool_text(text: str) -> List[str]:
    """按换行/半角逗号拆分；括号内逗号不拆；CSV 供应商行整行保留。"""
    text = (text or "").replace("\r\n", "\n")
    items: List[str] = []
    for line in text.split("\n"):
        trimmed = line.strip()
        if not trimmed:
            continue
        if _is_csv_proxy_line(trimmed):
            items.append(trimmed)
            continue

        # 保护括号内半角逗号
        def _protect(m: re.Match) -> str:
            return m.group(0).replace(",", "\0")

        protected = re.sub(r"[（(][^）)]*[）)]", _protect, line)
        for part in protected.split(","):
            one = part.replace("\0", ",").strip()
            if one:
                items.append(one)
    return items


def _parse_lines(raw, *, strip_proxy_hash: bool = False) -> List[str]:
    """支持 list / 多行字符串 / 逗号分隔。

    strip_proxy_hash=True 时剥离行尾 # / （…） 备注（代理池专用）。
    """
    if raw is None:
        return []
    if isinstance(raw, list):
        items = [str(x).strip() for x in raw]
    else:
        items = _split_proxy_pool_text(str(raw)) if strip_proxy_hash else [
            ln.strip()
            for ln in str(raw).replace("\r\n", "\n").replace(",", "\n").split("\n")
        ]
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


def proxy_identity_key(proxy_url: str) -> str:
    """同一出口身份的稳定键：优先 host:port，解析失败则用完整 URL。"""
    s = _strip_proxy_comment(proxy_url or "")
    if not s:
        return ""
    try:
        u = urlparse(s if "://" in s else f"http://{s}")
        host = (u.hostname or "").strip().lower()
        port = u.port
        if host and port:
            return f"{host}:{port}"
        if host:
            return host
    except Exception:
        pass
    # 去掉凭证后的 host:port 粗解析
    m = re.search(r"@([^:/?#]+):(\d+)", s)
    if m:
        return f"{m.group(1).lower()}:{m.group(2)}"
    m2 = re.search(r"://([^:/?#]+):(\d+)", s)
    if m2:
        return f"{m2.group(1).lower()}:{m2.group(2)}"
    return s


def reload_pools(force: bool = False) -> None:
    """重读 config。force=True 时也保留轮换下标（列表未变时）。"""
    global _proxy_list, _domain_list
    global _proxy_mode, _domain_mode, _loaded
    global _domain_idx, _proxy_idx, _proxy_ip_interval_sec
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

    # 总开关：proxy_enabled=false 时强制空池（直连），忽略残留 proxy_pool 文本
    def _truthy_proxy_on(raw) -> bool:
        if raw is None:
            return True  # 旧配置无字段：沿用池内容
        if isinstance(raw, bool):
            return raw
        s = str(raw).strip().lower()
        if s in ("0", "false", "no", "off", "disabled"):
            return False
        if s in ("1", "true", "yes", "on", "enabled"):
            return True
        return True

    proxy_master_on = _truthy_proxy_on(conf.get("proxy_enabled"))
    proxies: List[str] = []
    if proxy_master_on:
        proxies = _parse_lines(
            conf.get("proxy_pool") or conf.get("proxies"), strip_proxy_hash=True
        )
        if not proxies:
            # 单代理仍作为池的唯一项（可选）
            single_p = _strip_proxy_comment(
                str(conf.get("browser_proxy") or conf.get("proxy") or "")
            )
            if single_p:
                proxies = [single_p]
    # else: 直连，proxies 保持 []

    domain_mode = str(
        conf.get("email_domain_mode") or conf.get("mail_domain_mode") or "round_robin"
    ).lower()
    proxy_mode = str(conf.get("proxy_mode") or "round_robin").lower()

    try:
        interval = float(
            conf.get("proxy_ip_interval_sec")
            if conf.get("proxy_ip_interval_sec") is not None
            else conf.get("ip_register_interval_sec")
            if conf.get("ip_register_interval_sec") is not None
            else 0
        )
    except Exception:
        interval = 0.0
    if interval < 0:
        interval = 0.0

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
        _proxy_ip_interval_sec = interval
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
    """轮换/随机取一个代理 URL；池空时返回 fallback。

    注意：此函数不记录使用时间、不强制 IP 间隔。
    注册开浏览器请用 acquire_proxy_for_register。
    """
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


def _pick_proxy_unlocked(fallback: str = "") -> str:
    """在已持锁前提下取代理（round_robin / random）。"""
    global _proxy_idx
    if not _proxy_list:
        return (fallback or "").strip()
    if _proxy_mode == "random":
        return random.choice(_proxy_list)
    i = _proxy_idx % len(_proxy_list)
    item = _proxy_list[i]
    _proxy_idx = (i + 1) % len(_proxy_list)
    return item


def acquire_proxy_for_register(
    fallback: str = "",
    *,
    log=print,
) -> Tuple[str, float]:
    """为一次注册占用代理，并强制同一 IP 的最小使用间隔。

    间隔未到时：优先换到其它已冷却的 IP；若池内全部未冷却则 sleep 等待最早可用的，
    即「时间没到自动暂停队列等待」。

    返回 (proxy_url, waited_seconds)。
    """
    reload_pools()
    waited = 0.0
    while True:
        with _lock:
            interval = float(_proxy_ip_interval_sec or 0)
            candidates: List[str] = list(_proxy_list) if _proxy_list else []
            if not candidates:
                fb = (fallback or "").strip()
                if not fb:
                    return "", waited
                candidates = [fb]
                pick_from_pool = False
            else:
                pick_from_pool = True

            now = time.time()
            # 先按模式挑一个「当前」项，再判断是否可用；不可用则扫全池找最早可就绪
            if pick_from_pool:
                preferred = _pick_proxy_unlocked(fallback)
            else:
                preferred = candidates[0]

            def remaining(url: str) -> float:
                if interval <= 0:
                    return 0.0
                key = proxy_identity_key(url)
                if not key:
                    return 0.0
                last = _proxy_last_used.get(key, 0.0)
                if last <= 0:
                    return 0.0
                return max(0.0, interval - (now - last))

            # 1) preferred 已冷却 → 直接用
            rem_pref = remaining(preferred)
            if rem_pref <= 0:
                key = proxy_identity_key(preferred)
                if key and interval > 0:
                    _proxy_last_used[key] = now
                return preferred, waited

            # 2) 找其它已冷却的 IP
            ready: List[str] = []
            soonest_wait = rem_pref
            soonest_url = preferred
            for url in candidates:
                r = remaining(url)
                if r <= 0:
                    ready.append(url)
                elif r < soonest_wait:
                    soonest_wait = r
                    soonest_url = url

            if ready:
                if _proxy_mode == "random":
                    chosen = random.choice(ready)
                else:
                    # 尽量贴近轮换顺序：ready 中按池顺序第一个
                    chosen = ready[0]
                    for url in candidates:
                        if url in ready:
                            chosen = url
                            break
                key = proxy_identity_key(chosen)
                if key and interval > 0:
                    _proxy_last_used[key] = now
                return chosen, waited

            # 3) 全部冷却中 → 暂停等待最早可用
            sleep_sec = min(max(soonest_wait, 0.05), 30.0)

        # 锁外 sleep，避免阻塞其它线程读配置
        try:
            log(
                f"[*] IP 使用间隔未到：等待 {sleep_sec:.1f}s "
                f"(间隔={interval:.0f}s, key={proxy_identity_key(soonest_url) or '-'})"
            )
        except Exception:
            pass
        time.sleep(sleep_sec)
        waited += sleep_sec
        # 循环再取，时间到后会命中 ready / preferred


def mark_proxy_used(proxy_url: str) -> None:
    """手动标记代理已用于注册（一般 acquire 内已标记）。"""
    key = proxy_identity_key(proxy_url)
    if not key:
        return
    with _lock:
        if _proxy_ip_interval_sec > 0:
            _proxy_last_used[key] = time.time()


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
            "proxy_ip_interval_sec": _proxy_ip_interval_sec,
            "proxy_last_used_n": len(_proxy_last_used),
            "config": str(_config_path()),
        }
