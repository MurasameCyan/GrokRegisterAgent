"""
为 Chromium / DrissionPage 生成「需账号密码」的代理扩展。

DrissionPage 的 co.set_proxy() 不支持 user:pass@host:port，会打印：
「你似乎在设置使用账号密码的代理，暂时不支持这种代理」
并忽略该代理（实际直连 → Turnstile 易失败）。

方案：每轮生成临时 Manifest V3 扩展，用 chrome.proxy + webRequestAuthProvider 注入凭据。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from typing import Any
from urllib.parse import unquote, urlparse


def parse_proxy_url(proxy_url: str) -> dict[str, Any] | None:
    """
    解析代理 URL。
    支持:
      http://user:pass@host:port
      http://user:pass@host:port#备注
      socks5://user:pass@host:port
      用户名含 base64 的 `==`（住宅代理 token 常见）
    返回: scheme, host, port, username, password, has_auth

    凭据用「最后一个 @ 前」+「第一个 : 拆 user/pass」手动解析，
    避免个别环境下 URL 解析丢认证导致 407。
    """
    raw = (proxy_url or "").strip()
    if not raw:
        return None
    # 去掉误粘贴的反引号/引号
    raw = raw.strip("`'\"").strip()
    # 剥 #备注
    scheme_idx = raw.find("://")
    search_from = scheme_idx + 3 if scheme_idx >= 0 else 0
    hash_idx = raw.find("#", search_from)
    if hash_idx >= 0:
        raw = raw[:hash_idx].strip()
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", raw):
        raw = "http://" + raw

    m = re.match(r"^([a-zA-Z][a-zA-Z0-9+.-]*)://(.*)$", raw)
    if not m:
        return None
    scheme = (m.group(1) or "http").lower()
    if scheme in ("socks", "socks5h"):
        scheme = "socks5"
    rest = (m.group(2) or "").split("/")[0].split("?")[0]

    username = ""
    password = ""
    host_port = rest
    at = rest.rfind("@")
    if at >= 0:
        cred = rest[:at]
        host_port = rest[at + 1 :]
        colon = cred.find(":")
        if colon >= 0:
            username = unquote(cred[:colon])
            password = unquote(cred[colon + 1 :])
        else:
            username = unquote(cred)
            password = ""

    host = ""
    port: int | None = None
    if host_port.startswith("["):
        end = host_port.find("]")
        if end < 0:
            return None
        host = host_port[1:end].strip()
        p = host_port[end + 1 :]
        if p.startswith(":"):
            try:
                port = int(p[1:])
            except ValueError:
                port = None
    else:
        colon = host_port.rfind(":")
        if colon < 0:
            host = host_port.strip()
        else:
            host = host_port[:colon].strip()
            try:
                port = int(host_port[colon + 1 :])
            except ValueError:
                port = None

    if not host:
        # 回退 urlparse
        try:
            u = urlparse(raw)
            host = (u.hostname or "").strip()
            if not username and u.username:
                username = unquote(u.username)
            if not password and u.password:
                password = unquote(u.password)
            if not port and u.port:
                port = int(u.port)
        except Exception:
            return None
    if not host:
        return None
    if not port:
        port = 1080 if scheme.startswith("socks") else (443 if scheme == "https" else 8080)

    return {
        "scheme": scheme,
        "host": host,
        "port": int(port),
        "username": username,
        "password": password,
        "has_auth": bool(username or password),
        "raw": raw,
    }


def create_proxy_auth_extension(
    proxy_url: str,
    *,
    parent_dir: str | None = None,
) -> tuple[str, dict[str, Any]]:
    """
    生成代理认证扩展目录，返回 (path, parsed)。
    parent_dir 建议用本轮 chrome profile 旁的临时目录，stop 时一并删。
    """
    parsed = parse_proxy_url(proxy_url)
    if not parsed:
        raise ValueError(f"无法解析代理 URL: {proxy_url!r}")
    if not parsed["has_auth"]:
        raise ValueError("代理无账号密码，无需 auth 扩展")

    base = parent_dir or tempfile.mkdtemp(prefix="proxy_auth_")
    os.makedirs(base, exist_ok=True)
    ext_dir = os.path.join(base, "proxy_auth_ext")
    if os.path.isdir(ext_dir):
        shutil.rmtree(ext_dir, ignore_errors=True)
    os.makedirs(ext_dir, exist_ok=True)

    # Manifest V3（Chromium 127+ 不再允许 MV2）
    manifest = {
        "manifest_version": 3,
        "name": "GrokRegister Proxy Auth",
        "version": "1.0.0",
        "permissions": [
            "proxy",
            "storage",
            "webRequest",
            "webRequestAuthProvider",
        ],
        "host_permissions": ["<all_urls>"],
        "background": {"service_worker": "background.js"},
        "minimum_chrome_version": "108",
    }
    with open(os.path.join(ext_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    # JS 字符串转义
    def jsq(s: str) -> str:
        return json.dumps(str(s), ensure_ascii=False)

    scheme = parsed["scheme"]
    host = parsed["host"]
    port = parsed["port"]
    user = parsed["username"]
    pwd = parsed["password"]

    # chrome.proxy 的 scheme: http | https | socks4 | socks5 | quic
    # socks4a → socks4；socks / socks5h → socks5
    if scheme in ("socks", "socks5h"):
        proxy_scheme = "socks5"
    elif scheme in ("socks4a",):
        proxy_scheme = "socks4"
    elif scheme in ("http", "https", "socks4", "socks5", "quic"):
        proxy_scheme = scheme
    else:
        proxy_scheme = "http"

    background_js = f"""
// Auto-generated proxy auth extension — do not edit
const config = {{
  mode: "fixed_servers",
  rules: {{
    singleProxy: {{
      scheme: {jsq(proxy_scheme)},
      host: {jsq(host)},
      port: {int(port)}
    }},
    bypassList: ["localhost", "127.0.0.1", "::1"]
  }}
}};

chrome.proxy.settings.set({{ value: config, scope: "regular" }}, () => {{
  if (chrome.runtime.lastError) {{
    console.warn("proxy set error", chrome.runtime.lastError);
  }}
}});

const AUTH = {{
  username: {jsq(user)},
  password: {jsq(pwd)}
}};

function onAuth(details, callback) {{
  callback({{ authCredentials: AUTH }});
}}

if (chrome.webRequest && chrome.webRequest.onAuthRequired) {{
  try {{
    // MV3: asyncBlocking + callback
    chrome.webRequest.onAuthRequired.addListener(
      onAuth,
      {{ urls: ["<all_urls>"] }},
      ["asyncBlocking"]
    );
  }} catch (e) {{
    try {{
      chrome.webRequest.onAuthRequired.addListener(
        () => ({{ authCredentials: AUTH }}),
        {{ urls: ["<all_urls>"] }},
        ["blocking"]
      );
    }} catch (e2) {{
      console.warn("onAuthRequired failed", e, e2);
    }}
  }}
}}
"""
    with open(os.path.join(ext_dir, "background.js"), "w", encoding="utf-8") as f:
        f.write(background_js.strip() + "\n")

    return ext_dir, parsed


def apply_proxy_to_chromium_options(
    co,
    proxy_url: str,
    *,
    work_dir: str | None = None,
    prefer_local_forward: bool = False,
) -> dict[str, Any]:
    """
    将代理应用到 ChromiumOptions。
    - 无认证：co.set_proxy / --proxy-server
    - 有认证：默认 MV3 扩展；prefer_local_forward=True 或扩展失败时走本地无认证转发
    返回 {mode, path?, local_proxy?, parsed?, error?}
    """
    proxy_url = (proxy_url or "").strip()
    if not proxy_url:
        return {"mode": "direct"}

    parsed = parse_proxy_url(proxy_url)
    if not parsed:
        return {"mode": "error", "error": f"bad proxy url: {proxy_url!r}"}

    if not parsed["has_auth"]:
        # 无账号密码：优先 DrissionPage set_proxy，失败则 --proxy-server
        simple = f"{parsed['scheme']}://{parsed['host']}:{parsed['port']}"
        try:
            co.set_proxy(simple)
            return {"mode": "set_proxy", "parsed": parsed, "proxy": simple}
        except Exception as e1:
            try:
                co.set_argument("--proxy-server", simple)
                return {"mode": "arg", "parsed": parsed, "proxy": simple, "warn": str(e1)}
            except Exception as e2:
                return {"mode": "error", "error": f"{e1}; {e2}", "parsed": parsed}

    def _try_local_forward(reason: str = "") -> dict[str, Any]:
        try:
            from proxy_local_forward import start_local_forward

            r = start_local_forward(proxy_url)
            if not r.get("ok"):
                return {
                    "mode": "error",
                    "error": r.get("error") or "local forward failed",
                    "parsed": parsed,
                    "fallback_reason": reason,
                }
            local = r["local_proxy"]
            try:
                co.set_proxy(local)
            except Exception:
                co.set_argument("--proxy-server", local)
            return {
                "mode": "local_forward",
                "local_proxy": local,
                "port": r.get("port"),
                "parsed": parsed,
                "proxy": f"{parsed['scheme']}://{parsed['username']}:***@{parsed['host']}:{parsed['port']}",
                "fallback_reason": reason,
            }
        except Exception as e:
            return {
                "mode": "error",
                "error": str(e),
                "parsed": parsed,
                "fallback_reason": reason,
            }

    # 有认证：绝不能 co.set_proxy(user:pass)（DrissionPage 会丢弃并直连）。
    # 策略：prefer_local_forward / PROXY_AUTH_MODE 控制先后；默认本地转发更稳。
    env_mode = (os.environ.get("PROXY_AUTH_MODE") or "").strip().lower()
    force_ext = env_mode in ("extension", "ext", "mv3")
    force_local = prefer_local_forward or env_mode in (
        "local",
        "forward",
        "local_forward",
    )

    def _try_extension() -> dict[str, Any]:
        try:
            try:
                co.set_proxy("")
            except Exception:
                try:
                    co.remove_argument("--proxy-server")
                except Exception:
                    pass
            ext_path, p = create_proxy_auth_extension(proxy_url, parent_dir=work_dir)
            co.add_extension(ext_path)
            return {
                "mode": "auth_extension",
                "path": ext_path,
                "parsed": p,
                "proxy": f"{p['scheme']}://{p['username']}:***@{p['host']}:{p['port']}",
                "upstream_url": proxy_url,
                "can_fallback_local": True,
            }
        except Exception as e:
            return {
                "mode": "error",
                "error": str(e),
                "parsed": parsed,
                "upstream_url": proxy_url,
                "can_fallback_local": True,
            }

    if force_ext:
        r = _try_extension()
        if r.get("mode") == "auth_extension":
            return r
        print(f"[Warn] 认证扩展失败，改试本地转发: {r.get('error')}")
        return _try_local_forward(f"extension_error:{r.get('error')}")

    if force_local:
        r = _try_local_forward("prefer_local_forward")
        if r.get("mode") == "local_forward":
            return r
        print(f"[Warn] 本地转发失败，改试认证扩展: {r.get('error')}")
        r2 = _try_extension()
        if r2.get("mode") == "auth_extension":
            return r2
        return r

    # 默认（prefer_local_forward=False）：扩展 → 本地
    r = _try_extension()
    if r.get("mode") == "auth_extension":
        return r
    print(f"[Warn] 认证扩展失败，改试本地转发: {r.get('error')}")
    return _try_local_forward(f"extension_error:{r.get('error')}")
