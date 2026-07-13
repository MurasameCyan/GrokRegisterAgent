
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

MAIL_API_BASE = str(_conf.get("mail_api_base", "")).rstrip("/")
MAIL_ADMIN_AUTH = str(_conf.get("mail_admin_auth", ""))
MAIL_DOMAIN = str(_conf.get("mail_domain", ""))
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


def get_email_and_token() -> Tuple[Optional[str], Optional[str]]:
    """
    在自建邮件服务上创建一个新地址，返回 (email, jwt)。
    jwt 用于后续轮询邮件。
    """
    email, _password, jwt = create_temp_email()
    if email and jwt:
        return email, jwt
    return None, None


def get_oai_code(dev_token: str, email: str, timeout: int = 30) -> Optional[str]:
    """
    轮询邮箱获取 Grok/x.ai 发来的 OTP 验证码。
    返回去掉连字符后的字符串（如 "MM0SF3"），失败返回 None。
    """
    code = wait_for_verification_code(jwt=dev_token, timeout=timeout)
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


def create_temp_email() -> Tuple[str, str, str]:
    """
    通过 admin 接口创建一个新地址。
    后端返回 {jwt, address, password}，jwt 即用于读邮件的 Bearer。
    域名：优先邮箱域名池轮换，否则用 MAIL_DOMAIN。
    """
    if not MAIL_ADMIN_AUTH:
        raise Exception("mail_admin_auth 未设置，无法创建邮箱地址")

    headers = {"x-admin-auth": MAIL_ADMIN_AUTH}
    # 每轮创建前刷新池配置（支持热更新 config）
    try:
        reload_pools(force=True)
    except Exception:
        pass
    session, use_cffi = _create_session()

    last_err = ""
    for _ in range(5):
        local = _generate_local_part()
        domain = next_mail_domain(MAIL_DOMAIN) or MAIL_DOMAIN
        if not domain:
            raise Exception("mail_domain / mail_domains 未设置，无法创建邮箱地址")
        try:
            res = _do_request(
                session, use_cffi, "post",
                f"{MAIL_API_BASE}/admin/new_address",
                json={"name": local, "domain": domain, "enablePrefix": False},
                headers=headers,
                timeout=15,
            )
            if res.status_code in (200, 201):
                data = res.json()
                jwt = data.get("jwt")
                address = data.get("address") or f"{local}@{domain}"
                password = data.get("password", "")
                if jwt and address:
                    print(f"[*] 邮箱创建成功: {address}")
                    return address, password, jwt
                last_err = f"响应缺少 jwt/address: {data}"
            else:
                last_err = f"HTTP {res.status_code}: {res.text[:200]}"
                # 地址冲突就换个 local 再试
                if res.status_code in (400, 409):
                    continue
                break
        except Exception as e:
            last_err = str(e)

    raise Exception(f"创建邮箱失败: {last_err}")


def fetch_emails(jwt: str, limit: int = 20) -> List[Dict[str, Any]]:
    """获取邮件列表"""
    try:
        headers = {"Authorization": f"Bearer {jwt}"}
        session, use_cffi = _create_session()
        res = _do_request(
            session, use_cffi, "get",
            f"{MAIL_API_BASE}/api/mails",
            params={"limit": limit, "offset": 0},
            headers=headers,
            timeout=15,
        )
        if res.status_code == 200:
            data = res.json()
            return data.get("results") or []
    except Exception:
        pass
    return []


def fetch_email_detail(jwt: str, msg_id: Any) -> Optional[Dict]:
    """获取单封邮件详情（含正文）"""
    try:
        headers = {"Authorization": f"Bearer {jwt}"}
        session, use_cffi = _create_session()
        res = _do_request(
            session, use_cffi, "get",
            f"{MAIL_API_BASE}/api/mail/{msg_id}",
            headers=headers,
            timeout=15,
        )
        if res.status_code == 200:
            return res.json()
    except Exception:
        pass
    return None


def wait_for_verification_code(jwt: str, timeout: int = 120) -> Optional[str]:
    """轮询等待验证码邮件"""
    start = time.time()
    seen_ids = set()

    try:
        poll_interval = max(0.5, float(_conf.get("mail_poll_interval", 1)))
    except (TypeError, ValueError):
        poll_interval = 1

    while time.time() - start < timeout:
        messages = fetch_emails(jwt)
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
                or ""
            )
            if not content:
                detail = fetch_email_detail(jwt, msg_id)
                if detail:
                    content = (
                        detail.get("raw")
                        or detail.get("text")
                        or detail.get("html")
                        or detail.get("body")
                        or ""
                    )

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
