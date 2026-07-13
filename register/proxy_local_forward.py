"""
本地无认证 HTTP 代理 → 上游带账号密码代理的转发。

用途：MV3 onAuthRequired 在个别 Chromium 上不稳定时，
浏览器只连 127.0.0.1:随机端口（无需认证），由本进程向上游做 Basic 认证。

支持上游 HTTP 代理（CONNECT 隧道转发 HTTPS）。
"""
from __future__ import annotations

import base64
import select
import socket
import threading
from typing import Any

from proxy_auth_ext import parse_proxy_url

_active: dict[str, Any] = {
    "thread": None,
    "sock": None,
    "port": 0,
    "upstream": "",
}


def _relay(a: socket.socket, b: socket.socket) -> None:
    try:
        while True:
            r, _, _ = select.select([a, b], [], [], 60)
            if not r:
                break
            for s in r:
                other = b if s is a else a
                try:
                    data = s.recv(65536)
                except Exception:
                    return
                if not data:
                    return
                try:
                    other.sendall(data)
                except Exception:
                    return
    except Exception:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
            try:
                s.close()
            except Exception:
                pass


def _handle_client(client: socket.socket, upstream: dict[str, Any]) -> None:
    client.settimeout(30)
    try:
        first = b""
        while b"\r\n\r\n" not in first and len(first) < 65536:
            chunk = client.recv(4096)
            if not chunk:
                client.close()
                return
            first += chunk
        header_end = first.find(b"\r\n\r\n")
        if header_end < 0:
            client.close()
            return
        head = first[:header_end].decode("latin-1", "replace")
        rest = first[header_end + 4 :]
        lines = head.split("\r\n")
        if not lines:
            client.close()
            return
        parts = lines[0].split()
        if len(parts) < 2:
            client.close()
            return
        method = parts[0].upper()
        target = parts[1]
        auth = base64.b64encode(
            f"{upstream['username']}:{upstream['password']}".encode("utf-8")
        ).decode("ascii")
        up_host = upstream["host"]
        up_port = int(upstream["port"])

        up = socket.create_connection((up_host, up_port), timeout=20)
        up.settimeout(30)

        if method == "CONNECT":
            # 浏览器 CONNECT host:port → 本地 → 上游 CONNECT + Proxy-Authorization
            req = (
                f"CONNECT {target} HTTP/1.1\r\n"
                f"Host: {target}\r\n"
                f"Proxy-Authorization: Basic {auth}\r\n"
                f"Proxy-Connection: keep-alive\r\n"
                f"\r\n"
            )
            up.sendall(req.encode("latin-1"))
            resp = b""
            while b"\r\n\r\n" not in resp and len(resp) < 65536:
                chunk = up.recv(4096)
                if not chunk:
                    break
                resp += chunk
            # 原样回给浏览器（含 200 Connection established）
            client.sendall(resp)
            if b" 200 " not in resp.split(b"\r\n", 1)[0]:
                up.close()
                client.close()
                return
            if rest:
                up.sendall(rest)
            _relay(client, up)
            return

        # 普通 HTTP 代理请求：补 Proxy-Authorization 后原样转发
        new_lines = [lines[0]]
        has_auth = False
        for ln in lines[1:]:
            if ln.lower().startswith("proxy-authorization:"):
                has_auth = True
                new_lines.append(f"Proxy-Authorization: Basic {auth}")
            else:
                new_lines.append(ln)
        if not has_auth:
            new_lines.append(f"Proxy-Authorization: Basic {auth}")
        body = ("\r\n".join(new_lines) + "\r\n\r\n").encode("latin-1") + rest
        up.sendall(body)
        _relay(client, up)
    except Exception:
        try:
            client.close()
        except Exception:
            pass


def stop_local_forward() -> None:
    """停止当前本地转发（若有）。"""
    global _active
    sock = _active.get("sock")
    if sock is not None:
        try:
            sock.close()
        except Exception:
            pass
    _active = {"thread": None, "sock": None, "port": 0, "upstream": ""}


def start_local_forward(upstream_proxy_url: str) -> dict[str, Any]:
    """
    启动本地 127.0.0.1:port 无认证代理，转发到带认证上游。
    返回 {ok, local_proxy, port, error?}
    """
    stop_local_forward()
    parsed = parse_proxy_url(upstream_proxy_url)
    if not parsed:
        return {"ok": False, "error": "无法解析上游代理"}
    if not parsed.get("has_auth"):
        return {"ok": False, "error": "上游无认证，无需本地转发"}
    scheme = (parsed.get("scheme") or "http").lower()
    if scheme not in ("http", "https"):
        return {
            "ok": False,
            "error": f"本地转发目前仅支持 HTTP(S) 上游，当前 {scheme}",
        }

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 0))
    server.listen(64)
    port = int(server.getsockname()[1])
    stop_flag = threading.Event()

    def accept_loop() -> None:
        while not stop_flag.is_set():
            try:
                server.settimeout(1.0)
                try:
                    client, _ = server.accept()
                except socket.timeout:
                    continue
                t = threading.Thread(
                    target=_handle_client,
                    args=(client, parsed),
                    daemon=True,
                )
                t.start()
            except OSError:
                break
            except Exception:
                continue

    th = threading.Thread(target=accept_loop, daemon=True)
    th.start()
    _active["thread"] = th
    _active["sock"] = server
    _active["port"] = port
    _active["upstream"] = (
        f"{parsed['scheme']}://{parsed['username'][:8]}…:***@"
        f"{parsed['host']}:{parsed['port']}"
    )
    local = f"http://127.0.0.1:{port}"
    return {
        "ok": True,
        "local_proxy": local,
        "port": port,
        "upstream": _active["upstream"],
    }


def verify_exit_ip(
    proxy_url: str = "",
    *,
    timeout: float = 12.0,
) -> dict[str, Any]:
    """
    经代理（或直连）访问 api.ipify.org，返回出口 IP。
    proxy_url 空 = 直连。
    """
    import urllib.error
    import urllib.request

    url = "https://api.ipify.org?format=json"
    handlers: list = []
    if proxy_url:
        p = parse_proxy_url(proxy_url)
        if p:
            if p.get("has_auth"):
                # urllib 支持 user:pass@host
                proxy_handler_url = (
                    f"{p['scheme']}://{p['username']}:{p['password']}"
                    f"@{p['host']}:{p['port']}"
                )
            else:
                proxy_handler_url = f"{p['scheme']}://{p['host']}:{p['port']}"
            handlers.append(
                urllib.request.ProxyHandler(
                    {"http": proxy_handler_url, "https": proxy_handler_url}
                )
            )
    opener = urllib.request.build_opener(*handlers) if handlers else urllib.request.build_opener()
    req = urllib.request.Request(url, headers={"User-Agent": "grok-register-agent/ip-check"})
    try:
        with opener.open(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
            ip = ""
            try:
                import json

                ip = str(json.loads(body).get("ip") or "").strip()
            except Exception:
                ip = body.strip()
            return {"ok": bool(ip), "ip": ip, "raw": body[:200], "via": proxy_url or "direct"}
    except Exception as e:
        return {"ok": False, "ip": "", "error": str(e), "via": proxy_url or "direct"}


def verify_exit_ip_via_browser(page, timeout: float = 15.0) -> dict[str, Any]:
    """在已启动的 Chromium 标签页中访问 ipify，确认浏览器真实出口。"""
    if page is None:
        return {"ok": False, "error": "page is None"}
    try:
        page.get("https://api.ipify.org?format=json")
        # 等 body
        import time

        deadline = time.time() + timeout
        text = ""
        while time.time() < deadline:
            try:
                text = page.run_js("return document.body && document.body.innerText || ''") or ""
            except Exception:
                text = ""
            if text and ("ip" in text.lower() or text.strip().count(".") >= 3):
                break
            time.sleep(0.3)
        ip = ""
        try:
            import json

            ip = str(json.loads(text).get("ip") or "").strip()
        except Exception:
            # 纯文本 IP
            t = (text or "").strip().strip('"')
            if t and " " not in t and len(t) < 64:
                ip = t
        return {"ok": bool(ip), "ip": ip, "raw": (text or "")[:200]}
    except Exception as e:
        return {"ok": False, "ip": "", "error": str(e)}
