
from __future__ import annotations

import json
import random
import re
import string
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    from curl_cffi import requests as curl_requests
except ImportError:
    curl_requests = None

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ============================================================
# 自建邮件服务配置（兼容 dreamhunter2333/cloudflare_temp_email / vmail）
# ============================================================

_config_path = Path(__file__).parent / "config.json"
_conf: Dict[str, Any] = {}
if _config_path.exists():
    with _config_path.open("r", encoding="utf-8") as _f:
        _conf = json.load(_f)


def _normalize_mail_api_base(raw: str) -> str:
    """规范化邮件后端根地址。

    cloudflare_temp_email 的 admin 接口挂在 Worker 根：
      POST {base}/admin/new_address
    常见误填：
      - 前端 Pages 域名（仅 GET，POST 会 405 且 body 为空）
      - 末尾带 /admin、/api、多余斜杠
    """
    base = (raw or "").strip().rstrip("/")
    if not base:
        return ""
    # 去掉误粘贴的路径后缀
    for suffix in ("/admin/new_address", "/admin", "/api/mails", "/api"):
        if base.lower().endswith(suffix):
            base = base[: -len(suffix)].rstrip("/")
    return base


def _reload_mail_conf() -> None:
    """每轮创建前热读 config.json，避免进程内常量过期。"""
    global _conf, MAIL_API_BASE, MAIL_ADMIN_AUTH, MAIL_DOMAIN, PROXY
    try:
        if _config_path.exists():
            with _config_path.open("r", encoding="utf-8") as f:
                _conf = json.load(f)
    except Exception:
        pass
    MAIL_API_BASE = _normalize_mail_api_base(str(_conf.get("mail_api_base", "")))
    MAIL_ADMIN_AUTH = str(_conf.get("mail_admin_auth", "") or "")
    MAIL_DOMAIN = str(_conf.get("mail_domain", "") or "").strip().lstrip("@")
    PROXY = str(_conf.get("proxy", "") or "")


MAIL_API_BASE = _normalize_mail_api_base(str(_conf.get("mail_api_base", "")))
MAIL_ADMIN_AUTH = str(_conf.get("mail_admin_auth", ""))
MAIL_DOMAIN = str(_conf.get("mail_domain", "")).strip().lstrip("@")
PROXY = str(_conf.get("proxy", ""))

# 邮箱域名池（可选）；轮换逻辑见 pools.next_mail_domain
try:
    from pools import next_mail_domain, next_proxy, reload_pools
except Exception:  # pragma: no cover
    def next_mail_domain(fallback: str = "") -> str:
        return fallback

    def next_proxy(fallback: str = "") -> str:
        return fallback

    def reload_pools(force: bool = False) -> None:
        return None

# ============================================================
# 适配层：为 DrissionPage_example.py 提供简单接口
# ============================================================


def _mail_provider() -> str:
    _reload_mail_conf()
    p = str(_conf.get("mail_provider") or _conf.get("email_provider") or "cloudflare").strip().lower()
    if p in ("cf", "temp_email", "vmail", "cloudflare_temp_email"):
        return "cloudflare"
    if p in ("duck", "duckmail"):
        return "duckmail"
    if p in ("yyds", "yydsmail"):
        return "yyds"
    if p in ("gptmail", "gpt", "chatgpt_mail", "chatgpt-mail"):
        return "gptmail"
    return p or "cloudflare"


def get_email_and_token() -> Tuple[Optional[str], Optional[str]]:
    """
    创建临时邮箱，返回 (email, token)。
    provider: cloudflare（默认）| duckmail | yyds
    token 用于后续轮询验证码（CF=jwt，duck/yyds=jwt 或 account token）。
    """
    provider = _mail_provider()
    if provider == "duckmail":
        email, token = _create_duckmail()
        return email, token
    if provider == "yyds":
        email, token = _create_yyds()
        return email, token
    if provider == "gptmail":
        email, token = _create_gptmail()
        return email, token
    email, _password, jwt = create_temp_email()
    if email and jwt:
        return email, jwt
    return None, None


def _create_duckmail() -> Tuple[Optional[str], Optional[str]]:
    """
    DuckMail（mail.tm 兼容 API）：
      POST {base}/accounts  {"address","password"}
      POST {base}/token     {"address","password"} → jwt
    读信：GET {base}/messages + Bearer jwt（列表 hydra:member）
    config: mail_api_base 必填；mail_domain 可选偏好；mail_admin_auth 仅自建鉴权可选。
    """
    _reload_mail_conf()
    base = MAIL_API_BASE.rstrip("/")
    admin = MAIL_ADMIN_AUTH.strip()
    if not base:
        raise Exception("duckmail: mail_api_base 未设置（如 https://api.duckmail.sbs）")
    domain = (MAIL_DOMAIN or "").strip().lstrip("@")
    # 未填域名时从 /domains 取第一个可用
    session, use_cffi = _create_session()
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if admin:
        headers["Authorization"] = f"Bearer {admin}"
    if not domain:
        try:
            res = _do_request(
                session, use_cffi, "get", f"{base}/domains", headers=headers, timeout=15
            )
            if res.status_code == 200 and res.text:
                data = res.json()
                members = []
                if isinstance(data, dict):
                    members = data.get("hydra:member") or data.get("member") or data.get("domains") or []
                elif isinstance(data, list):
                    members = data
                for m in members or []:
                    if isinstance(m, dict) and m.get("domain") and m.get("isVerified", True):
                        domain = str(m["domain"]).strip().lstrip("@")
                        break
                    if isinstance(m, str) and m.strip():
                        domain = m.strip().lstrip("@")
                        break
        except Exception:
            pass
    if not domain:
        domain = "duckmail.sbs"
    last_err = ""
    for _ in range(4):
        local = _generate_local_part()
        address = f"{local}@{domain}"
        password = (
            random.choice(string.ascii_letters)
            + "".join(random.choice(string.ascii_letters + string.digits) for _ in range(11))
            + "!"
        )
        try:
            res = _do_request(
                session,
                use_cffi,
                "post",
                f"{base}/accounts",
                json={"address": address, "password": password},
                headers=headers,
                timeout=20,
            )
            if res.status_code not in (200, 201):
                last_err = f"accounts HTTP {res.status_code}: {(res.text or '')[:160]}"
                # 地址冲突再试
                if res.status_code in (400, 409, 422):
                    continue
                raise Exception(last_err)
            # 换 jwt
            tres = _do_request(
                session,
                use_cffi,
                "post",
                f"{base}/token",
                json={"address": address, "password": password},
                headers=headers,
                timeout=20,
            )
            if tres.status_code not in (200, 201):
                last_err = f"token HTTP {tres.status_code}: {(tres.text or '')[:160]}"
                raise Exception(last_err)
            tdata = tres.json() if tres.text else {}
            if not isinstance(tdata, dict):
                tdata = {}
            jwt = str(tdata.get("token") or tdata.get("jwt") or tdata.get("access_token") or "").strip()
            if not jwt:
                raise Exception(f"token 响应无 jwt: {tdata}")
            print(f"[*] duckmail 创建成功: {address}")
            return address, jwt
        except Exception as e:
            last_err = str(e)
            continue
    raise Exception(f"duckmail 创建失败: {last_err}")


def _normalize_yyds_base(raw: str) -> str:
    """YYDS 官方根默认带 /v1：https://maliapi.215.im/v1"""
    base = (raw or "").strip().rstrip("/")
    if not base:
        return ""
    # 去掉误粘贴的业务路径
    for suffix in ("/accounts", "/messages", "/api/email/create"):
        if base.lower().endswith(suffix):
            base = base[: -len(suffix)].rstrip("/")
    # 裸域名补 /v1（与 FlowPilot DEFAULT_YYDS_MAIL_BASE_URL 对齐）
    try:
        from urllib.parse import urlparse
        p = urlparse(base if "://" in base else f"https://{base}")
        path = (p.path or "").rstrip("/")
        if path in ("", "/"):
            base = f"{p.scheme}://{p.netloc}/v1"
        elif not path.endswith("/v1"):
            # 用户已写其它前缀则尊重；仅当明确是官方主机且无 v1 时补
            if p.netloc.endswith("215.im") and "/v1" not in path:
                base = f"{p.scheme}://{p.netloc}/v1"
    except Exception:
        pass
    return base.rstrip("/")


def _create_yyds() -> Tuple[Optional[str], Optional[str]]:
    """
    YYDS Mail（对齐 FlowPilot yyds-mail-provider）：
      创建：POST {base}/accounts  header X-API-Key  body {localPart}
      读信：GET  {base}/messages?address=…  header Authorization Bearer <temp token>
    config: mail_api_base（默认 https://maliapi.215.im/v1）, mail_admin_auth = API Key
    """
    _reload_mail_conf()
    base = _normalize_yyds_base(MAIL_API_BASE or "https://maliapi.215.im/v1")
    api_key = MAIL_ADMIN_AUTH.strip()
    # 去掉误粘贴的 Bearer 前缀（YYDS 只认 X-API-Key）
    if len(api_key) >= 7 and api_key[:7].lower() == "bearer ":
        api_key = api_key[7:].strip()
    if not base:
        raise Exception("yyds: mail_api_base 未设置（如 https://maliapi.215.im/v1）")
    if not api_key:
        raise Exception("yyds: mail_admin_auth 未设置（填 YYDS X-API-Key）")
    local = _generate_local_part()
    # FlowPilot localPart: 6 字母 + 4 数字
    if len(local) < 8:
        local = local + "".join(random.choice(string.digits) for _ in range(4))
    session, use_cffi = _create_session()
    headers = {
        "X-API-Key": api_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    url = f"{base}/accounts"
    last_err = ""
    for attempt in range(3):
        body = {"localPart": local if attempt == 0 else _generate_local_part()}
        try:
            res = _do_request(
                session, use_cffi, "post", url, json=body, headers=headers, timeout=25
            )
            if res.status_code in (200, 201):
                data = res.json() if res.text else {}
                if not isinstance(data, dict):
                    data = {}
                if data.get("success") is False:
                    last_err = str(data.get("error") or data.get("message") or data)[:200]
                    raise Exception(last_err)
                inner = data.get("data") if isinstance(data.get("data"), dict) else data
                email = (
                    inner.get("address")
                    or inner.get("email")
                    or inner.get("mail")
                    or ""
                )
                jwt = (
                    inner.get("token")
                    or inner.get("tempToken")
                    or inner.get("accessToken")
                    or inner.get("jwt")
                    or ""
                )
                if email and jwt:
                    print(f"[*] yyds 创建成功: {email}")
                    return str(email), str(jwt)
                last_err = f"无 address/token: {data}"
            else:
                last_err = f"HTTP {res.status_code}: {(res.text or '')[:200]} | {url}"
                # 错误 key 时常见 401/403；web_app_only 表示未带 X-API-Key
                if res.status_code in (401, 403):
                    break
        except Exception as e:
            last_err = f"{e} | {url}"
    raise Exception(f"yyds 创建失败: {last_err}")




def _normalize_gptmail_base(raw: str) -> str:
    """GPTMail site root: https://mail.chatgpt.org.uk (no /api path)."""
    base = (raw or "").strip().rstrip("/")
    if not base:
        return ""
    for suffix in (
        "/api/generate-email",
        "/api/emails",
        "/api/email",
        "/api/stats",
        "/api",
    ):
        if base.lower().endswith(suffix):
            base = base[: -len(suffix)].rstrip("/")
    try:
        from urllib.parse import urlparse

        p = urlparse(base if "://" in base else f"https://{base}")
        path = (p.path or "").rstrip("/")
        if path in ("", "/") or path.startswith("/api"):
            base = f"{p.scheme}://{p.netloc}"
        else:
            base = f"{p.scheme}://{p.netloc}{path}"
    except Exception:
        pass
    return base.rstrip("/")


def _create_gptmail() -> Tuple[Optional[str], Optional[str]]:
    """
    GPTMail (mail.chatgpt.org.uk):
      create: POST {base}/api/generate-email  header X-API-Key  body {prefix?, domain?}
      list:   GET  {base}/api/emails?email=   header X-API-Key
      detail: GET  {base}/api/email/{id}      header X-API-Key
    Returns (email, api_key). Poll reuses api_key as X-API-Key (not Bearer).
    config: mail_api_base default https://mail.chatgpt.org.uk, mail_admin_auth = API Key
    """
    _reload_mail_conf()
    base = _normalize_gptmail_base(MAIL_API_BASE or "https://mail.chatgpt.org.uk")
    api_key = MAIL_ADMIN_AUTH.strip()
    if len(api_key) >= 7 and api_key[:7].lower() == "bearer ":
        api_key = api_key[7:].strip()
    if not base:
        raise Exception("gptmail: mail_api_base unset (e.g. https://mail.chatgpt.org.uk)")
    if not api_key:
        raise Exception("gptmail: mail_admin_auth unset (GPTMail X-API-Key)")
    domain = (MAIL_DOMAIN or "").strip().lstrip("@")
    session, use_cffi = _create_session()
    headers = {
        "X-API-Key": api_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    url = f"{base}/api/generate-email"
    last_err = ""
    for attempt in range(3):
        prefix = _generate_local_part()
        body: Dict[str, Any] = {"prefix": prefix}
        if domain:
            body["domain"] = domain
        try:
            res = _do_request(
                session, use_cffi, "post", url, json=body, headers=headers, timeout=25
            )
            if res.status_code in (200, 201):
                data = res.json() if res.text else {}
                if not isinstance(data, dict):
                    data = {}
                if data.get("success") is False:
                    last_err = str(data.get("error") or data.get("message") or data)[:200]
                    if "api key" in last_err.lower() or "invalid" in last_err.lower():
                        break
                    raise Exception(last_err)
                inner = data.get("data") if isinstance(data.get("data"), dict) else data
                email = (
                    (inner or {}).get("email")
                    or (inner or {}).get("address")
                    or (inner or {}).get("mail")
                    or ""
                )
                if email:
                    print(f"[*] gptmail create ok: {email}")
                    return str(email), str(api_key)
                last_err = f"no email in response: {data}"
            else:
                last_err = f"HTTP {res.status_code}: {(res.text or '')[:200]} | {url}"
                if res.status_code in (401, 403):
                    break
        except Exception as e:
            last_err = f"{e} | {url}"
    raise Exception(f"gptmail create failed: {last_err}")


def get_oai_code(dev_token: str, email: str, timeout: int = 30) -> Optional[str]:
    """
    轮询邮箱获取 Grok/x.ai 发来的 OTP 验证码。
    返回去掉连字符后的字符串（如 "MM0SF3"），失败返回 None。
    """
    code = wait_for_verification_code(jwt=dev_token, timeout=timeout, email=email or "")
    if code:
        code = code.replace("-", "")
    return code


# ============================================================
# 核心：与 vmail (https://github.com/...) 后端交互
# ============================================================


def _create_session():
    """优先 curl_cffi 走 chrome131 指纹，避免 Cloudflare 拦截"""
    if curl_requests:
        session = curl_requests.Session()
        session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
            "Content-Type": "application/json",
        })
        if PROXY:
            session.proxies = {"http": PROXY, "https": PROXY}
        return session, True

    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    s = requests.Session()
    retry = Retry(total=3, backoff_factor=1, status_forcelist=[429, 500, 502, 503, 504])
    adapter = HTTPAdapter(max_retries=retry)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    s.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
        "Content-Type": "application/json",
    })
    if PROXY:
        s.proxies = {"http": PROXY, "https": PROXY}
    return s, False


def _do_request(session, use_cffi, method, url, **kwargs):
    if use_cffi:
        kwargs.setdefault("impersonate", "chrome131")
    return getattr(session, method)(url, **kwargs)


def _generate_local_part(min_len=8, max_len=13) -> str:
    chars = string.ascii_lowercase + string.digits
    length = random.randint(min_len, max_len)
    # 首字符必须是字母，避免某些校验拒绝纯数字开头
    return random.choice(string.ascii_lowercase) + "".join(
        random.choice(chars) for _ in range(length - 1)
    )


def _cf_auth_mode() -> str:
    """cloudflare_temp_email 创建接口鉴权：none|x-admin-auth|bearer|x-api-key|query-key。

    config: cloudflare_auth_mode / mail_auth_mode（默认 x-admin-auth 保持兼容）
    """
    _reload_mail_conf()
    m = str(
        _conf.get("cloudflare_auth_mode")
        or _conf.get("mail_auth_mode")
        or _conf.get("cf_auth_mode")
        or "x-admin-auth"
    ).strip().lower()
    if m in ("admin", "x-admin", "admin-auth"):
        return "x-admin-auth"
    if m in ("", "password", "admin_password"):
        return "x-admin-auth"
    if m in ("none", "anonymous", "anon", "public"):
        return "none"
    if m in ("bearer", "authorization", "jwt"):
        return "bearer"
    if m in ("x-api-key", "apikey", "api-key", "api_key"):
        return "x-api-key"
    if m in ("query-key", "query", "query_key", "key"):
        return "query-key"
    return m


def _cf_create_path(auth_mode: str) -> str:
    """创建路径：admin 模式用 /admin/new_address；匿名/public 用 /api/new_address。"""
    raw = str(
        _conf.get("cloudflare_create_path")
        or _conf.get("mail_create_path")
        or ""
    ).strip()
    if raw:
        return raw if raw.startswith("/") else f"/{raw}"
    if auth_mode == "none":
        return "/api/new_address"
    return "/admin/new_address"


def build_cf_auth_headers(
    auth_mode: str,
    api_key: str,
    *,
    content_type: bool = True,
) -> dict[str, str]:
    """按鉴权模式构造 Cloudflare 临时邮箱请求头。"""
    headers: dict[str, str] = {}
    if content_type:
        headers["Content-Type"] = "application/json"
    key = (api_key or "").strip()
    mode = (auth_mode or "none").strip().lower()
    if not key or mode in ("none", "anonymous", "anon", "public"):
        return headers
    if mode == "x-admin-auth":
        headers["x-admin-auth"] = key
    elif mode in ("x-api-key", "apikey", "api-key", "api_key"):
        headers["X-API-Key"] = key
    elif mode in ("bearer", "authorization"):
        headers["Authorization"] = f"Bearer {key}"
    # query-key 不写 header，由 URL 参数携带
    return headers


def create_temp_email() -> Tuple[str, str, str]:
    """
    创建 cloudflare_temp_email 地址。

    鉴权模式（cloudflare_auth_mode）:
      - x-admin-auth（默认）：POST /admin/new_address + x-admin-auth
      - none：POST /api/new_address 匿名（无需密钥）
      - bearer / x-api-key / query-key：兼容其它 Worker 配置

    返回 {jwt, address, password}，jwt 即用于读邮件的 Bearer。
    域名：优先邮箱域名池轮换，否则用 MAIL_DOMAIN。
    """
    # 每轮创建前热读邮件配置 + 池（支持 UI 改完立刻生效）
    _reload_mail_conf()
    try:
        reload_pools(force=True)
    except Exception:
        pass

    if not MAIL_API_BASE:
        raise Exception(
            "mail_api_base 未设置。请填 cloudflare_temp_email 的 **Worker API 根地址**"
            "（不是前端 Pages 域名），例如 https://xxx.workers.dev"
        )

    auth_mode = _cf_auth_mode()
    api_key = MAIL_ADMIN_AUTH.strip()
    if auth_mode not in ("none", "anonymous", "anon", "public") and not api_key:
        raise Exception(
            f"mail_admin_auth 未设置（cloudflare_auth_mode={auth_mode} 需要密钥）"
        )

    create_path = _cf_create_path(auth_mode)
    headers = build_cf_auth_headers(auth_mode, api_key, content_type=True)
    session, use_cffi = _create_session()
    base_url = f"{MAIL_API_BASE.rstrip('/')}{create_path}"
    print(
        f"[*] 邮件 API: {MAIL_API_BASE} → POST {create_path} "
        f"auth_mode={auth_mode}"
    )

    # 域名池状态（便于确认轮换是否生效）
    try:
        from pools import peek_status as _peek_mail_pools

        _st = _peek_mail_pools()
        _doms = list(_st.get("domains") or [])
        _idx = _st.get("domain_idx", "?")
        if _doms:
            print(
                f"[*] 邮箱域名池: {len(_doms)} 个 mode={_st.get('domain_mode') or '?'} "
                f"next_idx={_idx} → {', '.join(_doms[:8])}{'…' if len(_doms) > 8 else ''}"
            )
        else:
            _raw_pool = _conf.get("mail_domains") or _conf.get("mail_domain_pool")
            print(
                f"[*] 邮箱域名: 单域名 {MAIL_DOMAIN or '(未设置)'} "
                f"（config.mail_domains={_raw_pool!r}）"
            )
    except Exception as e:
        print(f"[Warn] 域名池状态读取失败: {e}")

    last_err = ""
    for _ in range(5):
        local = _generate_local_part()
        domain = next_mail_domain(MAIL_DOMAIN) or MAIL_DOMAIN
        # 匿名 /api/new_address 可不指定 domain（由 Worker 分配）
        is_admin = create_path.rstrip("/").lower().endswith("/admin/new_address")
        if is_admin and not domain:
            raise Exception("mail_domain / mail_domains 未设置，无法创建邮箱地址")
        if is_admin:
            payload: dict[str, Any] = {
                "name": local,
                "domain": domain,
                "enablePrefix": False,
            }
        else:
            payload = {}
            if domain:
                payload["domain"] = domain
            # 部分部署允许自定义 name
            if _truthy_conf("cloudflare_create_with_name"):
                payload["name"] = local
                payload["enablePrefix"] = True

        create_url = base_url
        if auth_mode in ("query-key", "query", "query_key", "key") and api_key:
            sep = "&" if "?" in create_url else "?"
            create_url = f"{create_url}{sep}key={api_key}"

        try:
            res = _do_request(
                session,
                use_cffi,
                "post",
                create_url,
                json=payload,
                headers=headers,
                timeout=15,
            )
            if res.status_code in (200, 201):
                data = res.json()
                jwt = data.get("jwt")
                address = data.get("address") or (
                    f"{local}@{domain}" if domain else ""
                )
                password = data.get("password", "")
                if jwt and address:
                    print(
                        f"[*] 邮箱创建成功: {address}"
                        f"（domain={domain or '-'} mode={auth_mode}）"
                    )
                    return address, password, jwt
                last_err = f"响应缺少 jwt/address: {data}"
            else:
                body = (res.text or "").strip()
                if len(body) > 200:
                    body = body[:200] + "..."
                last_err = f"HTTP {res.status_code}: {body} | url={create_url}"
                if res.status_code == 405:
                    last_err += (
                        " | 提示: 405 多为 API 地址填成了前端/Pages 或错误路径；"
                        "admin 用 /admin/new_address，匿名用 /api/new_address"
                    )
                if res.status_code in (401, 403):
                    last_err += (
                        f" | 提示: 鉴权失败 auth_mode={auth_mode}，"
                        "可改 cloudflare_auth_mode=none|x-admin-auth|bearer|x-api-key"
                    )
                if res.status_code in (400, 409):
                    continue
                break
        except Exception as e:
            last_err = f"{e} | url={create_url}"

    raise Exception(f"创建邮箱失败: {last_err}")


def _truthy_conf(key: str) -> bool:
    v = _conf.get(key)
    if v is True:
        return True
    if v is False or v is None:
        return False
    return str(v).lower() in ("1", "true", "yes", "on")


def fetch_emails(jwt: str, limit: int = 20, email: str = "") -> List[Dict[str, Any]]:
    """获取邮件列表（cloudflare / duckmail mail.tm / yyds 官方路径）。"""
    _reload_mail_conf()
    provider = _mail_provider()
    session, use_cffi = _create_session()
    base = MAIL_API_BASE.rstrip("/")
    paths: List[Tuple[str, Dict[str, Any]]] = []
    if provider == "gptmail":
        base = _normalize_gptmail_base(base or "https://mail.chatgpt.org.uk")
        api_key = (jwt or MAIL_ADMIN_AUTH or "").strip()
        if len(api_key) >= 7 and api_key[:7].lower() == "bearer ":
            api_key = api_key[7:].strip()
        headers = {"X-API-Key": api_key, "Accept": "application/json"}
        params_g: Dict[str, Any] = {}
        if email:
            params_g["email"] = email
        paths = [("/api/emails", params_g)]
    elif provider == "yyds":
        headers = {"Authorization": f"Bearer {jwt}", "Accept": "application/json"}
        base = _normalize_yyds_base(base or "https://maliapi.215.im/v1")
        params: Dict[str, Any] = {"limit": limit}
        if email:
            params["address"] = email
        paths = [("/messages", params)]
    elif provider == "duckmail":
        headers = {"Authorization": f"Bearer {jwt}", "Accept": "application/json"}
        # mail.tm GET /messages -> hydra:member
        paths = [
            ("/messages", {"page": 1}),
            ("/messages", {"limit": limit}),
        ]
    else:
        headers = {"Authorization": f"Bearer {jwt}", "Accept": "application/json"}
        paths = [("/api/mails", {"limit": limit, "offset": 0})]
    for path, params in paths:
        try:
            res = _do_request(
                session,
                use_cffi,
                "get",
                f"{base}{path}",
                params=params,
                headers=headers,
                timeout=15,
            )
            if res.status_code != 200:
                continue
            data = res.json() if res.text else {}
            if isinstance(data, list):
                return [x for x in data if isinstance(x, dict)]
            if not isinstance(data, dict):
                continue
            # 业务失败
            if data.get("success") is False:
                continue
            # 嵌套 data
            if isinstance(data.get("data"), dict):
                data = data["data"]
            for key in (
                "hydra:member",
                "results",
                "messages",
                "mails",
                "emails",
                "data",
                "items",
                "list",
                "records",
            ):
                arr = data.get(key)
                if isinstance(arr, list):
                    return [x for x in arr if isinstance(x, dict)]
                if isinstance(arr, dict):
                    inner = arr.get("results") or arr.get("items") or arr.get("list") or arr.get("hydra:member")
                    if isinstance(inner, list):
                        return [x for x in inner if isinstance(x, dict)]
        except Exception:
            continue
    return []


def fetch_email_detail(jwt: str, msg_id: Any, email: str = "") -> Optional[Dict]:
    """获取单封邮件详情（含正文）。"""
    _reload_mail_conf()
    provider = _mail_provider()
    session, use_cffi = _create_session()
    base = MAIL_API_BASE.rstrip("/")
    paths: List[str] = []
    params: Dict[str, Any] = {}
    if provider == "gptmail":
        base = _normalize_gptmail_base(base or "https://mail.chatgpt.org.uk")
        api_key = (jwt or MAIL_ADMIN_AUTH or "").strip()
        if len(api_key) >= 7 and api_key[:7].lower() == "bearer ":
            api_key = api_key[7:].strip()
        headers = {"X-API-Key": api_key, "Accept": "application/json"}
        paths = [f"/api/email/{msg_id}"]
    elif provider == "yyds":
        headers = {"Authorization": f"Bearer {jwt}", "Accept": "application/json"}
        base = _normalize_yyds_base(base or "https://maliapi.215.im/v1")
        paths = [f"/messages/{msg_id}"]
        if email:
            params["address"] = email
    elif provider == "duckmail":
        headers = {"Authorization": f"Bearer {jwt}", "Accept": "application/json"}
        paths = [f"/messages/{msg_id}"]
    else:
        headers = {"Authorization": f"Bearer {jwt}", "Accept": "application/json"}
        paths = [f"/api/mail/{msg_id}", f"/api/mails/{msg_id}"]
    for path in paths:
        try:
            res = _do_request(
                session,
                use_cffi,
                "get",
                f"{base}{path}",
                params=params or None,
                headers=headers,
                timeout=15,
            )
            if res.status_code == 200:
                data = res.json() if res.text else None
                if isinstance(data, dict):
                    if data.get("success") is False:
                        continue
                    inner = data.get("data") if isinstance(data.get("data"), dict) else data
                    return inner if isinstance(inner, dict) else data
        except Exception:
            continue
    return None


def wait_for_verification_code(jwt: str, timeout: int = 120, email: str = "") -> Optional[str]:
    """轮询等待验证码邮件"""
    start = time.time()
    seen_ids = set()

    try:
        poll_interval = max(0.5, float(_conf.get("mail_poll_interval", 1)))
    except (TypeError, ValueError):
        poll_interval = 1

    while time.time() - start < timeout:
        messages = fetch_emails(jwt, email=email or "")
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            msg_id = msg.get("id")
            if msg_id is None or msg_id in seen_ids:
                continue
            seen_ids.add(msg_id)

            # 列表接口通常已带正文；不够时再请求详情。
            content = (
                msg.get("raw")
                or msg.get("text")
                or msg.get("html")
                or msg.get("body")
                or msg.get("bodyPreview")
                or msg.get("intro")
                or ""
            )
            if isinstance(content, list):
                content = "\n".join(str(x) for x in content)
            if not content:
                detail = fetch_email_detail(jwt, msg_id, email=email or "")
                if detail:
                    content = (
                        detail.get("raw")
                        or detail.get("text")
                        or detail.get("html")
                        or detail.get("body")
                        or detail.get("bodyPreview")
                        or ""
                    )
                    if isinstance(content, list):
                        content = "\n".join(str(x) for x in content)

            # 把 subject 也并进来，方便 6 位数字模式匹配
            subject = msg.get("subject") or ""
            if subject:
                content = f"Subject: {subject}\n{content}"

            code = extract_verification_code(content)
            if code:
                print(f"[*] 提取到验证码: {code}")
                return code
        time.sleep(poll_interval)
    return None


def extract_verification_code(content: str) -> Optional[str]:
    """
    从邮件内容提取验证码。
    Grok/x.ai 格式：MM0-SF3（3位-3位字母数字混合）或 6 位纯数字。
    """
    if not content:
        return None

    # 模式 1: Grok 格式 XXX-XXX
    m = re.search(r"(?<![A-Z0-9-])([A-Z0-9]{3}-[A-Z0-9]{3})(?![A-Z0-9-])", content)
    if m:
        return m.group(1)

    # 模式 2: 带标签的验证码
    m = re.search(r"(?:verification code|验证码|your code)[:\s]*[<>\s]*([A-Z0-9]{3}-[A-Z0-9]{3})\b", content, re.IGNORECASE)
    if m:
        return m.group(1)

    # 模式 3: HTML 样式包裹
    m = re.search(r"background-color:\s*#F3F3F3[^>]*>[\s\S]*?([A-Z0-9]{3}-[A-Z0-9]{3})[\s\S]*?</p>", content)
    if m:
        return m.group(1)

    # 模式 4: Subject 行 6 位数字
    m = re.search(r"Subject:.*?(\d{6})", content)
    if m and m.group(1) != "177010":
        return m.group(1)

    # 模式 5: HTML 标签内 6 位数字
    for code in re.findall(r">\s*(\d{6})\s*<", content):
        if code != "177010":
            return code

    # 模式 6: 独立 6 位数字
    for code in re.findall(r"(?<![&#\d])(\d{6})(?![&#\d])", content):
        if code != "177010":
            return code

    return None
