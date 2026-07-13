# -*- coding: utf-8 -*-
import sys
import os
import io

# 强制 stdout/stderr 使用 UTF-8，解决 Windows 下 WebUI 读取乱码问题
if sys.stdout.encoding != 'utf-8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
if sys.stderr.encoding != 'utf-8':
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

from DrissionPage import Chromium, ChromiumOptions
from DrissionPage.errors import PageDisconnectedError
import argparse
import shutil
import tempfile
import datetime
import logging
import time
import secrets
import platform

from email_register import get_email_and_token, get_oai_code


def setup_run_logger() -> logging.Logger:
    log_dir = os.path.join(os.path.dirname(__file__), "logs")
    os.makedirs(log_dir, exist_ok=True)
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    # 加上 PID 避免多 worker 并发时同秒启动写到同一个日志文件
    log_path = os.path.join(log_dir, f"run_{ts}_{os.getpid()}.log")

    logger = logging.getLogger("grok_register")
    logger.setLevel(logging.INFO)
    logger.handlers.clear()

    fmt = logging.Formatter("%(asctime)s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    fh = logging.FileHandler(log_path, encoding="utf-8")
    fh.setFormatter(fmt)
    logger.addHandler(fh)
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    logger.addHandler(sh)

    logger.info("日志文件: %s", log_path)
    return logger


run_logger: logging.Logger = None



def ensure_stable_python_runtime():
    # 优先自动切到更稳定的 3.12 / 3.13，避免 3.14 下 Mail.tm 偶发 TLS/兼容问题。
    if sys.version_info < (3, 14) or os.environ.get("DPE_REEXEC_DONE") == "1":
        return

    local_app_data = os.environ.get("LOCALAPPDATA", "")
    candidates = [
        os.path.join(local_app_data, "Programs", "Python", "Python312", "python.exe"),
        os.path.join(local_app_data, "Programs", "Python", "Python313", "python.exe"),
    ]

    current_python = os.path.normcase(os.path.abspath(sys.executable))
    for candidate in candidates:
        if not os.path.isfile(candidate):
            continue
        if os.path.normcase(os.path.abspath(candidate)) == current_python:
            return

        print(f"[*] 检测到 Python {sys.version.split()[0]}，自动切换到更稳定的解释器: {candidate}")
        env = os.environ.copy()
        env["DPE_REEXEC_DONE"] = "1"
        os.execve(candidate, [candidate, os.path.abspath(__file__), *sys.argv[1:]], env)


def warn_runtime_compatibility():
    # 中文提示：避免把底层 TLS 兼容问题误判成脚本逻辑错误。
    if sys.version_info >= (3, 14):
        print("[提示] 当前 Python 为 3.14+；若出现 Mail.tm TLS 异常，建议改用 Python 3.12 或 3.13。")


ensure_stable_python_runtime()
warn_runtime_compatibility()

# 仅在 Linux 无头服务器自动启用 Xvfb 虚拟显示器
_virtual_display = None
if platform.system() == "Linux" and (not os.environ.get("DISPLAY") or os.environ.get("USE_XVFB") == "1"):
    try:
        from pyvirtualdisplay import Display
        _virtual_display = Display(visible=0, size=(1920, 1080))
        _virtual_display.start()
        print(f"[*] Xvfb 虚拟显示器已启动: {os.environ.get('DISPLAY')}")
    except Exception as e:
        print(f"[Warn] Xvfb 启动失败: {e}，将尝试直接运行")

co = ChromiumOptions()
co.auto_port()
co.set_argument("--no-sandbox")
co.set_argument("--disable-dev-shm-usage")
# 避免过度关闭 GPU/光栅化：Turnstile 会读 WebGL/canvas 指纹，硬关 GPU 反而更像机器人。
# 仅在 Linux 无显示环境保留 disable-gpu，Windows 有头模式不设置。
if platform.system() == "Linux" and (not os.environ.get("DISPLAY") or os.environ.get("USE_XVFB") == "1"):
    co.set_argument("--disable-gpu")
co.set_argument("--disable-blink-features=AutomationControlled")
co.set_argument("--lang=en-US,en")
try:
    co.set_pref("credentials_enable_service", False)
    co.set_pref("profile.password_manager_enabled", False)
except Exception:
    pass

# 从 config.json 读取代理配置给浏览器
_browser_proxy = ""
_browser_path_cfg = ""
try:
    import json as _json_mod
    _cfg_path = os.path.join(os.path.dirname(__file__), "config.json")
    if os.path.isfile(_cfg_path):
        with open(_cfg_path, "r") as _f:
            _cfg = _json_mod.load(_f)
        _browser_proxy = str(_cfg.get("browser_proxy", "") or _cfg.get("proxy", "") or "")
        _browser_path_cfg = str(_cfg.get("browser_path", "") or "")
except Exception:
    pass
if _browser_proxy:
    co.set_proxy(_browser_proxy)
    print(f"[*] 浏览器代理: {_browser_proxy}")
if _browser_path_cfg and os.path.isfile(_browser_path_cfg):
    co.set_browser_path(_browser_path_cfg)
    print(f"[*] 浏览器路径: {_browser_path_cfg}")

# Linux 服务器自动检测 chromium 路径
import platform
import shutil
import glob as _glob_mod
if platform.system() == "Linux":
    # 优先用 playwright 装的 chromium（无 AppArmor 限制）
    _pw_chromes = _glob_mod.glob(os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome"))
    if _pw_chromes:
        co.set_browser_path(_pw_chromes[0])
    else:
        for _candidate in ["/usr/bin/chromium-browser", "/usr/bin/chromium", "/usr/bin/google-chrome"]:
            if os.path.isfile(_candidate):
                co.set_browser_path(_candidate)
                break
    # user_data_path 在 start_browser() 每轮动态设置，此处不固定

co.set_timeouts(base=1)

# 加载修复 MouseEvent.screenX / screenY 的扩展。
EXTENSION_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "turnstilePatch"))
co.add_extension(EXTENSION_PATH)

_chrome_temp_dir: str = ""
browser = None
page = None

SIGNUP_URL = "https://accounts.x.ai/sign-up?redirect=grok-com"

_sso_dir = os.path.join(os.path.dirname(__file__), "sso")
_sso_ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
DEFAULT_SSO_FILE = os.path.join(_sso_dir, f"sso_{_sso_ts}_{os.getpid()}.txt")


def _apply_stealth_patches(tab=None):
    """弱化常见自动化指纹。Turnstile 失败反馈页出现时尤其需要。"""
    target = tab or page
    if target is None:
        return
    try:
        target.run_cdp(
            "Page.addScriptToEvaluateOnNewDocument",
            source=r"""
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
try {
  if (!window.chrome) window.chrome = { runtime: {} };
} catch (e) {}
try {
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
} catch (e) {}
try {
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5],
  });
} catch (e) {}
try {
  const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
  if (originalQuery) {
    window.navigator.permissions.query = (parameters) => (
      parameters && parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters)
    );
  }
} catch (e) {}
            """,
        )
    except Exception:
        pass
    try:
        target.run_js(
            """
try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
            """
        )
    except Exception:
        pass


def start_browser():
    # 每轮从全新浏览器开始，使用独立临时 profile 目录避免 Cookie/Session 复用。
    global browser, page, _chrome_temp_dir
    _chrome_temp_dir = tempfile.mkdtemp(prefix="chrome_run_")
    co.set_user_data_path(_chrome_temp_dir)
    browser = Chromium(co)
    tabs = browser.get_tabs()
    page = tabs[-1] if tabs else browser.new_tab()
    _apply_stealth_patches(page)
    return browser, page


def stop_browser():
    # 完整关闭整个浏览器实例，并清理本轮临时 profile，供下一轮重新拉起。
    global browser, page, _chrome_temp_dir
    if browser is not None:
        try:
            browser.quit()
        except Exception:
            pass
    browser = None
    page = None
    if _chrome_temp_dir and os.path.isdir(_chrome_temp_dir):
        shutil.rmtree(_chrome_temp_dir, ignore_errors=True)
    _chrome_temp_dir = ""


def restart_browser():
    # 清除 cookie/storage 代替完整重启，节省 Chrome 冷启动时间。
    global browser, page
    if browser is None:
        start_browser()
        return
    try:
        tabs = browser.get_tabs()
        page = tabs[-1] if tabs else browser.new_tab()
        page.run_js("window.localStorage.clear(); window.sessionStorage.clear();")
        page.clear_cache(session_storage=True, cookies=True)
    except Exception:
        stop_browser()
        start_browser()


def refresh_active_page():
    # 验证码确认后页面会跳转，旧 page 句柄可能断开，这里统一重新获取当前活动标签页。
    global browser, page
    if browser is None:
        start_browser()
    try:
        tabs = browser.get_tabs()
        if tabs:
            page = tabs[-1]
        else:
            page = browser.new_tab()
    except Exception:
        restart_browser()
    return page


def open_signup_page():
    # 每轮开始时打开注册页，并切到“使用邮箱注册”流程。
    global page
    refresh_active_page()
    _apply_stealth_patches(page)
    try:
        page.get(SIGNUP_URL)
    except Exception:
        refresh_active_page()
        page = browser.new_tab(SIGNUP_URL)
    _apply_stealth_patches(page)
    click_email_signup_button()


def close_current_page():
    # 兼容旧调用名，实际行为改为整轮重启浏览器。
    restart_browser()


def has_profile_form():
    # 最终注册页只要出现姓名和密码输入框，就认为已经成功进入资料填写阶段。
    refresh_active_page()
    try:
        return bool(page.run_js(
            """
const givenInput = document.querySelector('input[data-testid="givenName"], input[name="givenName"], input[autocomplete="given-name"]');
const familyInput = document.querySelector('input[data-testid="familyName"], input[name="familyName"], input[autocomplete="family-name"]');
const passwordInput = document.querySelector('input[data-testid="password"], input[name="password"], input[type="password"]');
return !!(givenInput && familyInput && passwordInput);
            """
        ))
    except Exception:
        return False


def click_email_signup_button(timeout=10):
    # 页面打开后，自动点击“使用邮箱注册”按钮。
    deadline = time.time() + timeout
    while time.time() < deadline:
        clicked = page.run_js(r"""
const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
const target = candidates.find((node) => {
    const text = (node.innerText || node.textContent || '').replace(/\s+/g, '').toLowerCase();
    return text.includes('使用邮箱注册') || text.includes('signupwithemail') || text.includes('signupemail') || text.includes('continuewith email') || text.includes('email');
});

if (!target) {
    return false;
}

target.click();
return true;
        """)

        if clicked:
            return True

        time.sleep(0.5)

    raise Exception('未找到“使用邮箱注册”按钮')


def fill_email_and_submit(timeout=15):
    # 复用 `email_register.py` 里的邮箱获取逻辑，保留邮箱与 token 供后续验证码步骤继续使用。
    email, dev_token = get_email_and_token()
    if not email or not dev_token:
        raise Exception("获取邮箱失败")

    deadline = time.time() + timeout
    while time.time() < deadline:
        filled = page.run_js(
            """
const email = arguments[0];

function isVisible(node) {
    if (!node) {
        return false;
    }
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

const input = Array.from(document.querySelectorAll('input[data-testid="email"], input[name="email"], input[type="email"], input[autocomplete="email"]')).find((node) => {
    return isVisible(node) && !node.disabled && !node.readOnly;
}) || null;

if (!input) {
    return 'not-ready';
}

input.focus();
input.click();

// 不能只写 `input.value = xxx`，否则 React / 受控表单可能没有同步内部状态。
const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
const tracker = input._valueTracker;
if (tracker) {
    tracker.setValue('');
}
if (valueSetter) {
    valueSetter.call(input, email);
} else {
    input.value = email;
}

input.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true,
    data: email,
    inputType: 'insertText',
}));
input.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    data: email,
    inputType: 'insertText',
}));
input.dispatchEvent(new Event('change', { bubbles: true }));

if ((input.value || '').trim() !== email || !input.checkValidity()) {
    return false;
}

input.blur();
return 'filled';
            """,
            email,
        )

        if filled == 'not-ready':
            time.sleep(0.5)
            continue

        if filled != 'filled':
            print(f"[Debug] 邮箱输入框已出现，但写入失败: {filled}")
            time.sleep(0.5)
            continue

        if filled == 'filled':
            time.sleep(0.8)
            clicked = page.run_js(
                r"""
function isVisible(node) {
    if (!node) {
        return false;
    }
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

const input = Array.from(document.querySelectorAll('input[data-testid="email"], input[name="email"], input[type="email"], input[autocomplete="email"]')).find((node) => {
    return isVisible(node) && !node.disabled && !node.readOnly;
}) || null;

if (!input || !input.checkValidity() || !(input.value || '').trim()) {
    return false;
}

const buttons = Array.from(document.querySelectorAll('button[type="submit"], button')).filter((node) => {
    return isVisible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
});
const submitButton = buttons.find((node) => {
    const text = (node.innerText || node.textContent || '').replace(/\s+/g, '');
    const t = text.toLowerCase(); return text === '注册' || text.includes('注册') || t === 'signup' || t === 'sign up' || t.includes('sign up');
});

if (!submitButton || submitButton.disabled) {
    return false;
}

submitButton.click();
return true;
                """
            )

            if clicked:
                print(f"[*] 已填写邮箱并点击注册: {email}")
                return email, dev_token

        time.sleep(0.5)

    raise Exception("未找到邮箱输入框或注册按钮")



def fill_code_and_submit(email, dev_token, timeout=60):
    # 复用 `email_register.py` 里的验证码轮询逻辑，等待邮件到达后自动填写 OTP。
    code = get_oai_code(dev_token, email)
    if not code:
        raise Exception("获取验证码失败")

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            filled = page.run_js(
                """
const code = String(arguments[0] || '').trim();

function isVisible(node) {
    if (!node) {
        return false;
    }
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

function setNativeValue(input, value) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    const tracker = input._valueTracker;
    if (tracker) {
        tracker.setValue('');
    }
    if (nativeInputValueSetter) {
        nativeInputValueSetter.call(input, '');
        nativeInputValueSetter.call(input, value);
    } else {
        input.value = '';
        input.value = value;
    }
}

function dispatchInputEvents(input, value) {
    input.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: value,
        inputType: 'insertText',
    }));
    input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data: value,
        inputType: 'insertText',
    }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

const input = Array.from(document.querySelectorAll('input[data-input-otp="true"], input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"], input[inputmode="text"]')).find((node) => {
    return isVisible(node) && !node.disabled && !node.readOnly && Number(node.maxLength || code.length || 6) > 1;
}) || null;

const otpBoxes = Array.from(document.querySelectorAll('input')).filter((node) => {
    if (!isVisible(node) || node.disabled || node.readOnly) {
        return false;
    }
    const maxLength = Number(node.maxLength || 0);
    const autocomplete = String(node.autocomplete || '').toLowerCase();
    return maxLength === 1 || autocomplete === 'one-time-code';
});

if (!input && otpBoxes.length < code.length) {
    return 'not-ready';
}

if (input) {
    input.focus();
    input.click();
    setNativeValue(input, code);
    dispatchInputEvents(input, code);

    const normalizedValue = String(input.value || '').trim();
    const expectedLength = Number(input.maxLength || code.length || 6);
    const slots = Array.from(document.querySelectorAll('[data-input-otp-slot="true"]'));
    const filledSlots = slots.filter((slot) => (slot.textContent || '').trim()).length;

    if (normalizedValue !== code) {
        return 'aggregate-mismatch';
    }

    if (expectedLength > 0 && normalizedValue.length !== expectedLength) {
        return 'aggregate-length-mismatch';
    }

    if (slots.length && filledSlots && filledSlots !== normalizedValue.length) {
        return 'aggregate-slot-mismatch';
    }

    input.blur();
    return 'filled';
}

const orderedBoxes = otpBoxes.slice(0, code.length);
for (let i = 0; i < orderedBoxes.length; i += 1) {
    const box = orderedBoxes[i];
    const char = code[i] || '';
    box.focus();
    box.click();
    setNativeValue(box, char);
    dispatchInputEvents(box, char);
    box.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: char }));
    box.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: char }));
    box.blur();
}

const merged = orderedBoxes.map((node) => String(node.value || '').trim()).join('');
return merged === code ? 'filled' : 'box-mismatch';
                """,
                code,
            )
        except PageDisconnectedError:
            # 点击确认邮箱后如果刚好发生跳转，旧页面句柄会断开；此时切到新页继续判断即可。
            refresh_active_page()
            if has_profile_form():
                print("[*] 验证码提交后已跳转到最终注册页。")
                return code
            time.sleep(1)
            continue

        if filled == 'not-ready':
            if has_profile_form():
                print("[*] 已直接进入最终注册页，跳过验证码按钮确认。")
                return code
            time.sleep(0.5)
            continue

        if filled != 'filled':
            print(f"[Debug] 验证码输入框已出现，但写入失败: {filled}")
            time.sleep(0.5)
            continue

        if filled == 'filled':
            time.sleep(1.2)
            try:
                clicked = page.run_js(
                    r"""
function isVisible(node) {
    if (!node) {
        return false;
    }
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

const aggregateInput = Array.from(document.querySelectorAll('input[data-input-otp="true"], input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"], input[inputmode="text"]')).find((node) => {
    return isVisible(node) && !node.disabled && !node.readOnly && Number(node.maxLength || 0) > 1;
}) || null;

let value = '';
if (aggregateInput) {
    value = String(aggregateInput.value || '').trim();
    const expectedLength = Number(aggregateInput.maxLength || value.length || 6);
    if (!value || (expectedLength > 0 && value.length !== expectedLength)) {
        return false;
    }

    const slots = Array.from(document.querySelectorAll('[data-input-otp-slot="true"]'));
    if (slots.length) {
        const filledSlots = slots.filter((slot) => (slot.textContent || '').trim()).length;
        if (filledSlots && filledSlots !== value.length) {
            return false;
        }
    }
} else {
    const otpBoxes = Array.from(document.querySelectorAll('input')).filter((node) => {
        if (!isVisible(node) || node.disabled || node.readOnly) {
            return false;
        }
        const maxLength = Number(node.maxLength || 0);
        const autocomplete = String(node.autocomplete || '').toLowerCase();
        return maxLength === 1 || autocomplete === 'one-time-code';
    });
    value = otpBoxes.map((node) => String(node.value || '').trim()).join('');
    if (!value || value.length < 6) {
        return false;
    }
}

const buttons = Array.from(document.querySelectorAll('button[type="submit"], button')).filter((node) => {
    return isVisible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
});
const confirmButton = buttons.find((node) => {
    const text = (node.innerText || node.textContent || '').replace(/\s+/g, '');
    const t = text.toLowerCase(); return text === '确认邮箱' || text.includes('确认邮箱') || text === '继续' || text.includes('继续') || text === '下一步' || text.includes('下一步') || t.includes('confirm') || t.includes('continue') || t.includes('next') || t.includes('verify');
});

if (!confirmButton) {
    return 'no-button';
}

confirmButton.focus();
confirmButton.click();
return 'clicked';
                    """
                )
            except PageDisconnectedError:
                refresh_active_page()
                if has_profile_form():
                    print("[*] 确认邮箱后页面跳转成功，已进入最终注册页。")
                    return code
                clicked = 'disconnected'

            if clicked == 'clicked':
                print(f"[*] 已填写验证码并点击确认邮箱: {code}")
                time.sleep(2)
                refresh_active_page()
                if has_profile_form():
                    print("[*] 验证码确认完成，最终注册页已就绪。")
                return code

            if clicked == 'no-button':
                current_url = page.url
                if 'sign-up' in current_url or 'signup' in current_url:
                    print(f"[*] 已填写验证码，页面已自动跳转到下一步: {current_url}")
                    return code

            if clicked == 'disconnected':
                time.sleep(1)
                continue

        time.sleep(0.5)

    debug_snapshot = page.run_js(
        r"""
function isVisible(node) {
    if (!node) {
        return false;
    }
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

const inputs = Array.from(document.querySelectorAll('input')).filter(isVisible).map((node) => ({
    type: node.type || '',
    name: node.name || '',
    testid: node.getAttribute('data-testid') || '',
    autocomplete: node.autocomplete || '',
    maxLength: Number(node.maxLength || 0),
    value: String(node.value || ''),
}));

const buttons = Array.from(document.querySelectorAll('button')).filter(isVisible).map((node) => ({
    text: String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim(),
    disabled: !!node.disabled,
    ariaDisabled: node.getAttribute('aria-disabled') || '',
}));

return { url: location.href, inputs, buttons };
        """
    )
    print(f"[Debug] 验证码页 DOM 摘要: {debug_snapshot}")
    raise Exception("未找到验证码输入框或确认邮箱按钮")


def _read_turnstile_token():
    # 优先读官方 API，再读隐藏 input（页面有时只填其中一个）。
    try:
        token = page.run_js(
            """
try {
    if (typeof turnstile !== 'undefined' && turnstile.getResponse) {
        const t = turnstile.getResponse();
        if (t) return String(t);
    }
} catch (e) {}
const input = document.querySelector('input[name="cf-turnstile-response"]');
if (input && String(input.value || '').trim()) {
    return String(input.value).trim();
}
return '';
            """
        )
        if token:
            return str(token).strip()
    except Exception:
        pass
    try:
        el = page.ele("@name=cf-turnstile-response", timeout=0.3)
        if el:
            val = (el.value or "").strip()
            if val:
                return val
    except Exception:
        pass
    return ""


def _turnstile_widget_state():
    """
    观察 Turnstile 当前状态。
    诊断日志里出现 title=Turnstile feedback report / src 含 /failure 表示已被 Cloudflare 判定失败。
    """
    try:
        return page.run_js(
            """
const input = document.querySelector('input[name="cf-turnstile-response"]');
const frames = Array.from(document.querySelectorAll('iframe')).map((n) => {
  const r = n.getBoundingClientRect();
  return {
    src: n.src || '',
    title: n.title || '',
    w: Math.round(r.width),
    h: Math.round(r.height),
    x: r.left,
    y: r.top,
  };
});
const failure = frames.some((f) =>
  /\\/failure/i.test(f.src) || /feedback report/i.test(f.title) || /failed/i.test(f.title)
);
const challenge = frames.find((f) =>
  /challenges\\.cloudflare\\.com/i.test(f.src) && !/\\/failure/i.test(f.src) && f.w >= 20 && f.h >= 20
) || frames.find((f) =>
  /turnstile|widget containing/i.test((f.src || '') + ' ' + (f.title || '')) && f.w >= 20 && f.h >= 20
) || null;
// 宿主 shadow 内的 300x65 级控件有时 src 为空，用尺寸兜底
const sized = frames.find((f) => f.w >= 240 && f.w <= 400 && f.h >= 50 && f.h <= 90) || null;
const tokenLen = input ? String(input.value || '').trim().length : 0;
return {
  failure: !!failure,
  tokenLen,
  hasInput: !!input,
  hasApi: typeof turnstile !== 'undefined',
  challenge,
  sized,
  frames: frames.map((f) => ({
    src: (f.src || '').slice(0, 140),
    title: f.title,
    w: f.w,
    h: f.h,
  })),
};
            """
        ) or {}
    except Exception as e:
        return {"failure": False, "error": str(e)}


def _iframe_box(iframe):
    """取 iframe 在页面视口中的矩形。"""
    try:
        box = iframe.run_js(
            """
const r = this.getBoundingClientRect();
return {x: r.left, y: r.top, w: r.width, h: r.height};
            """
        )
        if box and float(box.get("w") or 0) > 0:
            return box
    except Exception:
        pass
    try:
        rect = iframe.rect
        if hasattr(rect, "location") and hasattr(rect, "size"):
            return {
                "x": float(rect.location[0]),
                "y": float(rect.location[1]),
                "w": float(rect.size[0]),
                "h": float(rect.size[1]),
            }
        if hasattr(rect, "mid_x"):
            w = float(getattr(rect, "width", 300) or 300)
            h = float(getattr(rect, "height", 65) or 65)
            return {
                "x": float(rect.mid_x) - w / 2.0,
                "y": float(rect.mid_y) - h / 2.0,
                "w": w,
                "h": h,
            }
    except Exception:
        pass
    return None


def _locate_turnstile_click_target():
    """
    定位 Turnstile 复选框点击目标。
    跳过 failure feedback 大 iframe，优先找正常 challenge/widget。
    """
    last_err = ""

    # 路径 A：从 hidden input 的父级 shadow 找 iframe（原逻辑增强版）
    try:
        challenge_solution = page.ele("@name=cf-turnstile-response", timeout=0.5)
        if challenge_solution:
            wrapper = challenge_solution.parent()
            for _ in range(5):
                if wrapper is None:
                    break
                try:
                    sr = wrapper.shadow_root
                    if sr:
                        for iframe in sr.eles("tag:iframe", timeout=0.3) or []:
                            try:
                                src = (iframe.attr("src") or "") + " " + (iframe.attr("title") or "")
                            except Exception:
                                src = ""
                            if "/failure" in src or "feedback report" in src.lower():
                                continue
                            box = _iframe_box(iframe)
                            if box and float(box.get("w") or 0) >= 20 and float(box.get("h") or 0) >= 20:
                                return iframe, "input-parent-shadow"
                            if not box:
                                return iframe, "input-parent-shadow"
                except Exception as e:
                    last_err = f"pathA-shadow:{e}"
                try:
                    wrapper = wrapper.parent()
                except Exception:
                    break
    except Exception as e:
        last_err = f"pathA:{e}"

    # 路径 B：页面上 challenges.cloudflare.com 的非 failure iframe
    try:
        for iframe in page.eles("tag:iframe", timeout=0.5) or []:
            try:
                src = (iframe.attr("src") or "")
                title = (iframe.attr("title") or "")
            except Exception:
                src, title = "", ""
            blob = (src + " " + title).lower()
            if "/failure" in blob or "feedback report" in blob:
                continue
            if "challenges.cloudflare.com" in blob or "turnstile" in blob or "widget containing" in blob:
                box = _iframe_box(iframe)
                if box and float(box.get("w") or 0) < 20:
                    continue
                return iframe, "direct-iframe"
    except Exception as e:
        last_err = f"pathB:{e}"

    # 路径 C：.cf-turnstile / [data-sitekey] 容器内 iframe
    for selector in (
        "css:.cf-turnstile",
        "css:[data-sitekey]",
        "css:div[id^='cf-']",
        "xpath://div[contains(@class,'cf-turnstile')]",
    ):
        try:
            host = page.ele(selector, timeout=0.3)
            if not host:
                continue
            try:
                sr = host.shadow_root
                if sr:
                    iframe = sr.ele("tag:iframe", timeout=0.3)
                    if iframe:
                        return iframe, f"host-shadow:{selector}"
            except Exception:
                pass
            try:
                iframe = host.ele("tag:iframe", timeout=0.2)
                if iframe:
                    return iframe, f"host-iframe:{selector}"
            except Exception:
                pass
        except Exception as e:
            last_err = f"pathC:{selector}:{e}"

    # 路径 D：按尺寸兜底（约 300x65 的 widget）
    try:
        for iframe in page.eles("tag:iframe", timeout=0.5) or []:
            box = _iframe_box(iframe)
            if not box:
                continue
            w, h = float(box.get("w") or 0), float(box.get("h") or 0)
            if 240 <= w <= 400 and 50 <= h <= 90:
                return iframe, "sized-widget"
    except Exception as e:
        last_err = f"pathD:{e}"

    return None, last_err or "not-found"


def _cdp_human_click(cx, cy):
    """用 CDP 分步移动 + 按下/抬起，比 element.click() 更像真人。"""
    steps = 12 + secrets.randbelow(8)
    # 从附近随机起点移入
    sx = cx - (40 + secrets.randbelow(80))
    sy = cy - (20 + secrets.randbelow(40))
    for i in range(1, steps + 1):
        t = i / steps
        # 轻微缓动
        ease = t * t * (3 - 2 * t)
        x = sx + (cx - sx) * ease + (secrets.randbelow(3) - 1)
        y = sy + (cy - sy) * ease + (secrets.randbelow(3) - 1)
        page.run_cdp(
            "Input.dispatchMouseEvent",
            type="mouseMoved",
            x=float(x),
            y=float(y),
        )
        time.sleep(0.008 + secrets.randbelow(12) / 1000.0)
    time.sleep(0.05 + secrets.randbelow(12) / 100.0)
    page.run_cdp(
        "Input.dispatchMouseEvent",
        type="mousePressed",
        x=float(cx),
        y=float(cy),
        button="left",
        buttons=1,
        clickCount=1,
    )
    time.sleep(0.04 + secrets.randbelow(8) / 100.0)
    page.run_cdp(
        "Input.dispatchMouseEvent",
        type="mouseReleased",
        x=float(cx),
        y=float(cy),
        button="left",
        buttons=0,
        clickCount=1,
    )


def _click_turnstile_checkbox(iframe, prefer_cdp=True):
    """
    对 Turnstile 复选框点击。
    优先 CDP 坐标点击；少用 shadow element.click（易被判定自动化）。
    """
    clicked = False
    detail = []

    box = _iframe_box(iframe)
    if box:
        w = float(box.get("w") or 300)
        h = float(box.get("h") or 65)
        # checkbox 在左侧；对超大 failure 面板不要点中心
        if w > 420 or h > 200:
            detail.append(f"skip-large:{int(w)}x{int(h)}")
        else:
            cx = float(box.get("x") or 0) + max(26.0, min(42.0, w * 0.12)) + (secrets.randbelow(5) - 2)
            cy = float(box.get("y") or 0) + h * (0.45 + secrets.randbelow(10) / 100.0)

            if prefer_cdp:
                try:
                    _cdp_human_click(cx, cy)
                    clicked = True
                    detail.append(f"cdp-human:{int(cx)},{int(cy)}")
                except Exception as e:
                    detail.append(f"cdp-human:{e}")

            if not clicked:
                try:
                    page.actions.move_to((cx, cy))
                    time.sleep(0.08 + secrets.randbelow(15) / 100.0)
                    page.actions.click()
                    clicked = True
                    detail.append(f"actions:{int(cx)},{int(cy)}")
                except Exception as e:
                    detail.append(f"actions:{e}")

    # 兜底：shadow 内 input（可能触发 automation 指纹，放最后）
    if not clicked:
        try:
            body = iframe.ele("tag:body", timeout=0.6)
            if body is not None:
                sr = None
                try:
                    sr = body.shadow_root
                except Exception:
                    sr = None
                btn = None
                if sr:
                    btn = (
                        sr.ele("tag:input", timeout=0.3)
                        or sr.ele("css:input[type=checkbox]", timeout=0.2)
                        or sr.ele("css:[role=checkbox]", timeout=0.2)
                    )
                if btn is None:
                    btn = body.ele("tag:input", timeout=0.2)
                if btn is not None:
                    try:
                        btn.click(by_js=False)
                    except Exception:
                        btn.click()
                    clicked = True
                    detail.append("shadow-input")
        except Exception as e:
            detail.append(f"shadow:{e}")

    if not clicked:
        try:
            iframe.click()
            clicked = True
            detail.append("iframe-click")
        except Exception as e:
            detail.append(f"iframe-click:{e}")

    return clicked, ",".join(detail)


def _soft_reset_turnstile():
    try:
        page.run_js(
            """
try { if (typeof turnstile !== 'undefined') turnstile.reset(); } catch (e) {}
// 部分站点 widget 需要移除后重渲染；这里只 reset，避免破坏 React 树
return true;
            """
        )
        return True
    except Exception:
        return False


def getTurnstileToken(timeout=65):
    """
    求解最终注册页 Turnstile。
    根据实测诊断：连点会导致 /failure feedback report。
    策略改为：长等自动通过 -> 最多 3 次 CDP 真人点击且间隔长 -> 检测到 failure 则 soft reset 一次。
    """
    refresh_active_page()
    _apply_stealth_patches(page)
    deadline = time.time() + timeout
    last_diag = ""
    click_attempts = 0
    reset_count = 0
    max_clicks = 3

    # 先给 managed / invisible 模式最长 20 秒自动通过
    auto_wait_secs = min(20, max(0, timeout - 8))
    auto_wait_until = time.time() + auto_wait_secs
    while time.time() < auto_wait_until:
        token = _read_turnstile_token()
        if token:
            print("[*] Turnstile 已自动通过（无需点击）。")
            return token
        state = _turnstile_widget_state()
        if state.get("failure"):
            print("[Warn] 自动等待阶段检测到 Turnstile failure 反馈页。")
            break
        time.sleep(0.5)

    while time.time() < deadline:
        token = _read_turnstile_token()
        if token:
            print("[*] Turnstile token 已获取。")
            return token

        state = _turnstile_widget_state()
        if state.get("failure"):
            last_diag = f"failure-state frames={state.get('frames')}"
            if reset_count < 1 and time.time() + 12 < deadline:
                print("[*] 检测到 Turnstile failure，执行 soft reset 并重新等待。")
                _soft_reset_turnstile()
                reset_count += 1
                # reset 后先再等自动通过，不要立刻连点
                wait_end = time.time() + min(12, deadline - time.time())
                while time.time() < wait_end:
                    token = _read_turnstile_token()
                    if token:
                        print("[*] Turnstile soft reset 后已自动通过。")
                        return token
                    if _turnstile_widget_state().get("failure"):
                        break
                    time.sleep(0.5)
                continue
            print("[Debug] Turnstile 已被 Cloudflare 判定 failure（IP/指纹/环境），停止无效连点。")
            break

        if click_attempts >= max_clicks:
            last_diag = f"max-clicks:{click_attempts}"
            if reset_count < 1 and time.time() + 10 < deadline:
                print("[*] 已达最大点击次数，尝试 soft reset。")
                _soft_reset_turnstile()
                reset_count += 1
                click_attempts = 0
                time.sleep(2)
                continue
            break

        iframe, how = _locate_turnstile_click_target()
        if iframe is None:
            last_diag = f"locate-fail:{how} state={state}"
            # widget 可能仍在渲染
            time.sleep(1.0)
            continue

        if click_attempts == 0:
            print(f"[*] 已定位 Turnstile 控件 ({how})，开始 CDP 真人化点击（最多 {max_clicks} 次）。")

        # 点击前轻微随机停顿，模拟阅读
        time.sleep(0.4 + secrets.randbelow(60) / 100.0)
        clicked, detail = _click_turnstile_checkbox(iframe, prefer_cdp=True)
        click_attempts += 1
        last_diag = f"click#{click_attempts} via={how} detail={detail} ok={clicked}"
        print(f"[*] Turnstile 点击尝试 #{click_attempts}: {detail}")

        # 点击后给足时间出 token / 或进入 failure，不要马上再点
        wait_slice = min(10.0, max(3.0, deadline - time.time()))
        wait_end = time.time() + wait_slice
        while time.time() < wait_end:
            token = _read_turnstile_token()
            if token:
                print(f"[*] Turnstile 点击后已出 token（第 {click_attempts} 次尝试）。")
                return token
            st = _turnstile_widget_state()
            if st.get("failure"):
                print("[Warn] 点击后进入 Turnstile failure 状态。")
                last_diag = f"post-click-failure #{click_attempts}"
                break
            time.sleep(0.4)

        time.sleep(0.6 + secrets.randbelow(50) / 100.0)

    # 最终诊断
    try:
        diag = _turnstile_widget_state()
        print(f"[Debug] Turnstile 失败诊断: {diag} | last={last_diag}")
        if diag.get("failure"):
            raise Exception(
                "failed to solve turnstile: Cloudflare 返回 failure 反馈页"
                "（多为 IP 信誉/浏览器指纹问题，而非单纯点不中）"
            )
    except Exception as e:
        if "failed to solve turnstile" in str(e):
            raise
        print(f"[Debug] Turnstile 失败诊断不可用: {e} | last={last_diag}")

    raise Exception("failed to solve turnstile")


_GIVEN_NAMES = [
    "Aaron", "Adam", "Adrian", "Alan", "Albert", "Alex", "Alice", "Allen",
    "Amy", "Andrew", "Angela", "Anna", "Anthony", "Ashley", "Austin", "Bella",
    "Benjamin", "Bradley", "Brandon", "Brian", "Caleb", "Cameron", "Carl",
    "Carol", "Charles", "Chloe", "Chris", "Claire", "Cody", "Connor", "Daniel",
    "David", "Dean", "Dennis", "Derek", "Diana", "Donald", "Doris", "Douglas",
    "Dylan", "Edward", "Elaine", "Eli", "Elijah", "Ella", "Emily", "Eric",
    "Ethan", "Eva", "Evan", "Felix", "Frank", "Gabriel", "Gary", "George",
    "Grace", "Grant", "Gregory", "Hannah", "Harold", "Harry", "Henry", "Ian",
    "Isaac", "Ivan", "Jack", "Jacob", "James", "Jane", "Jason", "Jay",
    "Jeffrey", "Jennifer", "Jeremy", "Jessica", "John", "Jonathan", "Jordan",
    "Joseph", "Joshua", "Julia", "Justin", "Karen", "Kate", "Keith", "Kelly",
    "Kenneth", "Kevin", "Kyle", "Larry", "Laura", "Lauren", "Leah", "Lee",
    "Leo", "Linda", "Logan", "Louis", "Lucas", "Lucy", "Luke", "Mark",
    "Martin", "Mary", "Mason", "Matthew", "Megan", "Melissa", "Michael",
    "Mike", "Nancy", "Nathan", "Neo", "Nicholas", "Noah", "Olivia", "Oscar",
    "Owen", "Patrick", "Paul", "Peter", "Philip", "Rachel", "Ralph", "Randy",
    "Ray", "Rebecca", "Richard", "Robert", "Roger", "Ronald", "Rose", "Russell",
    "Ryan", "Samantha", "Samuel", "Sandra", "Sarah", "Scott", "Sean", "Sharon",
    "Shawn", "Sophia", "Stanley", "Stephen", "Steven", "Susan", "Thomas",
    "Tim", "Travis", "Tyler", "Victor", "Victoria", "Vincent", "Walter",
    "Wayne", "William", "Wyatt", "Zachary", "Zoey",
]

_FAMILY_NAMES = [
    "Adams", "Allen", "Anderson", "Bailey", "Baker", "Barnes", "Bell",
    "Bennett", "Brooks", "Brown", "Bryant", "Butler", "Campbell", "Carter",
    "Chen", "Clark", "Coleman", "Collins", "Cook", "Cooper", "Cox", "Cruz",
    "Davis", "Diaz", "Edwards", "Evans", "Fisher", "Flores", "Foster",
    "Garcia", "Gomez", "Gonzalez", "Gray", "Green", "Hall", "Harris",
    "Hayes", "Henderson", "Hernandez", "Hill", "Holmes", "Howard", "Hughes",
    "Hunter", "Jackson", "James", "Jenkins", "Johnson", "Jones", "Kelly",
    "Khan", "Kim", "King", "Lee", "Lewis", "Lin", "Long", "Lopez", "Martin",
    "Martinez", "Miller", "Mitchell", "Moore", "Morales", "Morgan", "Morris",
    "Murphy", "Murray", "Nelson", "Nguyen", "Owens", "Parker", "Patel",
    "Perez", "Peterson", "Phillips", "Powell", "Price", "Ramirez", "Reed",
    "Reyes", "Richardson", "Rivera", "Roberts", "Robinson", "Rodriguez",
    "Rogers", "Ross", "Russell", "Sanchez", "Sanders", "Scott", "Simmons",
    "Smith", "Stewart", "Sullivan", "Taylor", "Thomas", "Thompson", "Torres",
    "Turner", "Walker", "Wang", "Ward", "Watson", "White", "Williams",
    "Wilson", "Wood", "Wright", "Young", "Zhang", "Zhou",
]


def build_profile():
    # 生成一组可重复使用的注册资料，姓名从英文常见姓名表里随机抽取，
    # 密码至少包含大小写、数字和特殊字符。
    given_name = secrets.choice(_GIVEN_NAMES)
    family_name = secrets.choice(_FAMILY_NAMES)
    password = "N" + secrets.token_hex(4) + "!a7#" + secrets.token_urlsafe(6)
    return given_name, family_name, password


def fill_profile_and_submit(timeout=110):
    # 在验证码通过后，直接锁定“可见且可写”的真实输入框，避免命中隐藏节点或 React 受控副本。
    # timeout 需覆盖 Turnstile 自动通过 20s + 点击重试 + 表单填写。

    given_name, family_name, password = build_profile()
    deadline = time.time() + timeout
    turnstile_token = ""
    turnstile_attempted = False

    while time.time() < deadline:
        filled = page.run_js(
            """
const givenName = arguments[0];
const familyName = arguments[1];
const password = arguments[2];

function isVisible(node) {
    if (!node) {
        return false;
    }
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

function pickInput(selector) {
    return Array.from(document.querySelectorAll(selector)).find((node) => {
        return isVisible(node) && !node.disabled && !node.readOnly;
    }) || null;
}

function setInputValue(input, value) {
    if (!input) {
        return false;
    }
    input.focus();
    input.click();

    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    const tracker = input._valueTracker;
    if (tracker) {
        tracker.setValue('');
    }

    if (nativeSetter) {
        nativeSetter.call(input, '');
        nativeSetter.call(input, value);
    } else {
        input.value = '';
        input.value = value;
    }

    input.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: value,
        inputType: 'insertText',
    }));
    input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data: value,
        inputType: 'insertText',
    }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));

    return String(input.value || '') === String(value || '');
}

const givenInput = pickInput('input[data-testid="givenName"], input[name="givenName"], input[autocomplete="given-name"]');
const familyInput = pickInput('input[data-testid="familyName"], input[name="familyName"], input[autocomplete="family-name"]');
const passwordInput = pickInput('input[data-testid="password"], input[name="password"], input[type="password"]');

if (!givenInput || !familyInput || !passwordInput) {
    return 'not-ready';
}

const givenOk = setInputValue(givenInput, givenName);
const familyOk = setInputValue(familyInput, familyName);
const passwordOk = setInputValue(passwordInput, password);

if (!givenOk || !familyOk || !passwordOk) {
    return 'filled-failed';
}

return [
    String(givenInput.value || '').trim() === String(givenName || '').trim(),
    String(familyInput.value || '').trim() === String(familyName || '').trim(),
    String(passwordInput.value || '') === String(password || ''),
].every(Boolean) ? 'filled' : 'verify-failed';
            """,
            given_name,
            family_name,
            password,
        )

        if filled == 'not-ready':
            time.sleep(0.5)
            continue

        if filled != 'filled':
            print(f"[Debug] 最终注册页输入框已出现，但姓名/密码写入失败: {filled}")
            time.sleep(0.5)
            continue

        values_ok = page.run_js(
            """
const expectedGiven = arguments[0];
const expectedFamily = arguments[1];
const expectedPassword = arguments[2];

function isVisible(node) {
    if (!node) {
        return false;
    }
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

function pickInput(selector) {
    return Array.from(document.querySelectorAll(selector)).find((node) => {
        return isVisible(node) && !node.disabled && !node.readOnly;
    }) || null;
}

const givenInput = pickInput('input[data-testid="givenName"], input[name="givenName"], input[autocomplete="given-name"]');
const familyInput = pickInput('input[data-testid="familyName"], input[name="familyName"], input[autocomplete="family-name"]');
const passwordInput = pickInput('input[data-testid="password"], input[name="password"], input[type="password"]');

if (!givenInput || !familyInput || !passwordInput) {
    return false;
}

return String(givenInput.value || '').trim() === String(expectedGiven || '').trim()
    && String(familyInput.value || '').trim() === String(expectedFamily || '').trim()
    && String(passwordInput.value || '') === String(expectedPassword || '');
            """,
            given_name,
            family_name,
            password,
        )
        if not values_ok:
            print("[Debug] 最终注册页字段值校验失败，继续重试填写。")
            time.sleep(0.5)
            continue

        turnstile_state = page.run_js(
            """
const challengeInput = document.querySelector('input[name="cf-turnstile-response"]');
if (!challengeInput) {
    return 'not-found';
}
const value = String(challengeInput.value || '').trim();
return value ? 'ready' : 'pending';
            """
        )

        if turnstile_state == "pending" and not turnstile_token:
            if turnstile_attempted:
                # 上一轮已求解过但 token 丢失，再给一次机会；否则避免死循环烧满 timeout
                remain = max(8, deadline - time.time() - 5)
            else:
                # 需覆盖约 20s 自动通过 + 后续点击，至少预留 65s
                remain = max(65, min(90, deadline - time.time() - 5))
            print("[*] 检测到最终注册页存在 Turnstile，开始使用真人化点击逻辑。")
            turnstile_attempted = True
            turnstile_token = getTurnstileToken(timeout=remain)
            if turnstile_token:
                synced = page.run_js(
                    """
const token = arguments[0];
const challengeInput = document.querySelector('input[name="cf-turnstile-response"]');
if (!challengeInput) {
    return false;
}
const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
if (nativeSetter) {
    nativeSetter.call(challengeInput, token);
} else {
    challengeInput.value = token;
}
challengeInput.dispatchEvent(new Event('input', { bubbles: true }));
challengeInput.dispatchEvent(new Event('change', { bubbles: true }));
return String(challengeInput.value || '').trim() === String(token || '').trim();
                    """,
                    turnstile_token,
                )
                if synced:
                    print("[*] Turnstile 响应已同步到最终注册表单。")

        time.sleep(1.2)

        try:
            submit_button = page.ele('tag:button@@text()=完成注册') or page.ele('tag:button@@text():Create Account') or page.ele('tag:button@@text():Sign up')
        except Exception:
            submit_button = None

        if not submit_button:
            clicked = page.run_js(
                r"""
const challengeInput = document.querySelector('input[name="cf-turnstile-response"]');
if (challengeInput && !String(challengeInput.value || '').trim()) {
    return false;
}
const buttons = Array.from(document.querySelectorAll('button[type="submit"], button'));
const submitButton = buttons.find((node) => {
    const text = (node.innerText || node.textContent || '').replace(/\s+/g, '');
    const t = text.toLowerCase(); return text === '完成注册' || text.includes('完成注册') || t.includes('create account') || t.includes('sign up') || t.includes('complete');
});
if (!submitButton || submitButton.disabled || submitButton.getAttribute('aria-disabled') === 'true') {
    return false;
}
submitButton.focus();
submitButton.click();
return true;
                """
            )
        else:
            challenge_value = page.run_js(
                """
const challengeInput = document.querySelector('input[name="cf-turnstile-response"]');
return challengeInput ? String(challengeInput.value || '').trim() : 'not-found';
                """
            )
            if challenge_value not in ('not-found', ''):
                submit_button.click()
                clicked = True
            else:
                clicked = False

        if clicked:
            print(f"[*] 已填写注册资料并点击完成注册: {given_name} {family_name} / {password}")
            return {
                "given_name": given_name,
                "family_name": family_name,
                "password": password,
            }

        time.sleep(0.5)

    raise Exception("未找到最终注册表单或完成注册按钮")


def extract_visible_numbers(timeout=60):
    # 登录/注册完成后，提取页面上可见的普通数字文本，不处理任何敏感 Cookie。
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = page.run_js(
            r"""
function isVisible(el) {
    if (!el) {
        return false;
    }
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

const selector = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'div', 'span', 'p', 'strong', 'b', 'small',
    '[data-testid]', '[class]', '[role="heading"]'
].join(',');

const seen = new Set();
const matches = [];
for (const node of document.querySelectorAll(selector)) {
    if (!isVisible(node)) {
        continue;
    }
    const text = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) {
        continue;
    }
    const found = text.match(/\d+(?:\.\d+)?/g);
    if (!found) {
        continue;
    }
    for (const value of found) {
        const key = `${value}@@${text}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        matches.push({ value, text });
    }
}

return matches.slice(0, 30);
            """
        )

        if result:
            print("[*] 页面可见数字文本提取结果:")
            for item in result:
                try:
                    print(f"    - 数字: {item['value']} | 上下文: {item['text']}")
                except Exception:
                    pass
            return result

        time.sleep(1)

    raise Exception("登录后未提取到可见数字文本")


def wait_for_sso_cookie(timeout=30, prefer_domain: str = "grok.com"):
    # 必须在注册完成后再取 sso，优先抓取 grok.com 域上的 sso 值。
    # 历史背景：accounts.x.ai 域和 grok.com 域上都会出现一个名为 "sso" 的 cookie；
    # grok2api 真正要用的是 grok.com 那一份（和 chat 接口同域），如果错拿了
    # accounts.x.ai 那一份，下游调用会被风控秒拒。
    deadline = time.time() + timeout
    last_seen_names = set()
    fallback_value = ""  # 拿不到 prefer_domain 上的，再退回任意域的 sso

    def _scan_cookies(cookie_iter):
        nonlocal fallback_value
        for item in cookie_iter:
            if isinstance(item, dict):
                name = str(item.get("name", "")).strip()
                value = str(item.get("value", "")).strip()
                domain = str(item.get("domain", "")).strip().lstrip(".")
            else:
                name = str(getattr(item, "name", "")).strip()
                value = str(getattr(item, "value", "")).strip()
                domain = str(getattr(item, "domain", "")).strip().lstrip(".")
            if name:
                last_seen_names.add(f"{name}@{domain}" if domain else name)
            if name == "sso" and value:
                if prefer_domain and prefer_domain in domain:
                    return ("preferred", domain, value)
                if not fallback_value:
                    fallback_value = value
        return None

    while time.time() < deadline:
        try:
            # 不依赖单一 page 句柄——warm-up 期间 grok.com 里的 turnstile/广告 iframe
            # 可能让 page 飘到不相关的标签页（比如 NID@google.com）。所以我们扫所有标签页：
            # 优先在显式访问 grok.com 的标签页里找 sso；找不到再退回当前 page。
            grok_tab = None
            try:
                if browser is not None:
                    for tab in browser.get_tabs():
                        try:
                            url = (tab.url or "")
                        except Exception:
                            url = ""
                        if "grok.com" in url:
                            grok_tab = tab
                            break
            except Exception:
                grok_tab = None

            target = grok_tab or page
            if target is None:
                time.sleep(1)
                continue

            cookies = target.cookies(all_domains=True, all_info=True) or []
            hit = _scan_cookies(cookies)
            if hit:
                _, domain, value = hit
                print(f"[*] 已获取到 {domain} 域的 sso cookie。")
                return value

        except PageDisconnectedError:
            refresh_active_page()
        except Exception:
            pass

        time.sleep(1)

    if fallback_value:
        print(f"[Warn] 未拿到 {prefer_domain} 域的 sso，退回到非首选域的 sso（可能仍能用）。")
        return fallback_value

    raise Exception(f"注册完成后未获取到 sso cookie，当前已见 cookie: {sorted(last_seen_names)}")


def wait_for_grok_com_landing(timeout: int = 90) -> bool:
    # 注册流（accounts.x.ai/sign-up?redirect=grok-com）完成后，浏览器会经过一段
    # SSO 重定向链，最终落到 grok.com 并把会话 cookie 写到 grok.com 域上。
    # grok.com 是独立域，跟 .x.ai 不共享 cookie。
    # 之前的版本在重定向链跑完之前就已经在 wait_for_sso_cookie 拿到 accounts.x.ai 的
    # sso 抢跑返回，warm-up 接着用硬跳 (page.get) 去 grok.com，结果落在未登录状态。
    # 这里显式等到 URL 真正变成 grok.com 且页面进入登录态再返回。
    global page
    deadline = time.time() + timeout
    last_url = ""
    while time.time() < deadline:
        try:
            refresh_active_page()
            current_url = page.url or ""
            if current_url != last_url:
                print(f"[*] 等待重定向到 grok.com，当前: {current_url}")
                last_url = current_url

            if "grok.com" in current_url:
                logged_in = bool(page.run_js(r"""
function isVisible(n) {
    if (!n) return false;
    const s = window.getComputedStyle(n);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
}
// 已进入 chat 路径 = 必然已登录
if (/grok\.com\/(chat|c)\//.test(location.href)) return true;
// 输入框出现 = 已登录
const ta = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).find(n => isVisible(n) && !n.disabled && !n.readOnly);
if (ta) return true;
return false;
"""))
                if logged_in:
                    print(f"[*] 已落到 grok.com 并登录: {current_url}")
                    return True
        except PageDisconnectedError:
            refresh_active_page()
        except Exception:
            pass
        time.sleep(1)

    print(f"[Warn] 等待 grok.com 登录超时，最后 URL: {last_url}")
    return False


def append_sso_to_txt(sso_value, output_path=DEFAULT_SSO_FILE):
    # 按用户要求，一行写一个 sso 值，持续追加。
    normalized = str(sso_value or "").strip()
    if not normalized:
        raise Exception("待写入的 sso 为空")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "a", encoding="utf-8") as file:
        file.write(normalized + "\n")

    print(f"[*] 已追加写入 sso 到文件: {output_path}")


def push_sso_to_api(new_tokens: list):
    # 推送 SSO token 到 grok2api 管理接口（chenyme/grok2api v2 协议）。
    # POST <endpoint>/admin/api/tokens/add  body {"pool": ..., "tokens": [...]}
    # 后端自带去重，重复的会进 skipped 计数；不需要先 GET 再合并。
    import json
    import urllib3
    import requests
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    config_path = os.path.join(os.path.dirname(__file__), "config.json")
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            conf = json.load(f)
    except Exception as e:
        print(f"[Warn] 读取 config.json 失败，跳过推送: {e}")
        return

    api_conf = conf.get("api", {})
    endpoint = str(api_conf.get("endpoint", "")).strip().rstrip("/")
    api_token = str(api_conf.get("token", "")).strip()
    pool = str(api_conf.get("pool", "basic")).strip() or "basic"

    if not endpoint or not api_token:
        return

    tokens_to_push = [t for t in new_tokens if t]
    if not tokens_to_push:
        return

    url = f"{endpoint}/admin/api/tokens/add"
    headers = {
        "Authorization": f"Bearer {api_token}",
        "Content-Type": "application/json",
    }

    try:
        resp = requests.post(
            url,
            json={"pool": pool, "tokens": tokens_to_push},
            headers=headers,
            timeout=60,
            verify=False,
        )
        if resp.status_code == 200:
            data = resp.json() if resp.text else {}
            count = data.get("count", len(tokens_to_push))
            skipped = data.get("skipped", 0)
            print(f"[*] SSO token 已推送到号池（pool={pool}, 新增={count}, 跳过={skipped}): {url}")
        else:
            print(f"[Warn] 推送 API 返回异常: HTTP {resp.status_code} {resp.text[:200]}")
    except Exception as e:
        print(f"[Warn] 推送 API 失败: {e}")


def run_single_registration(output_path=DEFAULT_SSO_FILE, extract_numbers=False):
    # 单轮流程：打开注册页 -> 完成注册 -> 获取 sso -> 写 txt。
    open_signup_page()
    email, dev_token = fill_email_and_submit()
    fill_code_and_submit(email, dev_token)
    profile = fill_profile_and_submit()
    # 注册完成后等浏览器跑完 SSO 重定向链落到 grok.com 并登录——grok.com 域的
    # 会话 cookie（含 cf_clearance / sso / sso-rw）此时才会真正写下来。
    if not wait_for_grok_com_landing():
        print("[Warn] 未能落到 grok.com 登录态，sso 质量可能受影响")
    sso_value = wait_for_sso_cookie()
    append_sso_to_txt(sso_value, output_path)

    if extract_numbers:
        extract_visible_numbers()

    result = {
        "email": email,
        "sso": sso_value,
        **profile,
    }

    if run_logger:
        run_logger.info(
            "注册成功 | email=%s | password=%s | given=%s | family=%s",
            email,
            profile.get("password", ""),
            profile.get("given_name", ""),
            profile.get("family_name", ""),
        )

    print(f"[*] 本轮注册完成，邮箱: {email}")
    return result


def load_run_count() -> int:
    # 从 config.json 读取默认执行轮数，配置不存在时返回 10。
    config_path = os.path.join(os.path.dirname(__file__), "config.json")
    try:
        import json
        with open(config_path, "r", encoding="utf-8") as f:
            conf = json.load(f)
        v = conf.get("run", {}).get("count")
        if isinstance(v, int) and v >= 0:
            return v
    except Exception:
        pass
    return 10


def main():
    global run_logger
    run_logger = setup_run_logger()

    config_count = load_run_count()

    parser = argparse.ArgumentParser(description="Grok 自动注册机")
    parser.add_argument("--count", type=int, default=config_count, help=f"执行轮数，0 表示无限循环（默认 {config_count}）")
    parser.add_argument("--output", default=DEFAULT_SSO_FILE, help="sso 输出 txt 路径")
    parser.add_argument("--extract-numbers", action="store_true", help="注册完成后额外提取页面数字文本")
    args = parser.parse_args()

    total = args.count if args.count > 0 else '∞'
    print(f"")
    print(f"══════════════════════════════════════")
    print(f"  Grok 注册机启动")
    print(f"  计划轮数: {total}")
    print(f"  SSO 输出: {args.output}")
    print(f"══════════════════════════════════════")

    current_round = 0
    success_count = 0
    fail_count = 0
    collected_sso: list = []
    try:
        start_browser()
        while True:
            if args.count > 0 and current_round >= args.count:
                break

            current_round += 1
            print(f"")
            print(f"─── 第 {current_round}/{total} 轮 ────────────────────────")

            try:
                result = run_single_registration(args.output, extract_numbers=args.extract_numbers)
                collected_sso.append(result["sso"])
                success_count += 1
                print(f"✔ 第 {current_round} 轮成功 | {result['email']}")
            except KeyboardInterrupt:
                print(f"")
                print(f"[Info] 收到中断信号，停止后续轮次。")
                break
            except Exception as error:
                fail_count += 1
                print(f"✘ 第 {current_round} 轮失败 | {error}")
            finally:
                restart_browser()

            if args.count == 0 or current_round < args.count:
                time.sleep(0.5)

    finally:
        stop_browser()
        print(f"")
        print(f"══════════════════════════════════════")
        print(f"  注册机运行结束")
        print(f"  成功: {success_count}  失败: {fail_count}  共计: {current_round}")
        if collected_sso:
            print(f"  SSO 已保存到: {args.output}")
        print(f"══════════════════════════════════════")


if __name__ == "__main__":
    main()
