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

import ipaddress
import json
import os
import random
import re
import threading
import time
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlparse

from atomic_json import atomic_write_json

_lock = threading.Lock()
# 跨进程写 config.json 的文件锁：Node（writeConfigForPython）与本进程
# （remove_proxy_from_local_pool）会并发写同一文件。共用 config.json.lock，
# 通过 O_CREAT|O_EXCL 自旋获取，避免半写文件与互相覆盖。
_config_lock = threading.Lock()
_proxy_list: List[str] = []
_domain_list: List[str] = []
_proxy_mode = "round_robin"
_domain_mode = "round_robin"
_domain_idx = 0
_proxy_idx = 0
_loaded = False
# 同一 IP 最小使用间隔（秒）；0 关闭
_proxy_ip_interval_sec = 0.0
# proxy_key -> 上次成功占用时间戳。
# 跨进程真相源是 _ip_state_path() 的 JSON：多个 runner 共用同一出口时，仅靠
# 进程内存会各自计时 → 同 IP 实际频率翻倍。
_proxy_last_used: Dict[str, float] = {}

# Sing-Box 的 Python 入口恒为 127.0.0.1:2080，不能把这个本地地址当作公网 IP。
# route.final 节点 tag 是稳定身份；节点上游的公网 IP 可能动态轮换，只作无 tag 时的 fallback。
_SINGBOX_IDENTITY_TTL_SEC = 30.0
_singbox_identity_lock = threading.Lock()
_singbox_identity_cache: Dict[str, Tuple[float, str, str]] = {}


def _config_path() -> Path:
    return Path(__file__).resolve().parent / "config.json"


def _ip_state_path() -> Path:
    """同 IP 占用时间戳的跨进程状态文件。

    与 config.json 同目录：DATA_DIR 未必可写，而注册进程一定能写 register/。
    可用 PROXY_IP_STATE_PATH 覆盖（测试隔离用）。
    """
    env = (os.environ.get("PROXY_IP_STATE_PATH") or "").strip()
    if env:
        return Path(env)
    return _config_path().with_name("proxy_ip_state.json")


class _CrossProcLock:
    """基于 O_CREAT|O_EXCL 的跨进程锁（Node 侧对 config.json 用同名 .lock 协调）。

    锁文件：<target>.lock。获取失败自旋等待（配合线程锁保证单进程互斥）。
    超时后强制放行——宁可偶发覆盖也不永久卡死注册流程。
    过期锁（陈旧 > stale_sec）视为崩溃残留，直接接管。
    """

    def __init__(
        self,
        target: Path | None = None,
        *,
        thread_lock: threading.Lock | None = None,
        timeout: float = 5.0,
        stale_sec: float = 30.0,
    ):
        self._path = str(target or _config_path()) + ".lock"
        self._thread_lock = thread_lock if thread_lock is not None else _config_lock
        self._timeout = timeout
        self._stale_sec = stale_sec
        self._fd = None

    def __enter__(self):
        self._thread_lock.acquire()
        deadline = time.time() + self._timeout
        while True:
            try:
                self._fd = os.open(
                    self._path, os.O_CREAT | os.O_EXCL | os.O_WRONLY
                )
                try:
                    os.write(self._fd, str(os.getpid()).encode("ascii", "replace"))
                except Exception:
                    pass
                return self
            except FileExistsError:
                # 陈旧锁（进程崩溃残留）直接清掉
                try:
                    st = os.stat(self._path)
                    if time.time() - st.st_mtime > self._stale_sec:
                        os.unlink(self._path)
                        continue
                except FileNotFoundError:
                    continue
                except Exception:
                    pass
                if time.time() >= deadline:
                    # 超时放行：不持文件锁，仅靠原子写降低损坏面
                    self._fd = None
                    return self
                time.sleep(0.05)
            except Exception:
                # 无法用文件锁（如平台异常）：放行，仍走原子写
                self._fd = None
                return self

    def __exit__(self, *exc):
        try:
            if self._fd is not None:
                os.close(self._fd)
                os.unlink(self._path)
        except Exception:
            pass
        finally:
            self._fd = None
            self._thread_lock.release()
        return False


# 兼容旧名：config.json 专用锁
_CrossProcConfigLock = _CrossProcLock


def _atomic_write_config(conf: dict) -> None:
    """原子写 config.json（Node 侧读同一文件，禁止半写）。"""
    atomic_write_json(_config_path(), conf, newline=False)


# 跨进程 IP 占用状态：独立线程锁（与 config.json 锁不同文件，互不阻塞）
_ip_state_lock = threading.Lock()


def _load_ip_state() -> Dict[str, float]:
    """读跨进程 IP 占用时间戳。文件缺失/损坏 → 空表（绝不阻断注册）。"""
    try:
        raw = json.loads(_ip_state_path().read_text(encoding="utf-8"))
    except Exception:
        return {}
    used = raw.get("last_used") if isinstance(raw, dict) else None
    if not isinstance(used, dict):
        return {}
    out: Dict[str, float] = {}
    for k, v in used.items():
        try:
            out[str(k)] = float(v)
        except Exception:
            continue
    return out

def _merge_ip_state(claims: Dict[str, float]) -> Dict[str, float]:
    """把本进程的占用时间戳并入磁盘状态并落盘，返回合并后的全量表。

    每个 key 取较新值。持跨进程锁 + 原子写，避免多 runner 互相覆盖。
    落盘失败不抛出：退化为进程内计时，绝不因状态文件问题卡死注册。
    """
    now = time.time()
    interval = float(_proxy_ip_interval_sec or 0)
    keep = max(interval * 4, 3600.0)
    try:
        with _CrossProcLock(
            _ip_state_path(), thread_lock=_ip_state_lock, timeout=2.0
        ):
            merged = _load_ip_state()
            # 迁移旧版本用本地入口作为 key 的状态；新版本按实际出口 IP / 节点 tag 计时。
            try:
                if _singbox_enabled_from_config():
                    for legacy in (
                        "127.0.0.1:2080",
                        "localhost:2080",
                        "::1:2080",
                        "[::1]:2080",
                    ):
                        merged.pop(legacy, None)
            except Exception:
                pass
            for k, ts in claims.items():
                if k and ts > merged.get(k, 0.0):
                    merged[k] = ts
            merged = {k: v for k, v in merged.items() if now - v <= keep}
            atomic_write_json(
                _ip_state_path(), {"last_used": merged}, newline=False
            )
            return merged
    except Exception:
        return dict(claims)


def _singbox_enabled_from_config() -> bool:
    conf = _read_config_dict()
    raw = conf.get("singbox_enabled")
    if isinstance(raw, bool):
        return raw
    return str(raw or "").strip().lower() in ("1", "true", "yes", "on", "enabled")


def _singbox_runtime_config_path() -> Path:
    override = (os.environ.get("SINGBOX_RUNTIME_CONFIG_PATH") or "").strip()
    if override:
        return Path(override)
    return Path(os.environ.get("DATA_DIR") or "/data") / "sing-box" / "config.json"


def _active_singbox_node_tag() -> str:
    try:
        raw = json.loads(_singbox_runtime_config_path().read_text(encoding="utf-8"))
        route = raw.get("route") if isinstance(raw, dict) else None
        return str(route.get("final") or "").strip() if isinstance(route, dict) else ""
    except Exception:
        return ""


def _is_singbox_local_proxy(proxy_url: str) -> bool:
    if not _singbox_enabled_from_config():
        return False
    raw = proxy_url if "://" in proxy_url else f"http://{proxy_url}"
    try:
        parsed = urlparse(raw.split("#", 1)[0])
        host = (parsed.hostname or "").lower()
        return host in ("127.0.0.1", "localhost", "::1") and parsed.port == 2080
    except Exception:
        return False


def _probe_singbox_exit_ip(proxy_url: str) -> str:
    """通过当前 Sing-Box 入口探测公网 IP；失败返回空串，不阻断注册。"""
    handler = urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
    opener = urllib.request.build_opener(handler)
    endpoints = (
        "https://api.ipify.org?format=json",
        "https://www.cloudflare.com/cdn-cgi/trace",
    )
    for endpoint in endpoints:
        try:
            req = urllib.request.Request(endpoint, headers={"User-Agent": "GRA/1.0"})
            with opener.open(req, timeout=6) as resp:
                body = resp.read(4096).decode("utf-8", "replace")
            candidate = ""
            if "format=json" in endpoint:
                try:
                    candidate = str((json.loads(body) or {}).get("ip") or "").strip()
                except Exception:
                    candidate = ""
            if not candidate:
                match = re.search(r"(?m)^ip=([^\s]+)", body)
                candidate = match.group(1).strip() if match else ""
            try:
                return str(ipaddress.ip_address(candidate))
            except ValueError:
                continue
        except Exception:
            continue
    return ""


def _basic_proxy_identity_key(proxy_url: str) -> str:
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


def _singbox_proxy_identity_key(proxy_url: str) -> str:
    node_tag = _active_singbox_node_tag()
    if node_tag:
        return f"singbox-node:{node_tag}"

    # 没有 route.final 时才探测公网 IP；该分支仅用于兼容残缺/手工测试配置。
    now = time.time()
    with _singbox_identity_lock:
        cached = _singbox_identity_cache.get(proxy_url)
        if cached and cached[1] == node_tag and now - cached[0] < _SINGBOX_IDENTITY_TTL_SEC:
            return cached[2]
        exit_ip = _probe_singbox_exit_ip(proxy_url)
        identity = (
            f"singbox-ip:{exit_ip}"
            if exit_ip
            else _basic_proxy_identity_key(proxy_url)
        )
        _singbox_identity_cache[proxy_url] = (now, node_tag, identity)
        return identity


def proxy_identity_key(proxy_url: str) -> str:
    """返回共享节流身份：Sing-Box 优先 route.final，普通代理使用 host:port。"""
    s = _strip_proxy_comment(proxy_url or "")
    if not s:
        return ""
    if _is_singbox_local_proxy(s):
        return _singbox_proxy_identity_key(s)
    return _basic_proxy_identity_key(s)




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
    return _singbox_enabled_from_config()


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
        # 同步改写 register/config.json 的 proxy_pool，避免 force reload 又读回死代理。
        # Node（writeConfigForPython）与其它注册子进程会并发写同一文件，故：
        # 持跨进程文件锁 → 锁内 read-modify-write → 原子替换，杜绝半写/互相覆盖。
        try:
            path = _config_path()
            with _CrossProcConfigLock():
                if path.is_file():
                    conf = json.loads(path.read_text(encoding="utf-8"))
                    pool = conf.get("proxy_pool") or conf.get("proxies")
                    changed = False
                    if isinstance(pool, list):
                        conf["proxy_pool"] = [
                            x
                            for x in pool
                            if proxy_identity_key(str(x or "")) != key
                        ]
                        changed = True
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
                        changed = True
                    if changed:
                        _atomic_write_config(conf)
        except Exception as e:
            print(f"[Warn] 写 config.json 剔除死代理失败: {e}", flush=True)
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

    def _build_identity_hints() -> Dict[str, str]:
        # Sing-Box 出口探测可能发起网络请求，必须在 _lock 外完成。
        with _lock:
            urls = list(_proxy_list)
        if not urls and (fallback or '').strip():
            urls = [(fallback or '').strip()]
        hints: Dict[str, str] = {}
        for url in dict.fromkeys(urls):
            try:
                hints[url] = proxy_identity_key(url)
            except Exception:
                hints[url] = _basic_proxy_identity_key(url)
        return hints

    while True:
        identity_hints = (
            _build_identity_hints()
            if float(_proxy_ip_interval_sec or 0) > 0
            else {}
        )
        # 跨进程真相源：先并入磁盘状态，避免与同出口上的其它 runner 各自计时。
        # 放在 _lock 之外：文件 IO 不该阻塞其它线程读配置。
        if float(_proxy_ip_interval_sec or 0) > 0:
            try:
                disk_used = _merge_ip_state({})
            except Exception:
                disk_used = {}
        else:
            disk_used = {}

        with _lock:
            interval = float(_proxy_ip_interval_sec or 0)
            # 磁盘上更新的时间戳并入进程内表（取较新者），再做冷却判定
            for _k, _ts in disk_used.items():
                if _ts > _proxy_last_used.get(_k, 0.0):
                    _proxy_last_used[_k] = _ts
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

            def identity_for(url: str) -> str:
                return identity_hints.get(url) or proxy_identity_key(url)

            def remaining(url: str) -> float:
                if interval <= 0:
                    return 0.0
                key = identity_for(url)
                if not key:
                    return 0.0
                last = _proxy_last_used.get(key, 0.0)
                if last <= 0:
                    return 0.0
                return max(0.0, interval - (now - last))

            # 1) preferred 已冷却 → 直接用
            rem_pref = remaining(preferred)
            claimed: Optional[Tuple[str, float]] = None
            picked: Optional[str] = None
            sleep_sec = 0.0
            wait_key = "-"
            if rem_pref <= 0:
                key = identity_for(preferred)
                if key and interval > 0:
                    _proxy_last_used[key] = now
                    claimed = (key, now)
                picked = preferred
            else:
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
                    key = identity_for(chosen)
                    if key and interval > 0:
                        _proxy_last_used[key] = now
                        claimed = (key, now)
                    picked = chosen
                else:
                    # 3) 全部冷却中 → 暂停等待最早可用
                    sleep_sec = min(max(soonest_wait, 0.05), 30.0)
                    wait_key = identity_for(soonest_url) or "-"

        # 已占用到代理：锁外立即落盘，让同出口的其它 runner 立刻看到
        if picked is not None:
            if claimed is not None:
                try:
                    _merge_ip_state({claimed[0]: claimed[1]})
                except Exception:
                    pass
            return picked, waited

        # 锁外 sleep，避免阻塞其它线程读配置
        try:
            log(
                f"[*] IP 使用间隔未到：等待 {sleep_sec:.1f}s "
                f"(间隔={interval:.0f}s, key={wait_key})"
            )
        except Exception:
            pass
        time.sleep(sleep_sec)
        waited += sleep_sec
        # 循环再取，时间到后会命中 ready / preferred


def mark_proxy_used(proxy_url: str) -> None:
    """手动标记代理已用于注册（一般 acquire 内已标记）。

    同样落盘到跨进程状态，否则同出口上的其它 runner 看不到这次占用。
    """
    key = proxy_identity_key(proxy_url)
    if not key:
        return
    now = time.time()
    should_persist = False
    with _lock:
        if _proxy_ip_interval_sec > 0:
            _proxy_last_used[key] = now
            should_persist = True
    if should_persist:
        try:
            _merge_ip_state({key: now})
        except Exception:
            pass


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
            "ip_state": str(_ip_state_path()),
            "config": str(_config_path()),
        }
