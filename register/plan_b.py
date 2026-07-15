# -*- coding: utf-8 -*-
"""注册 Plan B（FlowPilot 可用能力兜底）。

策略（相对 Plan A）：
  - 步间更长拟人停顿（humanPause / operation-delay 思路）
  - 资料页：优先等 Turnstile 自然成功证据（token / 成功文案），再点提交
  - 模拟完整 click 事件（simulateGrokClick）
  - 识别 CF 安全拦截页，快速失败避免死磕

由主循环在 Plan A 失败后调用一次；再失败则跳过本账号。
"""
from __future__ import annotations

import secrets
import time
from typing import Any, Callable

LogFn = Callable[[str], None]


def _noop(msg: str) -> None:
    pass


def human_pause(min_ms: int = 250, max_ms: int = 850) -> None:
    """FlowPilot humanPause：短随机停顿。"""
    lo = max(50, int(min_ms))
    hi = max(lo, int(max_ms))
    time.sleep((lo + secrets.randbelow(hi - lo + 1)) / 1000.0)


def human_pause_major(min_ms: int = 1200, max_ms: int = 2800) -> None:
    """步间较长延迟（operation-delay 思路）。"""
    human_pause(min_ms, max_ms)


# 检测 CF 安全拦截（移植 OpenAI recovery 思路，适配 x.ai 文案）
_CF_BLOCK_PATTERNS = (
    "max_check_attempts",
    "attention required",
    "you have been blocked",
    "sorry, you have been blocked",
    "cf-error-details",
    "checking your browser",
    "enable javascript and cookies",
    "security check",
    "访问受限",
    "安全验证",
    "请完成安全检查",
)

_TURNSTILE_SUCCESS_TEXT = (
    "success",
    "verified",
    "verification complete",
    "passed",
    "已通过",
    "验证成功",
)


def detect_cf_security_block(page) -> str | None:
    """若当前页像 CF 安全拦截，返回简短原因，否则 None。"""
    if page is None:
        return None
    try:
        info = page.run_js(
            r"""
const title = String(document.title || '');
const body = String(document.body && document.body.innerText || '').slice(0, 4000);
const html = String(document.documentElement && document.documentElement.innerHTML || '').slice(0, 8000);
const href = String(location.href || '');
return { title, body, html, href };
"""
        )
    except Exception:
        return None
    if not isinstance(info, dict):
        return None
    blob = " ".join(
        [
            str(info.get("title") or ""),
            str(info.get("body") or ""),
            str(info.get("html") or ""),
            str(info.get("href") or ""),
        ]
    ).lower()
    for p in _CF_BLOCK_PATTERNS:
        if p in blob:
            return p
    # Cloudflare challenge iframe 占满且无表单
    try:
        blocked = page.run_js(
            r"""
const hasForm = !!(
  document.querySelector('input[type="email"], input[name="email"], input[data-testid="email"], input[name="password"]')
);
const cfIframe = document.querySelector(
  'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]'
);
const bodyText = (document.body && document.body.innerText || '').trim();
if (!hasForm && cfIframe && bodyText.length < 80) return 'cf-iframe-only';
return '';
"""
        )
        if blocked:
            return str(blocked)
    except Exception:
        pass
    return None


_WAIT_TURNSTILE_JS = r"""
function isVisible(n) {
  if (!n) return false;
  const s = window.getComputedStyle(n);
  if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
  const r = n.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}
function token() {
  const fields = Array.from(document.querySelectorAll(
    'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]'
  ));
  const f = fields.find((el) => String(el.value || '').trim());
  return f ? String(f.value || '').trim() : '';
}
function containers() {
  const selectors = [
    '.cf-turnstile',
    '[class*="turnstile" i]',
    '[id*="turnstile" i]',
    '[data-sitekey]',
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="turnstile"]',
    'iframe[title*="cloudflare" i]',
    'iframe[title*="challenge" i]',
    'input[name="cf-turnstile-response"]',
    'textarea[name="cf-turnstile-response"]',
  ].join(', ');
  const set = new Set();
  for (const el of Array.from(document.querySelectorAll(selectors))) {
    let cur = el;
    for (let d = 0; cur && d < 5; d++) {
      if (cur instanceof Element) set.add(cur);
      cur = cur.parentElement;
    }
  }
  return Array.from(set);
}
const t = token();
if (t) return { ok: true, type: 'turnstile_response', tokenLen: t.length };
const successRe = /success|verified|verification complete|passed|已通过|验证成功/i;
for (const c of containers()) {
  const text = (c.innerText || c.textContent || '').trim();
  if (text && successRe.test(text)) return { ok: true, type: 'visible_success_text', text: text.slice(0, 80) };
}
const hasWidget = containers().some(isVisible) || !!document.querySelector(
  'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], .cf-turnstile'
);
return { ok: false, pending: hasWidget, type: hasWidget ? 'pending' : 'absent' };
"""


def wait_turnstile_success(page, timeout: float = 120.0, log: LogFn | None = None) -> dict[str, Any]:
    """等 Turnstile 成功证据（token 或成功文案）。timeout 秒。"""
    log = log or _noop
    deadline = time.time() + max(5.0, float(timeout))
    last: dict[str, Any] = {"ok": False}
    while time.time() < deadline:
        try:
            r = page.run_js(_WAIT_TURNSTILE_JS)
            if isinstance(r, dict):
                last = r
                if r.get("ok"):
                    log(f"[plan-b] Turnstile 成功证据: {r.get('type')}")
                    return r
                if r.get("type") == "absent":
                    # 无人机控件：视为可继续
                    return {"ok": True, "type": "absent"}
        except Exception as e:
            last = {"ok": False, "error": str(e)[:120]}
        time.sleep(0.5)
    return {"ok": False, "timeout": True, **(last if isinstance(last, dict) else {})}


_SIMULATE_CLICK_JS = r"""
const selList = arguments[0];
function isVisible(n) {
  if (!n) return false;
  const s = window.getComputedStyle(n);
  if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
  const r = n.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}
// 禁止未过人机时点提交
const challengeInput = document.querySelector(
  'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]'
);
if (challengeInput && !String(challengeInput.value || '').trim()) {
  return { ok: false, reason: 'turnstile-empty' };
}
const buttons = Array.from(document.querySelectorAll(
  'button[type="submit"], button, [role="button"]'
)).filter(isVisible);
const target = buttons.find((node) => {
  const text = (node.innerText || node.textContent || '').replace(/\s+/g, '');
  const t = text.toLowerCase();
  if (text === '完成注册' || text.includes('完成注册')) return true;
  if (t.includes('createaccount') || t.includes('signup') || t.includes('complete')) return true;
  if (t.includes('create account') || t.includes('sign up')) return true;
  return false;
}) || buttons.find((n) => n.getAttribute('type') === 'submit');
if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true') {
  return { ok: false, reason: 'no-button' };
}
const rect = target.getBoundingClientRect();
const x = rect.left + rect.width / 2;
const y = rect.top + rect.height / 2;
const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
try { target.focus(); } catch (e) {}
try { target.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) {}
try { target.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (e) {}
try { target.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) {}
try { target.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (e) {}
try { target.dispatchEvent(new MouseEvent('click', opts)); } catch (e) {
  try { target.click(); } catch (e2) {}
}
return { ok: true, text: (target.innerText || '').trim().slice(0, 40) };
"""


def simulate_submit_click(page) -> dict[str, Any]:
    """模拟真人点击「完成注册」。"""
    try:
        r = page.run_js(_SIMULATE_CLICK_JS, [])
        return r if isinstance(r, dict) else {"ok": bool(r)}
    except Exception as e:
        return {"ok": False, "reason": str(e)[:160]}


def _load_register_config() -> dict:
    import json
    import os
    from pathlib import Path

    p = Path(os.path.join(os.path.dirname(__file__), "config.json"))
    if not p.is_file():
        return {}
    try:
        conf = json.loads(p.read_text(encoding="utf-8"))
        return conf if isinstance(conf, dict) else {}
    except Exception:
        return {}


def _bool_from_conf(conf: dict, keys: tuple[str, ...], default: bool) -> bool:
    for k in keys:
        if k not in conf:
            continue
        v = conf[k]
        if isinstance(v, bool):
            return v
        return str(v).lower() in ("1", "true", "yes", "on")
    return default


def load_plan_a_enabled_from_config() -> bool:
    """config.json: register_plan_a_enabled，默认 True。"""
    return _bool_from_conf(
        _load_register_config(),
        ("register_plan_a_enabled", "register_plan_a", "registerPlanAEnabled"),
        True,
    )


def load_plan_b_enabled_from_config() -> bool:
    """config.json: register_plan_b / register_plan_b_enabled，默认 True。"""
    return _bool_from_conf(
        _load_register_config(),
        ("register_plan_b_enabled", "register_plan_b", "registerPlanBEnabled"),
        True,
    )


def load_plan_c_enabled_from_config() -> bool:
    """config.json: register_plan_c_enabled 或 register_mode=hybrid，默认 False。"""
    conf = _load_register_config()
    if any(
        k in conf
        for k in (
            "register_plan_c_enabled",
            "register_plan_c",
            "registerPlanCEnabled",
        )
    ):
        return _bool_from_conf(
            conf,
            ("register_plan_c_enabled", "register_plan_c", "registerPlanCEnabled"),
            False,
        )
    mode = str(conf.get("register_mode") or conf.get("registerMode") or "").strip().lower()
    return mode == "hybrid"
