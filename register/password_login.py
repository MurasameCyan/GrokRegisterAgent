# -*- coding: utf-8 -*-
"""邮箱+密码登录 accounts.x.ai / grok.com，提取 grok.com 域 SSO cookie。

供 Auth 测活遇 403 时恢复：重登 → mint CPA → 发英文消息 → 二次测活。
"""
from __future__ import annotations

import json
import secrets
import time
from typing import Any, Callable

LogFn = Callable[[str], None]


def _noop(msg: str) -> None:
    pass


def password_login_sso(
    email: str,
    password: str,
    *,
    proxy: str = "",
    headless: bool = True,
    timeout: float = 90.0,
    log: LogFn | None = None,
) -> dict[str, Any]:
    """用账号密码浏览器登录，返回 grok.com 的 sso cookie。

    返回:
      ok, sso, email, error
    """
    log = log or _noop
    email = str(email or "").strip()
    password = str(password or "").strip()
    if not email or not password:
        return {"ok": False, "error": "missing email or password", "email": email}

    try:
        from DrissionPage import ChromiumOptions, Chromium  # type: ignore
    except Exception as e:
        return {"ok": False, "error": f"DrissionPage unavailable: {e}", "email": email}

    co = ChromiumOptions()
    try:
        co.headless(bool(headless))
    except Exception:
        pass
    try:
        co.set_argument("--no-sandbox")
        co.set_argument("--disable-dev-shm-usage")
        co.set_argument("--disable-gpu")
        co.set_argument("--lang=en-US")
    except Exception:
        pass

    proxy_s = str(proxy or "").strip()
    if proxy_s:
        try:
            # 与注册机一致：set_proxy 可能丢凭据，尽量原样设置
            co.set_proxy(proxy_s)
        except Exception as e:
            log(f"[password_login] set_proxy failed: {e}")

    browser = None
    page = None
    try:
        browser = Chromium(co)
        page = browser.latest_tab
        sign_in_url = "https://accounts.x.ai/sign-in?redirect=grok-com"
        log(f"[password_login] open {sign_in_url}")
        page.get(sign_in_url)
        time.sleep(1.0 + secrets.randbelow(40) / 100.0)

        # 点「Login with email」类按钮（若已在邮箱表单则跳过）
        page.run_js(
            r"""
function isVisible(n) {
  if (!n) return false;
  const s = window.getComputedStyle(n);
  if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
  const r = n.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}
const emailInput = document.querySelector(
  'input[type="email"], input[name="email"], input[autocomplete="username"], input[data-testid="email"]'
);
if (emailInput && isVisible(emailInput)) return 'has-email';
const candidates = Array.from(document.querySelectorAll(
  'button, a, [role="button"], div[role="button"]'
)).filter(isVisible);
const target = candidates.find((node) => {
  const text = (node.innerText || node.textContent || '').replace(/\s+/g, '').toLowerCase();
  if (text.includes('loginwithemail') || text.includes('signinwithemail')) return true;
  if (text.includes('continuewithemail') || text.includes('邮箱登录') || text.includes('使用邮箱')) return true;
  if (text.includes('email') && (text.includes('login') || text.includes('sign') || text.includes('continue'))) return true;
  return false;
});
if (target) { try { target.click(); } catch (e) {} return 'clicked'; }
return 'none';
"""
        )
        time.sleep(0.8)

        # 填邮箱
        filled = page.run_js(
            r"""
const email = arguments[0];
function pick(sel) {
  const list = Array.from(document.querySelectorAll(sel));
  return list.find((n) => {
    const s = window.getComputedStyle(n);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }) || null;
}
const input = pick(
  'input[type="email"], input[name="email"], input[autocomplete="username"], input[data-testid="email"], input[type="text"]'
);
if (!input) return false;
input.focus();
input.value = '';
input.dispatchEvent(new Event('input', { bubbles: true }));
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
setter.call(input, email);
input.dispatchEvent(new Event('input', { bubbles: true }));
input.dispatchEvent(new Event('change', { bubbles: true }));
return String(input.value || '') === String(email || '');
""",
            email,
        )
        if not filled:
            return {"ok": False, "error": "email input not found", "email": email}

        # 点 Continue / Next
        page.run_js(
            r"""
function isVisible(n) {
  if (!n) return false;
  const s = window.getComputedStyle(n);
  if (s.display === 'none' || s.visibility === 'hidden') return false;
  const r = n.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}
const candidates = Array.from(document.querySelectorAll(
  'button, [type="submit"], [role="button"]'
)).filter(isVisible);
const target = candidates.find((node) => {
  const text = (node.innerText || node.textContent || '').replace(/\s+/g, '').toLowerCase();
  if (text.includes('continue') || text.includes('next') || text.includes('继续') || text.includes('下一步')) return true;
  if (node.getAttribute('type') === 'submit') return true;
  return false;
});
if (target) { try { target.click(); } catch (e) {} return true; }
return false;
"""
        )
        time.sleep(1.2)

        # 填密码
        filled_pw = page.run_js(
            r"""
const password = arguments[0];
function pick(sel) {
  const list = Array.from(document.querySelectorAll(sel));
  return list.find((n) => {
    const s = window.getComputedStyle(n);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }) || null;
}
const input = pick(
  'input[type="password"], input[name="password"], input[autocomplete="current-password"], input[data-testid="password"]'
);
if (!input) return false;
input.focus();
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
setter.call(input, password);
input.dispatchEvent(new Event('input', { bubbles: true }));
input.dispatchEvent(new Event('change', { bubbles: true }));
return true;
""",
            password,
        )
        if not filled_pw:
            return {"ok": False, "error": "password input not found", "email": email}

        # 提交登录
        page.run_js(
            r"""
function isVisible(n) {
  if (!n) return false;
  const s = window.getComputedStyle(n);
  if (s.display === 'none' || s.visibility === 'hidden') return false;
  const r = n.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}
const candidates = Array.from(document.querySelectorAll(
  'button, [type="submit"], [role="button"]'
)).filter(isVisible);
const target = candidates.find((node) => {
  const text = (node.innerText || node.textContent || '').replace(/\s+/g, '').toLowerCase();
  if (text.includes('log in') || text.includes('login') || text.includes('sign in') || text.includes('signin')) return true;
  if (text.includes('continue') || text.includes('登录') || text.includes('繼續')) return true;
  if (node.getAttribute('type') === 'submit') return true;
  return false;
}) || candidates.find((n) => n.getAttribute('type') === 'submit');
if (target) { try { target.click(); } catch (e) {} return true; }
return false;
"""
        )

        # 等跳到 grok.com 并拿到 sso cookie
        deadline = time.time() + max(30.0, float(timeout))
        sso_val = ""
        last_url = ""
        while time.time() < deadline:
            try:
                last_url = str(page.url or "")
            except Exception:
                last_url = ""
            # 优先 grok.com 域 sso
            try:
                cookies = page.cookies()
                if isinstance(cookies, dict):
                    items = [{"name": k, "value": v, "domain": ""} for k, v in cookies.items()]
                else:
                    items = list(cookies or [])
                for c in items:
                    if not isinstance(c, dict):
                        continue
                    name = str(c.get("name") or "")
                    if name.lower() != "sso":
                        continue
                    domain = str(c.get("domain") or "").lower()
                    val = str(c.get("value") or "").strip()
                    if not val:
                        continue
                    # 优先 grok.com
                    if "grok.com" in domain or domain.endswith("grok.com"):
                        sso_val = val
                        break
                    if not sso_val:
                        sso_val = val
                if sso_val and ("grok.com" in last_url or len(sso_val) > 40):
                    # 再确认 grok 域
                    if "grok.com" in last_url or any(
                        "grok.com" in str(c.get("domain") or "").lower()
                        for c in items
                        if isinstance(c, dict) and str(c.get("name") or "").lower() == "sso"
                    ):
                        break
            except Exception:
                pass
            # 若仍停在 accounts，尝试点授权 / continue
            try:
                if "accounts.x.ai" in last_url or "auth.x.ai" in last_url:
                    page.run_js(
                        r"""
const candidates = Array.from(document.querySelectorAll('button, [role="button"], a'));
const t = candidates.find((n) => {
  const text = (n.innerText || '').toLowerCase();
  return /continue|allow|authorize|同意|继续/.test(text);
});
if (t) t.click();
"""
                    )
            except Exception:
                pass
            time.sleep(0.8)

        if not sso_val:
            return {
                "ok": False,
                "error": f"login timeout, last_url={last_url}",
                "email": email,
            }

        # 规范化：去掉 sso= 前缀
        if sso_val.lower().startswith("sso="):
            sso_val = sso_val[4:]
        log(f"[password_login] got sso len={len(sso_val)} url={last_url}")
        return {"ok": True, "sso": sso_val, "email": email, "url": last_url}
    except Exception as e:
        return {"ok": False, "error": str(e)[:400], "email": email}
    finally:
        try:
            if browser is not None:
                browser.quit()
        except Exception:
            pass


def recover_auth_on_dead(
    path: str,
    email: str,
    password: str,
    *,
    proxy: str = "",
    trigger_http: int = 403,
    log: LogFn | None = None,
) -> dict[str, Any]:
    """401/403 恢复：密码登录 → mint CPA 覆盖 path → 发英文消息 → 二次 probe。"""
    log = log or _noop
    from pathlib import Path

    from auth_service import sso_to_cpa_auth
    from cpa_probe import probe_cpa_auth

    email = str(email or "").strip()
    password = str(password or "").strip()
    p = Path(path)
    out: dict[str, Any] = {
        "ok": False,
        "recovered_403": False,  # 兼容：401/403 恢复链路均可能置 True
        "recovered_auth": False,
        "trigger_http": int(trigger_http or 0),
        "email": email,
        "path": str(p),
    }

    login = password_login_sso(email, password, proxy=proxy, log=log)
    out["login"] = {
        "ok": bool(login.get("ok")),
        "error": login.get("error"),
    }
    if not login.get("ok") or not login.get("sso"):
        out["error"] = login.get("error") or "password login failed"
        return out

    sso = str(login["sso"])
    mint = sso_to_cpa_auth(
        sso=sso,
        email=email,
        proxy=proxy,
        auth_dir=p.parent,
        delete_on_dead=False,
        skip_remote=True,
        log=log,
    )
    out["mint"] = {
        "ok": bool(mint.get("ok")),
        "path": mint.get("path"),
        "error": mint.get("error"),
    }
    # mint 可能因 probe dead 返回 ok=False 但文件已写
    written = str(mint.get("path") or "")
    if written and Path(written).is_file():
        target = Path(written)
    elif p.is_file():
        target = p
    else:
        out["error"] = mint.get("error") or "mint failed"
        return out

    # 若 mint 写到新文件名，尽量同步覆盖原 path（保持 filename 稳定）
    if target.resolve() != p.resolve() and target.is_file():
        try:
            data = json.loads(target.read_text(encoding="utf-8"))
            p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            try:
                if target.name != p.name:
                    target.unlink()
            except Exception:
                pass
            target = p
        except Exception as e:
            log(f"[recover_auth] overwrite failed: {e}")

    # 发任意英文消息（二次检测前 warm-up）
    msg_probe = probe_cpa_auth(
        target,
        proxy=proxy,
        prompt="Hello, please reply with a short greeting.",
        max_output_tokens=32,
    )
    out["message"] = {
        "action": msg_probe.get("action"),
        "http_status": msg_probe.get("http_status"),
        "summary": msg_probe.get("summary"),
    }

    # 二次正式测活（短 ping）
    second = probe_cpa_auth(target, proxy=proxy, prompt="ping", max_output_tokens=1)
    out["second_probe"] = second
    out["action"] = second.get("action")
    out["http_status"] = second.get("http_status")
    out["alive"] = second.get("action") == "ok"
    out["ok"] = second.get("action") == "ok"
    out["recovered_403"] = True
    out["recovered_auth"] = True
    out["path"] = str(target)
    out["email"] = second.get("email") or email
    if second.get("action") != "ok":
        out["error"] = (
            second.get("error")
            or second.get("summary")
            or f"HTTP {second.get('http_status')}"
        )
    return out


def recover_auth_on_403(
    path: str,
    email: str,
    password: str,
    *,
    proxy: str = "",
    log: LogFn | None = None,
) -> dict[str, Any]:
    """兼容旧名：等同 recover_auth_on_dead(..., trigger_http=403)。"""
    return recover_auth_on_dead(
        path, email, password, proxy=proxy, trigger_http=403, log=log
    )
