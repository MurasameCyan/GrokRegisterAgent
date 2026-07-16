# -*- coding: utf-8 -*-
import sys
import os
import io

# 强制 stdout/stderr 使用 UTF-8，解决 Windows 下 WebUI 读取乱码问题
if sys.stdout.encoding != 'utf-8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace', line_buffering=True)
if sys.stderr.encoding != 'utf-8':
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace', line_buffering=True)

# 管道接到 Node WebUI 时避免块缓冲吞掉早期诊断日志
os.environ.setdefault("PYTHONUNBUFFERED", "1")
try:
    sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
    sys.stderr.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
except Exception:
    pass

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
    # 不挂 StreamHandler：WebUI 已捕获 stdout；再挂会导致每条日志打印两遍。
    # 控制台可见输出统一走 print(..., flush=True) / _emit。

    logger.info("日志文件: %s", log_path)
    print(f"日志文件: {log_path}", flush=True)
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

# ------------------------------------------------------------
# Linux 无 GUI 服务器：强制 Xvfb 有头模式（不要用 Chrome headless）
# Turnstile 在 headless / 无 WebGL 环境下几乎必出 failure 反馈页。
# ------------------------------------------------------------
import shutil
import glob as _glob_mod

_virtual_display = None
_IS_LINUX = platform.system() == "Linux"
_WINDOW_W, _WINDOW_H = 1920, 1080


def _display_is_usable(display: str) -> bool:
    """粗检 DISPLAY 是否可用（Xvfb/真实 X 是否在听）。"""
    if not display:
        return False
    # 允许 :99 或 localhost:99.0
    name = display.split("/")[-1]
    if name.startswith(":"):
        try:
            num = int(name[1:].split(".")[0])
        except Exception:
            return False
        sock = f"/tmp/.X11-unix/X{num}"
        return os.path.exists(sock)
    return True


def _ensure_virtual_display():
    """
    无 GUI Linux：确保有可用 DISPLAY。
    - 已有可用 DISPLAY（如 docker entrypoint 起的 Xvfb）则复用
    - 否则用 pyvirtualdisplay / 直接 Xvfb 拉起
    """
    global _virtual_display
    if not _IS_LINUX:
        return

    force_xvfb = os.environ.get("USE_XVFB", "").strip() in ("1", "true", "yes")
    current = (os.environ.get("DISPLAY") or "").strip()
    if current and _display_is_usable(current) and not force_xvfb:
        print(f"[*] 复用已有 DISPLAY={current}（无 GUI 服务器 / Xvfb）")
        return

    # 已设置但不可用：清掉后重建
    if current and not _display_is_usable(current):
        print(f"[Warn] DISPLAY={current} 不可用，将重新启动 Xvfb")
        os.environ.pop("DISPLAY", None)

    try:
        from pyvirtualdisplay import Display
        _virtual_display = Display(visible=0, size=(_WINDOW_W, _WINDOW_H), color_depth=24)
        _virtual_display.start()
        print(f"[*] Xvfb 虚拟显示器已启动: DISPLAY={os.environ.get('DISPLAY')} size={_WINDOW_W}x{_WINDOW_H}")
        return
    except Exception as e:
        print(f"[Warn] pyvirtualdisplay 启动失败: {e}")

    # 兜底：系统 Xvfb 命令
    try:
        import subprocess
        disp = os.environ.get("XVFB_DISPLAY", ":99")
        # 若占用则换号
        for n in range(99, 120):
            cand = f":{n}"
            if not _display_is_usable(cand):
                disp = cand
                break
        log_path = "/tmp/grok_xvfb.log"
        subprocess.Popen(
            ["Xvfb", disp, "-screen", "0", f"{_WINDOW_W}x{_WINDOW_H}x24", "-ac", "+extension", "GLX", "+render", "-noreset"],
            stdout=open(log_path, "a", encoding="utf-8"),
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        time.sleep(0.6)
        os.environ["DISPLAY"] = disp
        if _display_is_usable(disp):
            print(f"[*] 系统 Xvfb 已启动: DISPLAY={disp}（日志 {log_path}）")
        else:
            print(f"[Warn] Xvfb 已拉起但 socket 未就绪: DISPLAY={disp}")
    except Exception as e:
        print(f"[Warn] Xvfb 启动失败: {e}。无 DISPLAY 时 Chrome 可能无法过 Turnstile。")


_ensure_virtual_display()

# 从 config.json 读取代理 / 浏览器路径；代理支持池轮换（每轮 start_browser 再取）
_browser_proxy = ""
_browser_path_cfg = ""
_resolved_browser_path = ""
_current_fingerprint = None
_auto_auth_export = True
_proxy_prefer_local_forward = False
try:
    import json as _json_mod
    _cfg_path = os.path.join(os.path.dirname(__file__), "config.json")
    if os.path.isfile(_cfg_path):
        with open(_cfg_path, "r") as _f:
            _cfg = _json_mod.load(_f)
        _browser_proxy = str(_cfg.get("browser_proxy", "") or _cfg.get("proxy", "") or "")
        _browser_path_cfg = str(_cfg.get("browser_path", "") or "")
        _auto_auth_export = bool(_cfg.get("auto_auth_export", True))
        # 默认 True：带密码代理走本地转发，避免 set_proxy 静默直连
        _proxy_prefer_local_forward = bool(
            _cfg.get("proxy_prefer_local_forward", True)
        )
except Exception:
    pass

try:
    from pools import (
        next_proxy,
        reload_pools,
        peek_status,
        acquire_proxy_for_register,
        proxy_identity_key,
    )
except Exception:
    def next_proxy(fallback: str = "") -> str:
        return fallback

    def reload_pools(force: bool = False) -> None:
        return None

    def peek_status() -> dict:
        return {}

    def acquire_proxy_for_register(fallback: str = "", *, log=print):
        return (fallback or "").strip(), 0.0

    def proxy_identity_key(proxy_url: str) -> str:
        return (proxy_url or "").strip()

try:
    from proxy_auth_ext import apply_proxy_to_chromium_options, parse_proxy_url
except Exception as _proxy_auth_import_err:
    apply_proxy_to_chromium_options = None
    parse_proxy_url = None
    print(f"[Warn] proxy_auth_ext 导入失败（带密码代理将无法生效）: {_proxy_auth_import_err}")

try:
    from proxy_local_forward import stop_local_forward as _stop_local_forward_early
except Exception:
    _stop_local_forward_early = None

# 启动自检：新代码是否在容器内
_REGISTER_BUILD = "plan-a+b-2026-07-14"
print(f"[*] register build: {_REGISTER_BUILD}")
if apply_proxy_to_chromium_options is None:
    print("[Warn] 缺少 proxy_auth_ext —— 请确认 ./register 已挂载并重启容器")
else:
    print("[*] proxy_auth_ext: OK（支持带密码 HTTP 代理：扩展/本地转发）")

try:
    from fingerprint import (
        build_fingerprint,
        apply_to_chromium_options,
        stealth_js,
        human_pause,
    )
except Exception:
    build_fingerprint = None
    apply_to_chromium_options = None
    stealth_js = None
    human_pause = None

try:
    from auth_service import sso_to_cpa_auth, default_auth_dir
except Exception:
    sso_to_cpa_auth = None
    default_auth_dir = None

# 解析浏览器路径（只做一次）
if _browser_path_cfg and os.path.isfile(_browser_path_cfg):
    _resolved_browser_path = _browser_path_cfg
    print(f"[*] 浏览器路径: {_browser_path_cfg}")
elif _IS_LINUX:
    _linux_candidates = [
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/opt/google/chrome/chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
    ]
    _pw_chromes = sorted(
        _glob_mod.glob(os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome")),
        reverse=True,
    )
    for _candidate in _linux_candidates + _pw_chromes:
        if _candidate and os.path.isfile(_candidate) and os.access(_candidate, os.X_OK):
            _resolved_browser_path = _candidate
            break
    if _resolved_browser_path:
        print(f"[*] Linux 浏览器: {_resolved_browser_path}")
    else:
        print("[Warn] 未找到 chrome/chromium，将使用 DrissionPage 默认路径")

EXTENSION_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "turnstilePatch"))
if os.path.isdir(EXTENSION_PATH):
    print(f"[*] 已加载 Turnstile 扩展: {EXTENSION_PATH}")
else:
    print(f"[Warn] Turnstile 扩展目录不存在: {EXTENSION_PATH}")


def _new_chromium_options() -> ChromiumOptions:
    """每轮新建 ChromiumOptions，避免代理扩展/指纹在全局 co 上累积。"""
    opts = ChromiumOptions()
    opts.auto_port()
    try:
        opts.headless(False)
    except Exception:
        pass
    opts.set_argument("--no-sandbox")
    opts.set_argument("--disable-dev-shm-usage")
    opts.set_argument(f"--window-size={_WINDOW_W},{_WINDOW_H}")
    opts.set_argument("--window-position=0,0")
    opts.set_argument("--disable-blink-features=AutomationControlled")
    opts.set_argument("--lang=en-US,en")
    opts.set_argument("--accept-lang=en-US,en")
    if _IS_LINUX:
        opts.set_argument("--disable-gpu-compositing")
        opts.set_argument("--use-gl=angle")
        opts.set_argument("--use-angle=swiftshader-webgl")
        opts.set_argument("--enable-webgl")
        opts.set_argument("--ignore-gpu-blocklist")
        opts.set_argument("--enable-features=NetworkService,NetworkServiceInProcess")
        opts.set_argument("--mute-audio")
        opts.set_argument("--disable-background-networking")
        opts.set_argument("--no-first-run")
        opts.set_argument("--no-default-browser-check")
    try:
        opts.set_pref("credentials_enable_service", False)
        opts.set_pref("profile.password_manager_enabled", False)
    except Exception:
        pass
    try:
        opts.set_timeouts(base=1)
    except Exception:
        pass
    if _resolved_browser_path and os.path.isfile(_resolved_browser_path):
        opts.set_browser_path(_resolved_browser_path)
    if os.path.isdir(EXTENSION_PATH):
        opts.add_extension(EXTENSION_PATH)
    return opts


# 兼容旧代码中对全局 co 的引用（探测版本等）
co = _new_chromium_options()

_MACHINE = platform.machine() or ""
_ARCH_NOTE = ""
if _MACHINE.lower() in ("aarch64", "arm64", "armv8l", "armv7l"):
    _ARCH_NOTE = "（ARM：Turnstile 指纹/WebGL 通过率通常低于 x86_64）"
elif _MACHINE.lower() in ("x86_64", "amd64"):
    _ARCH_NOTE = "（x86_64）"

print(
    f"[*] 运行环境: system={platform.system()} machine={_MACHINE}{_ARCH_NOTE} "
    f"python={platform.python_version()} DISPLAY={os.environ.get('DISPLAY', '')!r} "
    f"window={_WINDOW_W}x{_WINDOW_H} headless=False",
    flush=True,
)

_chrome_temp_dir: str = ""
browser = None
page = None
# 指纹探测是否已输出（必须模块级初始化，否则 NameError）
_fingerprint_logged = False

SIGNUP_URL = "https://accounts.x.ai/sign-up?redirect=grok-com"

_sso_dir = os.path.join(os.path.dirname(__file__), "sso")
_sso_ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
DEFAULT_SSO_FILE = os.path.join(_sso_dir, f"sso_{_sso_ts}_{os.getpid()}.txt")


def _apply_stealth_patches(tab=None):
    """弱化常见自动化指纹（有限规避；无法抹掉已签发 bot_flag_source=1）。

    优先注入本轮 fingerprint.stealth_js；再叠基础 webdriver/chrome 补丁。
    """
    target = tab or page
    if target is None:
        return
    # 本轮随机特征：新文档 + 当前页双注入
    fp_src = None
    try:
        if _current_fingerprint is not None and stealth_js is not None:
            fp_src = stealth_js(_current_fingerprint)
    except Exception:
        fp_src = None
    base_src = r"""
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
try {
  if (!window.chrome) window.chrome = { runtime: {}, loadTimes: function(){}, csi: function(){}, app: {} };
  else if (!window.chrome.runtime) window.chrome.runtime = {};
} catch (e) {}
try {
  const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
  if (originalQuery) {
    window.navigator.permissions.query = (parameters) => (
      parameters && parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery.call(window.navigator.permissions, parameters)
    );
  }
} catch (e) {}
"""
    for src in (base_src, fp_src):
        if not src:
            continue
        try:
            target.run_cdp("Page.addScriptToEvaluateOnNewDocument", source=src)
        except Exception:
            pass
        try:
            target.run_js(src)
        except Exception:
            pass


def _resolve_browser_binary_path() -> str:
    """解析当前/常见 Chromium 可执行路径。"""
    path = ""
    try:
        path = str(getattr(co, "browser_path", "") or "")
    except Exception:
        path = ""
    if not path:
        for attr in ("_browser_path", "browser_path"):
            try:
                path = str(getattr(co, attr, "") or "")
            except Exception:
                continue
            if path:
                break
    if path and os.path.isfile(path):
        return path
    for cand in (
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ):
        if os.path.isfile(cand):
            return cand
    return ""


def _real_chrome_major() -> int | None:
    """
    读取本机 Chromium 大版本号，供 UA 对齐（避免 150 二进制 + 137 UA）。
    失败返回 None，由 build_fingerprint 走默认版本表。
    """
    path = _resolve_browser_binary_path()
    ver_text = ""
    if path:
        try:
            import subprocess

            out = subprocess.check_output(
                [path, "--version"], stderr=subprocess.STDOUT, timeout=8
            )
            ver_text = out.decode("utf-8", "replace").strip()
        except Exception:
            ver_text = ""
    if not ver_text:
        # 兜底：环境变量（Docker 可注入）
        ver_text = str(os.environ.get("CHROME_VERSION") or os.environ.get("CHROMIUM_VERSION") or "")
    # 例: "Chromium 150.0.7871.114 built on Debian..." / "Google Chrome 150.0.7339.127"
    import re

    m = re.search(r"(?:Chromium|Chrome)[\s/]+(\d{2,3})\.", ver_text, re.I)
    if not m:
        m = re.search(r"\b(\d{2,3})\.\d+\.\d+", ver_text)
    if not m:
        return None
    try:
        major = int(m.group(1))
    except Exception:
        return None
    if 80 <= major <= 200:
        return major
    return None


def _probe_browser_version() -> str:
    """读取已配置/正在使用的 chrome 路径版本号。"""
    path = _resolve_browser_binary_path()
    if not path:
        return "unknown"
    try:
        import subprocess
        out = subprocess.check_output([path, "--version"], stderr=subprocess.STDOUT, timeout=8)
        return f"{path} | {out.decode('utf-8', 'replace').strip()}"
    except Exception as e:
        return f"{path} | version-fail:{e}"


def _probe_webgl_and_ua(tab) -> dict:
    """在浏览器内探测 UA / 平台 / WebGL，用于判断 ARM 无 GUI 指纹是否残缺。"""
    try:
        return tab.run_js(
            r"""
const nav = {
  userAgent: navigator.userAgent || '',
  platform: navigator.platform || '',
  webdriver: navigator.webdriver,
  languages: navigator.languages || [],
  hardwareConcurrency: navigator.hardwareConcurrency || 0,
  deviceMemory: navigator.deviceMemory || null,
  maxTouchPoints: navigator.maxTouchPoints || 0,
};
let webgl = { ok: false };
try {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  if (!gl) {
    webgl = { ok: false, error: 'no-webgl-context' };
  } else {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    webgl = {
      ok: true,
      vendor: gl.getParameter(gl.VENDOR) || '',
      renderer: gl.getParameter(gl.RENDERER) || '',
      unmaskedVendor: dbg ? (gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '') : '',
      unmaskedRenderer: dbg ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '',
      version: gl.getParameter(gl.VERSION) || '',
    };
  }
} catch (e) {
  webgl = { ok: false, error: String(e) };
}
return {
  nav,
  webgl,
  screen: {
    width: screen.width,
    height: screen.height,
    availWidth: screen.availWidth,
    availHeight: screen.availHeight,
    colorDepth: screen.colorDepth,
    devicePixelRatio: window.devicePixelRatio || 1,
  },
  displayEnv: '',
};
            """
        ) or {}
    except Exception as e:
        return {"error": str(e)}


def _emit(msg: str) -> None:
    """同时打到 stdout（WebUI）和 run_logger（文件），并立刻 flush。"""
    print(msg, flush=True)
    try:
        sys.stdout.flush()
    except Exception:
        pass
    if run_logger is not None:
        try:
            run_logger.info("%s", msg)
        except Exception:
            pass


def log_runtime_fingerprint(tab=None, force: bool = False):
    """
    打印架构 / 浏览器版本 / WebGL 探测，方便确认 ARM 无 GUI 环境是否可用。
    默认每个进程只详打一次，避免每轮刷屏。
    """
    global _fingerprint_logged
    # 防御：热更新/旧进程合并时变量可能缺失
    try:
        already = _fingerprint_logged
    except NameError:
        already = False
        globals()["_fingerprint_logged"] = False
    if already and not force:
        return
    target = tab or page
    machine = platform.machine() or "?"
    arch_hint = ""
    if machine.lower() in ("aarch64", "arm64", "armv8l", "armv7l"):
        arch_hint = "ARM 风险：Turnstile 更容易给 failure，优先考虑 x86_64 worker"
    elif machine.lower() in ("x86_64", "amd64"):
        arch_hint = "x86_64 相对更友好"
    _emit(f"[*] 指纹探测 machine={machine} | {arch_hint}")
    _emit(f"[*] 浏览器版本: {_probe_browser_version()}")
    _emit(
        f"[*] DISPLAY={os.environ.get('DISPLAY', '')!r} "
        f"XDG_SESSION_TYPE={os.environ.get('XDG_SESSION_TYPE', '')!r} "
        f"WAYLAND_DISPLAY={os.environ.get('WAYLAND_DISPLAY', '')!r}"
    )
    if target is None:
        _emit("[Warn] 浏览器未就绪，跳过 WebGL/UA 探测")
        return
    info = _probe_webgl_and_ua(target)
    if info.get("error"):
        _emit(f"[Warn] WebGL/UA 探测失败: {info['error']}")
        _fingerprint_logged = True
        return
    nav = info.get("nav") or {}
    webgl = info.get("webgl") or {}
    scr = info.get("screen") or {}
    _emit(f"[*] UA: {nav.get('userAgent', '')}")
    _emit(
        f"[*] platform={nav.get('platform')!r} webdriver={nav.get('webdriver')!r} "
        f"hw={nav.get('hardwareConcurrency')} mem={nav.get('deviceMemory')} "
        f"langs={nav.get('languages')}"
    )
    _emit(
        f"[*] screen={scr.get('width')}x{scr.get('height')} "
        f"avail={scr.get('availWidth')}x{scr.get('availHeight')} "
        f"depth={scr.get('colorDepth')} dpr={scr.get('devicePixelRatio')}"
    )
    if webgl.get("ok"):
        _emit(
            f"[*] WebGL OK vendor={webgl.get('vendor')!r} renderer={webgl.get('renderer')!r}"
        )
        _emit(
            f"[*] WebGL unmasked vendor={webgl.get('unmaskedVendor')!r} "
            f"renderer={webgl.get('unmaskedRenderer')!r} version={webgl.get('version')!r}"
        )
        renderer_l = str(webgl.get("unmaskedRenderer") or webgl.get("renderer") or "").lower()
        if any(x in renderer_l for x in ("swiftshader", "llvmpipe", "softpipe", "software")):
            _emit("[Warn] WebGL 为软件渲染（SwiftShader/llvmpipe）——无独显服务器常见，Turnstile 分可能偏低")
        if machine.lower() in ("aarch64", "arm64") and "swiftshader" in renderer_l:
            _emit("[Warn] ARM + 软件 WebGL：建议换 x86_64 跑注册机，或使用住宅代理降低 failure")
    else:
        _emit(f"[Warn] WebGL 不可用: {webgl} —— Turnstile 极易 failure，请检查 Xvfb/Chromium/GL 库")
    _fingerprint_logged = True


def _start_browser_once():
    """单次拉起浏览器 + 应用一个代理（不再做出口 IP 探测）。

    返回 dict: browser, page, exit_ip_ok, exit_ip_err, proxy, used_proxy
    （exit_ip_* 固定为成功/空，兼容旧调用方）
    """
    # 每轮从全新浏览器开始，使用独立临时 profile 目录避免 Cookie/Session 复用。
    # 注意：带 user:pass 的代理必须用扩展注入，co.set_proxy 会静默忽略（DrissionPage 限制）。
    global browser, page, _chrome_temp_dir, _current_fingerprint, _browser_proxy, co
    if _IS_LINUX:
        _ensure_virtual_display()

    # 每轮新 ChromiumOptions，避免认证扩展/指纹在全局对象上累积
    co = _new_chromium_options()
    proxy_apply_result = None

    # 代理池：每轮取一个（先创建 profile 目录，auth 扩展写在其下）
    _chrome_temp_dir = tempfile.mkdtemp(prefix="chrome_run_")
    try:
        reload_pools(force=True)
    except Exception:
        pass
    try:
        st = peek_status() if callable(peek_status) else {}
        pool_n = len(st.get("proxies") or []) if isinstance(st, dict) else 0
        if pool_n:
            print(
                f"[*] 代理池: {pool_n} 条 mode={st.get('proxy_mode') or '?'} "
                f"next_idx={st.get('proxy_idx', '?')}"
            )
        else:
            # 池空：打印 config 关键键，便于排查「UI 有代理却直连」
            try:
                import json as _jdbg
                _cp = os.path.join(os.path.dirname(__file__), "config.json")
                if os.path.isfile(_cp):
                    with open(_cp, "r", encoding="utf-8") as _fdbg:
                        _cd = _jdbg.load(_fdbg)
                    _pp = _cd.get("proxy_pool") or _cd.get("proxies")
                    _n = len(_pp) if isinstance(_pp, list) else (1 if _pp else 0)
                    print(
                        f"[Warn] 代理池为空 | config.proxy_pool条目={_n} "
                        f"proxy={bool(str(_cd.get('proxy') or '').strip())} "
                        f"browser_proxy={bool(str(_cd.get('browser_proxy') or '').strip())} "
                        f"proxyEnabled未写入Python(仅看proxy_pool/proxy字段)"
                    )
                else:
                    print("[Warn] 代理池为空且无 config.json")
            except Exception as _e:
                print(f"[Warn] 代理池为空（读 config 失败: {_e}）")
    except Exception:
        pass

    proxy_apply_result = None
    try:
        # 池优先；池空则 acquire 返回 fallback（browser_proxy/proxy）
        # 同一 IP 未到使用间隔时会 sleep 等待（暂停队列）
        picked, waited_ip = acquire_proxy_for_register(_browser_proxy, log=print)
        picked = (picked or "").strip()
        if waited_ip and waited_ip > 0.05:
            print(f"[*] IP 间隔累计等待 {waited_ip:.1f}s 后继续")
        if picked:
            _browser_proxy = picked
            # 脱敏日志
            log_proxy = picked
            try:
                if parse_proxy_url:
                    p = parse_proxy_url(picked)
                    if p and p.get("has_auth"):
                        log_proxy = (
                            f"{p['scheme']}://{p['username'][:8]}…:***@{p['host']}:{p['port']}"
                        )
            except Exception:
                pass
            try:
                ik = proxy_identity_key(picked) if callable(proxy_identity_key) else ""
                if ik:
                    print(f"[*] 本轮代理 IP 键: {ik}")
            except Exception:
                pass
            # CF 独立代理：探测本地端口是否在听，避免「pid 在跑但端口未就绪」
            try:
                from pools import is_cf_proxy_mode, is_local_loopback_proxy

                if is_cf_proxy_mode() or is_local_loopback_proxy(picked):
                    import socket as _sock

                    _host, _port = "127.0.0.1", 30000
                    try:
                        if parse_proxy_url:
                            _pp = parse_proxy_url(picked)
                            if _pp:
                                _host = str(_pp.get("host") or "127.0.0.1")
                                _port = int(_pp.get("port") or 30000)
                    except Exception:
                        pass
                    _ok = False
                    try:
                        with _sock.create_connection((_host, _port), timeout=1.5):
                            _ok = True
                    except Exception as _pe:
                        print(
                            f"[Warn] CF/本机代理端口不可达 {_host}:{_port}: {_pe} "
                            f"（请确认 cfwp 运行中，且 client_ip=:{_port}）",
                            flush=True,
                        )
                    if _ok:
                        print(
                            f"[*] CF/本机代理端口就绪 {_host}:{_port} · {log_proxy}",
                            flush=True,
                        )
            except Exception:
                pass

            if apply_proxy_to_chromium_options is not None:
                # 热读 prefer local forward
                prefer_local = _proxy_prefer_local_forward
                try:
                    import json as _jm
                    _cp = os.path.join(os.path.dirname(__file__), "config.json")
                    if os.path.isfile(_cp):
                        with open(_cp, "r", encoding="utf-8") as _cf:
                            prefer_local = bool(
                                _jm.load(_cf).get("proxy_prefer_local_forward", prefer_local)
                            )
                except Exception:
                    pass
                proxy_apply_result = apply_proxy_to_chromium_options(
                    co,
                    picked,
                    work_dir=_chrome_temp_dir,
                    prefer_local_forward=prefer_local,
                )
                mode = proxy_apply_result.get("mode")
                if mode == "auth_extension":
                    print(
                        f"[proxy] 浏览器代理(本轮/认证扩展): "
                        f"{proxy_apply_result.get('proxy') or log_proxy}",
                        flush=True,
                    )
                elif mode == "local_forward":
                    print(
                        f"[proxy] 浏览器代理(本轮/本地转发): "
                        f"{proxy_apply_result.get('local_proxy')} "
                        f"→ {proxy_apply_result.get('proxy') or log_proxy}",
                        flush=True,
                    )
                elif mode in ("set_proxy", "arg"):
                    print(
                        f"[proxy] 浏览器代理(本轮/{mode}): "
                        f"{proxy_apply_result.get('proxy') or log_proxy}",
                        flush=True,
                    )
                elif mode == "error":
                    # 已启用代理却无法注入 → 禁止静默直连（否则看起来「没连上代理」）
                    err = proxy_apply_result.get("error")
                    print(
                        f"[proxy][!] 代理配置失败，本轮中止（不直连）: {err} | raw={log_proxy}",
                        flush=True,
                    )
                    raise RuntimeError(f"proxy apply failed: {err}")
                else:
                    print(f"[proxy] 浏览器代理(本轮): {log_proxy}", flush=True)
            else:
                # 无 proxy_auth_ext：绝不能 set_proxy(user:pass)，会静默直连
                try:
                    from proxy_local_forward import start_local_forward

                    fr = start_local_forward(picked)
                    if fr.get("ok"):
                        try:
                            co.set_proxy(fr["local_proxy"])
                        except Exception:
                            co.set_argument("--proxy-server", fr["local_proxy"])
                        print(
                            f"[proxy] 浏览器代理(本轮/本地转发-noext): "
                            f"{fr.get('local_proxy')} → {log_proxy}",
                            flush=True,
                        )
                        proxy_apply_result = {
                            "mode": "local_forward",
                            "local_proxy": fr.get("local_proxy"),
                            "proxy": log_proxy,
                        }
                    else:
                        print(
                            f"[proxy][!] 无 proxy_auth_ext 且本地转发失败，本轮中止（不直连）: "
                            f"{fr.get('error')}",
                            flush=True,
                        )
                        raise RuntimeError(
                            f"proxy local forward failed: {fr.get('error')}"
                        )
                except RuntimeError:
                    raise
                except Exception as e:
                    print(
                        f"[proxy][!] 带密码代理无法配置（缺模块）: {e} — "
                        f"请同步 register/ 并重启容器",
                        flush=True,
                    )
                    raise RuntimeError(f"proxy module missing: {e}") from e
        else:
            # picked 为空：若总开关开着，说明池/单条都没配上
            try:
                import json as _j_pe
                _cfg_pe = {}
                try:
                    with open(
                        os.path.join(os.path.dirname(__file__), "config.json"),
                        "r",
                        encoding="utf-8",
                    ) as _fp:
                        _cfg_pe = _j_pe.load(_fp) or {}
                except Exception:
                    _cfg_pe = {}
                def _on(v, default=False):
                    if isinstance(v, bool):
                        return v
                    if v is None:
                        return default
                    s = str(v).strip().lower()
                    return s in ("1", "true", "yes", "on", "enabled") if s else default
                _cf_on = _on(_cfg_pe.get("cf_proxy_enabled"), False)
                _pe_on = _cf_on or _on(_cfg_pe.get("proxy_enabled"), False)
                if _pe_on and not _cf_on:
                    print(
                        "[proxy][!] 已启用代理但 acquire 未拿到节点 → 本轮中止（不直连）",
                        flush=True,
                    )
                    raise RuntimeError("proxy enabled but no proxy acquired")
            except RuntimeError:
                raise
            except Exception:
                pass
            print("[proxy] 浏览器代理: 直接连接（proxy_enabled=false 或无节点）", flush=True)
    except RuntimeError:
        raise
    except Exception as e:
        print(f"[proxy][!] 代理池选取失败: {e}", flush=True)
        try:
            import json as _j_pe2
            _cfg_pe2 = {}
            try:
                with open(
                    os.path.join(os.path.dirname(__file__), "config.json"),
                    "r",
                    encoding="utf-8",
                ) as _fp2:
                    _cfg_pe2 = _j_pe2.load(_fp2) or {}
            except Exception:
                _cfg_pe2 = {}
            def _on2(v, default=False):
                if isinstance(v, bool):
                    return v
                if v is None:
                    return default
                s = str(v).strip().lower()
                return s in ("1", "true", "yes", "on", "enabled") if s else default
            _pe_on2 = _on2(_cfg_pe2.get("cf_proxy_enabled"), False) or _on2(
                _cfg_pe2.get("proxy_enabled"), False
            )
            if _pe_on2:
                raise RuntimeError(f"proxy acquire failed: {e}") from e
        except RuntimeError:
            raise
        except Exception:
            pass

    # 随机注册特征（UA 大版本对齐真实 Chromium，降低 Turnstile 版本错配）
    if build_fingerprint is not None:
        try:
            major = _real_chrome_major()
            _current_fingerprint = build_fingerprint(chrome_major=major)
            if apply_to_chromium_options is not None:
                apply_to_chromium_options(co, _current_fingerprint)
            ua_note = f" chrome_major={major}" if major else ""
            print(
                f"[*] 本轮特征: ua={_current_fingerprint.user_agent[:60]}… "
                f"tz={_current_fingerprint.timezone} "
                f"size={_current_fingerprint.window_w}x{_current_fingerprint.window_h}"
                f"{ua_note}"
            )
        except Exception as e:
            print(f"[Warn] 指纹生成失败: {e}")
            _current_fingerprint = None

    co.set_user_data_path(_chrome_temp_dir)
    browser = Chromium(co)
    tabs = browser.get_tabs()
    page = tabs[-1] if tabs else browser.new_tab()
    win_w = getattr(_current_fingerprint, "window_w", None) or _WINDOW_W
    win_h = getattr(_current_fingerprint, "window_h", None) or _WINDOW_H
    try:
        page.set.window.size(win_w, win_h)
    except Exception:
        try:
            page.run_cdp("Browser.setWindowBounds", windowId=1, bounds={
                "left": 0, "top": 0, "width": win_w, "height": win_h, "windowState": "normal"
            })
        except Exception:
            pass
    _apply_stealth_patches(page)
    # 叠加本轮随机特征 JS
    if _current_fingerprint is not None and stealth_js is not None:
        try:
            page.run_js(stealth_js(_current_fingerprint))
        except Exception:
            pass

    # 已移除出口 IP 探测（api.ipify / CF trace 等），启动后直接进入注册流程
    # 进程内首次启动时打印架构/版本/WebGL，确认 ARM 无 GUI 环境
    log_runtime_fingerprint(page, force=False)
    return {
        "browser": browser,
        "page": page,
        "exit_ip_ok": True,
        "exit_ip_err": "",
        "proxy": _browser_proxy or "",
        "used_proxy": bool(str(_browser_proxy or "").strip()),
    }


def _format_proxy_for_log(proxy: str) -> str:
    """日志用：脱敏 user:pass，保留 scheme/host:port。"""
    p = str(proxy or "").strip()
    if not p:
        return "(直连)"
    try:
        if parse_proxy_url:
            info = parse_proxy_url(p)
            if info and info.get("has_auth"):
                u = str(info.get("username") or "")[:8]
                return (
                    f"{info.get('scheme') or 'http'}://{u}…:***"
                    f"@{info.get('host')}:{info.get('port')}"
                )
            if info:
                return (
                    f"{info.get('scheme') or 'http'}://"
                    f"{info.get('host')}:{info.get('port')}"
                )
    except Exception:
        pass
    # 兜底脱敏
    if "@" in p and "://" in p:
        try:
            scheme, rest = p.split("://", 1)
            cred, host = rest.rsplit("@", 1)
            user = cred.split(":")[0][:8]
            return f"{scheme}://{user}…:***@{host}"
        except Exception:
            pass
    return p[:96]


def start_browser(*, max_proxy_tries: int | None = None):
    """拉起浏览器（已取消出口 IP 检测与因此触发的换代理重试）。

    仅打印当前使用的代理信息，不做出口探测。
    max_proxy_tries 保留兼容旧调用，忽略。
    代理已启用却注入失败时抛 RuntimeError（禁止静默直连）。
    """
    _ = max_proxy_tries
    info = _start_browser_once()
    if isinstance(info, tuple):
        return info
    used = str(info.get("proxy") or _browser_proxy or "").strip()
    if info.get("used_proxy") and used:
        print(f"[proxy] 当前使用代理: {_format_proxy_for_log(used)}", flush=True)
    else:
        print("[proxy] 当前使用代理: (直连)", flush=True)
    return info["browser"], info["page"]


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
    # 停掉本轮本地代理转发（若有）
    try:
        from proxy_local_forward import stop_local_forward

        stop_local_forward()
    except Exception:
        pass
    if _chrome_temp_dir and os.path.isdir(_chrome_temp_dir):
        shutil.rmtree(_chrome_temp_dir, ignore_errors=True)
    _chrome_temp_dir = ""


def restart_browser():
    # 整机重启以切换代理与随机特征（池轮换依赖新 Chromium 进程）。
    # 注意：main 循环改为「先 start 再打第 N 轮标题」，优先用 stop+start 由 main 编排。
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


# 注册页「使用邮箱注册」：失败时优先降级代理并换下一条，连通后再继续
_EMAIL_SIGNUP_FIND_TRIES = 5


def open_signup_page(*, find_tries: int | None = None):
    """打开注册页并点击「使用邮箱注册」。

    对齐 GrokRegisterAgent4 主流程：刷新/重开找按钮，中途不狂 demote。
    硬失败（chrome-error / This site can't be reached）：立即降级代理并缩短重试。
    注意：page.url 可能仍显示 accounts.x.ai，但文档实为 chrome-error 页——以 body/diag 为准。
    """
    global page, _browser_proxy
    # W2 · 若上一轮已捕获 CF，在打开注册前再写一次（clear 后可能被导航冲掉）
    try:
        from cf_context import restore_cloudflare_context, get_thread_cf_context

        if page is not None and get_thread_cf_context() and get_thread_cf_context().ready:
            restore_cloudflare_context(page, log=lambda m: print(m, flush=True))
    except Exception:
        pass
    tries = int(find_tries if find_tries is not None else _EMAIL_SIGNUP_FIND_TRIES)
    tries = max(1, min(tries, 10))
    last_err: Exception | str | None = None
    demoted_this_open: set[str] = set()
    hard_fail_streak = 0

    def _is_signup_host(url: str) -> bool:
        u = (url or "").lower()
        if _is_chrome_error_url(u):
            return False
        return any(
            h in u
            for h in (
                "accounts.x.ai",
                "x.ai/sign",
                "grok.x.ai",
                "auth.x.ai",
            )
        )

    def _is_chrome_error_url(url: str) -> bool:
        u = (url or "").lower()
        return (
            u.startswith("chrome-error://")
            or u.startswith("chrome://")
            or "chromewebdata" in u
            or u in ("", "about:blank", "about:newtab")
        )

    def _proxy_err_text(blob: str) -> bool:
        """仅识别真网络/代理故障；勿匹配业务中文里的「代理/隧道」。"""
        raw = blob or ""
        b = raw.lower()
        # 保留 chrome-error / can't be reached 等硬信号；去掉我们自己注入的文案以免二次匹配干扰
        hard = (
            "err_proxy",
            "err_tunnel",
            "err_socks",
            "err_connection_reset",
            "err_connection_closed",
            "err_connection_refused",
            "err_connection_timed_out",
            "err_timed_out",
            "err_name_not_resolved",
            "err_address_unreachable",
            "err_ssl_protocol_error",
            "err_ssl_version",
            "err_empty_response",
            "err_internet_disconnected",
            "chrome-error://",
            "chromewebdata",
            "this site can't be reached",
            "this site can’t be reached",
            "took too long to respond",
            "connection timed out",
            "connection refused",
            "proxy connection failed",
            "tunnel connection failed",
            "err_proxy_connection_failed",
            "err_tunnel_connection_failed",
            "注册页无法访问",
            "代理/隧道错误",
        )
        if any(k in b for k in hard):
            return True
        if "无法访问此网站" in raw or "网页无法打开" in raw:
            return True
        return False

    def _page_is_dead(title: str, url: str, body_hint: str = "") -> bool:
        """当前标签是否像错误页。

        page.url 常仍是目标 URL，但 href/body 是 chrome-error——必须查 body_hint。
        """
        if _is_chrome_error_url(url):
            return True
        if _proxy_err_text(f"{title}\n{url}\n{body_hint}"):
            return True
        return False

    def _demote_and_rotate(reason: str) -> bool:
        global _browser_proxy
        cur = str(_browser_proxy or "").strip()
        if not cur:
            return False
        try:
            from pools import (
                demote_proxy_to_pending,
                is_singbox_proxy_mode,
                next_proxy,
                should_skip_proxy_demote,
            )

            # sing-box：Node 换出站节点，本地 127.0.0.1:2080 不变，须重启浏览器
            if is_singbox_proxy_mode():
                demote_proxy_to_pending(cur, reason=reason[:160])
                try:
                    restart_browser()
                except Exception as re:
                    print(f"[Warn] restart_browser 失败: {re}", flush=True)
                return True

            # CF 独立 / 本机环回：固定单节点，禁止当池剔除，仅重启浏览器重试
            if should_skip_proxy_demote(cur):
                if cur not in demoted_this_open:
                    demoted_this_open.add(cur)
                    print(
                        f"[*] CF/本机代理保持不变（不降级）: {cur[:72]}… · {reason[:100]}",
                        flush=True,
                    )
                try:
                    restart_browser()
                except Exception as re:
                    print(f"[Warn] restart_browser 失败: {re}", flush=True)
                return True

            if cur not in demoted_this_open:
                demote_proxy_to_pending(cur, reason=reason[:160])
                demoted_this_open.add(cur)
            nxt = next_proxy()
            if nxt and nxt != cur:
                _browser_proxy = nxt
                print(f"[*] 代理已降级并切换: `{nxt}` · {reason[:80]}", flush=True)
                try:
                    restart_browser()
                except Exception as re:
                    print(f"[Warn] restart_browser 失败: {re}", flush=True)
                return True
            print(f"[Warn] 代理已降级但无更多可用节点: {reason[:100]}", flush=True)
            try:
                restart_browser()
            except Exception:
                pass
            return False
        except Exception as de:
            print(f"[Warn] 代理降级/切换失败: {de}", flush=True)
            return False

    for attempt in range(1, tries + 1):
        try:
            refresh_active_page()
            _apply_stealth_patches(page)
            try:
                page.get(SIGNUP_URL)
            except Exception as ge:
                last_err = ge
                # 仅真 net 错误才 demote（对齐 Agent4：开页失败多数只重开标签）
                if _browser_proxy and _proxy_err_text(str(ge)):
                    hard_fail_streak += 1
                    _demote_and_rotate(f"开页失败: {str(ge)[:80]}")
                    time.sleep(0.4 + secrets.randbelow(30) / 100.0)
                    continue
                try:
                    refresh_active_page()
                    page = browser.new_tab(SIGNUP_URL)
                except Exception as ge2:
                    last_err = ge2
                    if _browser_proxy and _proxy_err_text(str(ge2)):
                        hard_fail_streak += 1
                        _demote_and_rotate(f"开页失败: {str(ge2)[:80]}")
                        time.sleep(0.4 + secrets.randbelow(30) / 100.0)
                        continue

            _apply_stealth_patches(page)
            # SPA 首屏：x.ai 注册页常 2～4s 才出 Sign up with email
            time.sleep(2.0 + secrets.randbelow(120) / 100.0)

            title = ""
            url = ""
            body_hint = ""
            try:
                title = str(getattr(page, "title", None) or "")
                url = str(getattr(page, "url", None) or "")
            except Exception:
                pass
            # page.url 可能仍是 accounts.x.ai；从文档读真实 href/正文
            try:
                snap = page.run_js(
                    """
return JSON.stringify({
  href: (location && location.href) || '',
  doc: (document.documentURI || document.URL || ''),
  title: document.title || '',
  body: ((document.body && document.body.innerText) || '').slice(0, 220)
});
                    """
                )
                if isinstance(snap, str) and snap.startswith("{"):
                    import json as _json

                    d = _json.loads(snap)
                    real_href = str(d.get("href") or d.get("doc") or "")
                    body_hint = str(d.get("body") or "")
                    if real_href:
                        # 优先 chrome-error 真实地址
                        if _is_chrome_error_url(real_href) or not url:
                            url = real_href
                    if d.get("title") and not title:
                        title = str(d.get("title") or "")
            except Exception:
                pass

            # 硬错误页（含 url 仍显示 accounts.x.ai 但 body 为 can't be reached）→ demote
            if _browser_proxy and _page_is_dead(title, url, body_hint):
                hard_fail_streak += 1
                _demote_and_rotate(
                    f"注册页不可达(attempt {attempt}): "
                    f"{(title or url or body_hint)[:100]}"
                )
                # 连续硬失败：不必 5 次空刷同一坏代理
                if hard_fail_streak >= 2 and attempt >= 2:
                    last_err = Exception(
                        f"连续硬失败({hard_fail_streak})·代理不可达: "
                        f"{(url or title or body_hint)[:120]}"
                    )
                    break
                time.sleep(0.5 + secrets.randbelow(40) / 100.0)
                continue

            try:
                # 已在目标域且非错误页：给更长找按钮时间（Cloudflare/SPA）
                live_signup = _is_signup_host(url) and not _page_is_dead(
                    title, url, body_hint
                )
                btn_timeout = 22 if live_signup else (14 if attempt == 1 else 12)
                click_email_signup_button(timeout=btn_timeout)
                if attempt > 1:
                    print(f"[*] 「使用邮箱注册」第 {attempt}/{tries} 次找到并点击", flush=True)
                return
            except Exception as e:
                last_err = e
                err_s = str(e)
                print(
                    f"[Warn] 未找到「使用邮箱注册」({attempt}/{tries}): {err_s}"
                    + (f" · url={url[:80]}" if url else ""),
                    flush=True,
                )
                # 异常文案/diag 含 chrome-error / can't be reached → 硬失败 demote
                hard = _proxy_err_text(err_s) or _is_chrome_error_url(url) or _page_is_dead(
                    title, url, body_hint + "\n" + err_s
                )
                if _browser_proxy and hard:
                    hard_fail_streak += 1
                    _demote_and_rotate(
                        f"未找到邮箱注册按钮({attempt}/{tries}): 硬网络/代理失败"
                    )
                    if hard_fail_streak >= 2 and attempt >= 2:
                        break
                    time.sleep(0.5 + secrets.randbelow(40) / 100.0)
                    continue

                hard_fail_streak = 0  # 非硬失败，可能是 SPA 慢
                if attempt < tries:
                    try:
                        if attempt >= 3:
                            page = browser.new_tab(SIGNUP_URL)
                        else:
                            page.refresh()
                    except Exception:
                        try:
                            page = browser.new_tab(SIGNUP_URL)
                        except Exception:
                            pass
                    time.sleep(0.8 + secrets.randbelow(50) / 100.0)
        except Exception as outer:
            last_err = outer
            print(f"[Warn] open_signup_page 异常({attempt}/{tries}): {outer}", flush=True)
            if _browser_proxy and _proxy_err_text(str(outer)):
                hard_fail_streak += 1
                _demote_and_rotate(f"open_signup 异常: {str(outer)[:80]}")
            time.sleep(0.4 + secrets.randbelow(30) / 100.0)

    # 用尽重试 / 提前 break：硬失败则 demote（CF/本机代理跳过）
    try:
        from pools import demote_proxy_to_pending, should_skip_proxy_demote

        cur = str(_browser_proxy or "").strip()
        title_f = url_f = body_f = ""
        try:
            title_f = str(getattr(page, "title", None) or "")
            url_f = str(getattr(page, "url", None) or "")
        except Exception:
            pass
        err_blob = str(last_err or "")
        hard_final = (
            _proxy_err_text(err_blob)
            or _page_is_dead(title_f, url_f, err_blob)
            or hard_fail_streak > 0
        )
        if (
            cur
            and cur not in demoted_this_open
            and hard_final
            and not should_skip_proxy_demote(cur)
        ):
            demote_proxy_to_pending(
                cur, reason="未找到邮箱注册按钮(硬失败/代理不可达)"
            )
        elif cur and hard_final and should_skip_proxy_demote(cur):
            print(
                f"[Warn] CF/本机代理开页失败且已重试耗尽: {cur[:72]}… · "
                f"{(err_blob or title_f or url_f)[:120]}",
                flush=True,
            )
        # 真在 accounts.x.ai 活页却找不到按钮：不 demote
    except Exception:
        pass

    err_blob = str(last_err or "")
    if _proxy_err_text(err_blob) or hard_fail_streak > 0:
        hint = "；根因=代理/网络不可达（chrome-error / can't be reached），已尝试降级代理"
    elif "accounts.x.ai" in err_blob.lower() and "chrome-error" not in err_blob.lower():
        hint = "；若页面已正常打开仍无按钮，多半是文案/结构变化或加载慢"
    else:
        hint = ""
    raise Exception(
        f'未找到“使用邮箱注册”按钮（本轮已重试 {tries} 次）'
        + (f": {last_err}" if last_err else "")
        + hint
    )


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


def _step_pause(lo_ms: int = 180, hi_ms: int = 650) -> None:
    """注册步骤间短随机停顿（有限行为随机）。"""
    try:
        if human_pause is not None:
            human_pause(lo_ms, hi_ms)
            return
    except Exception:
        pass
    time.sleep(0.2 + secrets.randbelow(40) / 100.0)


def click_email_signup_button(timeout=10):
    """页面打开后点击「使用邮箱注册 / Sign up with email」。

    2026-07：accounts.x.ai 文案为 Sign up with email；
    已进入 accounts.x.ai 时禁止用正文里的 proxy/blocked 字样误判为隧道错误。
    """
    _step_pause(200, 700)
    deadline = time.time() + timeout
    last_diag = ""
    while time.time() < deadline:
        try:
            refresh_active_page()
        except Exception:
            pass

        # 若已出现邮箱输入框，视为已在邮箱注册步，无需再点按钮
        try:
            already = page.run_js(
                r"""
const inputs = Array.from(document.querySelectorAll(
  'input[type="email"], input[name*="email" i], input[autocomplete="email"], input[placeholder*="email" i], input[placeholder*="邮箱"]'
));
function vis(n){
  if(!n) return false;
  const s=getComputedStyle(n);
  if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0') return false;
  const r=n.getBoundingClientRect();
  return r.width>0 && r.height>0;
}
return inputs.some(vis);
"""
            )
            if already is True or already == "true" or already == 1:
                return True
        except Exception:
            pass

        # Drission 文本定位兜底（不依赖 JS 可见性）
        for txt in (
            "Sign up with email",
            "Sign up with Email",
            "使用邮箱注册",
            "用邮箱注册",
            "邮箱注册",
            "Continue with email",
            "Continue with Email",
        ):
            try:
                ele = page.ele(f"text:{txt}", timeout=0.35)
                if ele:
                    try:
                        ele.click()
                    except Exception:
                        try:
                            page.run_js("arguments[0].click()", ele)
                        except Exception:
                            ele.click(by_js=True)
                    _step_pause(150, 500)
                    return True
            except Exception:
                pass

        clicked = page.run_js(r"""
function isVisible(n) {
  if (!n) return false;
  const s = window.getComputedStyle(n);
  if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
  const r = n.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}
function norm(s) {
  return (s || '').replace(/\s+/g, '').toLowerCase();
}
function matchEmailSignup(text, aria, testid) {
  const t = norm(text);
  const a = norm(aria);
  const d = norm(testid);
  const blob = t + ' ' + a + ' ' + d;
  if (!blob.trim()) return false;
  // 中文
  if (t.includes('使用邮箱注册') || t.includes('用邮箱注册') || t.includes('邮箱注册')) return true;
  if (a.includes('使用邮箱注册') || a.includes('邮箱注册')) return true;
  // 英文（去空格）：Sign up with email → signupwithemail
  if (blob.includes('signupwithemail') || blob.includes('signupemail') || blob.includes('emailsignup')) return true;
  if (blob.includes('continuewithemail') || blob.includes('continuewithmail')) return true;
  if (blob.includes('createwithemail') || blob.includes('createaccountwithemail')) return true;
  // email + sign/create/continue/注册（避免仅 “email” 误点）
  if ((t.includes('email') || a.includes('email')) &&
      (t.includes('sign') || t.includes('注册') || t.includes('continue') || t.includes('create') ||
       a.includes('sign') || a.includes('continue') || a.includes('create'))) {
    // 排除 Sign in / 登录
    if (t.includes('signin') || t === 'email' || t.includes('signinemail')) return false;
    if (t.includes('登录') && !t.includes('注册')) return false;
    return true;
  }
  return false;
}
// 扩大候选：含 label、可点 div、data-testid
const sel = [
  'button', 'a', '[role="button"]',
  'div[role="button"]', 'span[role="button"]',
  '[data-testid*="email"]', '[data-testid*="sign"]',
  'label', '[tabindex="0"]'
].join(',');
let candidates = Array.from(document.querySelectorAll(sel)).filter(isVisible);
// 再扫一遍可见元素的文本节点父级（SPA 常把文案放在内层 span）
const more = Array.from(document.querySelectorAll('button *, a *, [role="button"] *'))
  .filter(isVisible)
  .map((n) => n.closest('button, a, [role="button"], div, span') || n);
candidates = candidates.concat(more);

let target = null;
const seen = new Set();
for (const node of candidates) {
  if (!node || seen.has(node)) continue;
  seen.add(node);
  const text = node.innerText || node.textContent || '';
  const aria = node.getAttribute('aria-label') || node.getAttribute('title') || '';
  const testid = node.getAttribute('data-testid') || node.id || '';
  if (matchEmailSignup(text, aria, testid)) {
    // 优先点最外层可点祖先
    target = node.closest('button, a, [role="button"]') || node;
    break;
  }
}

if (!target) {
  const href = (location && location.href) || '';
  const docUri = (document.documentURI || document.URL || '') || '';
  const body = (document.body && (document.body.innerText || '')) || '';
  const title = document.title || '';
  const bodyTrim = body.trim();
  // 真 chrome 错误页：href 常是 chrome-error://，但 Chromium 有时 page.url 仍显示目标站
  const chromeErr = /chrome-error:\/\/|chromewebdata|chrome:\/\/error/i.test(href + ' ' + docUri);
  const hardNet = /err_proxy|err_tunnel|err_socks|err_connection_|err_timed_out|err_name_not_resolved|err_address_unreachable|err_ssl_|err_empty_response|this site can.?t be reached|took too long to respond|connection timed out|connection refused|tunnel connection failed|proxy connection failed|无法访问此网站|网页无法打开/i.test(body + ' ' + title);
  // 仅「非错误页」且在 x.ai 才算 onXai；错误页上的 accounts.x.ai 字样不算活页
  const onXai = !chromeErr && !hardNet && /accounts\.x\.ai|x\.ai\/sign|auth\.x\.ai|grok\.x\.ai/i.test(href);
  // 诊断摘要（回传 Python，勿过长）
  const sampleBtns = Array.from(document.querySelectorAll('button, a, [role="button"]'))
    .filter(isVisible)
    .slice(0, 12)
    .map((n) => (n.innerText || n.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 40))
    .filter(Boolean);
  const diag = JSON.stringify({
    title: (title || '').slice(0, 80),
    href: (chromeErr ? (href || docUri) : href).slice(0, 120),
    bodyLen: bodyTrim.length,
    bodyHead: bodyTrim.slice(0, 160),
    btns: sampleBtns,
    chromeErr: !!chromeErr,
    hardNet: !!hardNet
  });

  if (!bodyTrim && !title.trim()) return 'empty|' + diag;
  // 硬错误页一律 blocked（即使 body 里出现了目标 URL 文案）
  if (chromeErr || hardNet) {
    return 'blocked|' + diag;
  }
  return 'miss|' + diag;
}

try { target.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
try { target.focus(); } catch (e) {}
try { target.click(); } catch (e) {
  try {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  } catch (e2) {}
}
return true;
        """)

        if clicked is True or clicked == "true" or clicked == 1:
            _step_pause(150, 500)
            return True

        kind = ""
        diag = ""
        if isinstance(clicked, str) and "|" in clicked:
            kind, diag = clicked.split("|", 1)
            last_diag = diag
        elif isinstance(clicked, str):
            kind = clicked

        if kind == "blocked":
            # 真·错误页：由 open_signup_page 处理；带诊断
            raise Exception(
                "注册页无法访问（代理/隧道错误，未找到邮箱注册按钮）"
                + (f" diag={last_diag[:200]}" if last_diag else "")
            )
        if kind == "empty":
            time.sleep(0.9)
        else:
            # miss：SPA 未出按钮，继续等
            time.sleep(0.45 + secrets.randbelow(35) / 100.0)

    # 超时：硬错误 vs 真活页结构问题
    url_hint = ""
    try:
        url_hint = str(getattr(page, "url", None) or "")
    except Exception:
        pass
    msg = '未找到“使用邮箱注册”按钮'
    diag_l = (last_diag or "").lower()
    hard = (
        "chrome-error" in diag_l
        or "chromewebdata" in diag_l
        or "can't be reached" in diag_l
        or "can’t be reached" in diag_l
        or '"chromeerr":true' in diag_l
        or '"hardnet":true' in diag_l
    )
    if hard:
        msg += "（代理/网络不可达）"
    elif "accounts.x.ai" in (url_hint or "").lower():
        msg += f"（已在 accounts.x.ai 活页，非代理问题；请查按钮文案/结构） url={url_hint[:100]}"
    if last_diag:
        msg += f" diag={last_diag[:240]}"
    raise Exception(msg)


def fill_email_and_submit(timeout=15):
    # 复用 `email_register.py` 里的邮箱获取逻辑，保留邮箱与 token 供后续验证码步骤继续使用。
    _step_pause(250, 800)
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
                _step_pause(200, 600)
                return email, dev_token

        time.sleep(0.4 + secrets.randbelow(25) / 100.0)

    raise Exception("未找到邮箱输入框或注册按钮")



class AccountRetryNeeded(Exception):
    """收码/邮箱阶段可换邮箱重试（不消耗整轮代理降级逻辑）。"""

    def __init__(self, message: str = "account retry needed", *, reason: str = "mail"):
        super().__init__(message)
        self.reason = reason


def fill_code_and_submit(email, dev_token, timeout=60):
    # 复用 `email_register.py` 里的验证码轮询逻辑，等待邮件到达后自动填写 OTP。
    code = get_oai_code(dev_token, email)
    if not code:
        raise AccountRetryNeeded("获取验证码失败", reason="code_timeout")

    _step_pause(180, 550)
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


def _inject_turnstile_token(token: str) -> bool:
    """将已有 Turnstile token 写回隐藏 input（二次复用）。"""
    token = str(token or "").strip()
    if not token:
        return False
    try:
        return bool(
            page.run_js(
                """
const token = arguments[0];
const challengeInput = document.querySelector('input[name="cf-turnstile-response"]');
if (!challengeInput) return false;
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
                token,
            )
        )
    except Exception:
        return False


def _turnstile_widget_state():
    """
    观察 Turnstile 当前状态。
    诊断日志里出现 title=Turnstile feedback report / src 含 /failure 表示已被 Cloudflare 判定失败。
    注意：widget 可能在 closed shadow 内，页面顶层 iframe 只有 1x1 占位。
    """
    try:
        return page.run_js(
            """
function collectFrames(root, out, depth) {
  if (!root || depth > 6) return;
  let list = [];
  try { list = Array.from(root.querySelectorAll('iframe')); } catch (e) { list = []; }
  for (const n of list) {
    const r = n.getBoundingClientRect();
    out.push({
      src: n.src || '',
      title: n.title || '',
      w: Math.round(r.width),
      h: Math.round(r.height),
      x: r.left,
      y: r.top,
    });
  }
  // 尝试 open shadow
  let all = [];
  try { all = Array.from(root.querySelectorAll('*')); } catch (e) { all = []; }
  for (const el of all) {
    if (el.shadowRoot) collectFrames(el.shadowRoot, out, depth + 1);
  }
}

const input = document.querySelector('input[name="cf-turnstile-response"]');
const frames = [];
collectFrames(document, frames, 0);

// 宿主容器尺寸（即使 iframe 1x1，容器可能仍是 300x65）
const hosts = [];
const hostSel = [
  '.cf-turnstile', '[data-sitekey]', 'div[id^="cf-"]',
  'input[name="cf-turnstile-response"]'
];
for (const sel of hostSel) {
  try {
    document.querySelectorAll(sel).forEach((el) => {
      const target = sel.includes('input') ? (el.parentElement || el) : el;
      const r = target.getBoundingClientRect();
      hosts.push({
        sel,
        w: Math.round(r.width),
        h: Math.round(r.height),
        x: r.left,
        y: r.top,
      });
    });
  } catch (e) {}
}

const failure = frames.some((f) =>
  /\\/failure/i.test(f.src) || /feedback report/i.test(f.title) || /failed/i.test(f.title)
);
const challenge = frames.find((f) =>
  /challenges\\.cloudflare\\.com/i.test(f.src) && !/\\/failure/i.test(f.src) && f.w >= 20 && f.h >= 20
) || frames.find((f) =>
  /turnstile|widget containing/i.test((f.src || '') + ' ' + (f.title || '')) && f.w >= 20 && f.h >= 20
) || null;
const sized = frames.find((f) => f.w >= 240 && f.w <= 400 && f.h >= 50 && f.h <= 90) || null;
const hostSized = hosts.find((h) => h.w >= 100 && h.h >= 40) || hosts.find((h) => h.w >= 20 && h.h >= 20) || null;
const collapsedOnly = !challenge && !sized && frames.some((f) => f.w > 0 && f.w <= 5 && f.h > 0 && f.h <= 5);
const tokenLen = input ? String(input.value || '').trim().length : 0;
return {
  failure: !!failure,
  collapsedOnly: !!collapsedOnly,
  tokenLen,
  hasInput: !!input,
  hasApi: typeof turnstile !== 'undefined',
  challenge,
  sized,
  hostSized,
  hosts: hosts.slice(0, 6),
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


def _host_click_box():
    """
    当 shadow 内 iframe 缩成 1x1 时，改点宿主容器左侧（checkbox 区域）。
    返回 {x,y,w,h} 或 None。
    """
    try:
        box = page.run_js(
            """
const candidates = [];
const push = (el, tag) => {
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (r.width >= 80 && r.height >= 40 && r.width <= 520 && r.height <= 120) {
    candidates.push({ tag, x: r.left, y: r.top, w: r.width, h: r.height });
  }
};
document.querySelectorAll('.cf-turnstile, [data-sitekey], div[id^="cf-"]').forEach((el) => push(el, 'host'));
const input = document.querySelector('input[name="cf-turnstile-response"]');
if (input) {
  let p = input.parentElement;
  for (let i = 0; i < 6 && p; i++) {
    push(p, 'input-parent-' + i);
    p = p.parentElement;
  }
}
// 取面积最大的合理宿主
candidates.sort((a, b) => (b.w * b.h) - (a.w * a.h));
return candidates[0] || null;
            """
        )
        if box and float(box.get("w") or 0) >= 80:
            return box
    except Exception:
        pass
    return None


def _locate_turnstile_click_target():
    """
    定位 Turnstile 复选框点击目标。
    返回 (target, how)：
      - target 可以是 iframe 元素，或 dict 坐标框 {x,y,w,h,kind:'box'}
    跳过 failure feedback；兼容 1x1 collapsed iframe + 宿主容器点击。
    """
    last_err = ""

    # 路径 A：从 hidden input 的父级 shadow 找 iframe
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
                            # 1x1 也返回，调用方可用宿主框补点
                            if box and float(box.get("w") or 0) > 0:
                                return iframe, "input-parent-shadow-collapsed"
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
                        box = _iframe_box(iframe)
                        if box and float(box.get("w") or 0) >= 20:
                            return iframe, f"host-shadow:{selector}"
            except Exception:
                pass
            try:
                iframe = host.ele("tag:iframe", timeout=0.2)
                if iframe:
                    return iframe, f"host-iframe:{selector}"
            except Exception:
                pass
            # 无可用 iframe 时点宿主本身
            try:
                hb = host.run_js(
                    "const r=this.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height};"
                )
                if hb and float(hb.get("w") or 0) >= 80 and float(hb.get("h") or 0) >= 40:
                    hb = dict(hb)
                    hb["kind"] = "box"
                    return hb, f"host-box:{selector}"
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

    # 路径 E：宿主容器坐标（iframe 已 1x1 / closed shadow 时）
    host_box = _host_click_box()
    if host_box:
        host_box = dict(host_box)
        host_box["kind"] = "box"
        return host_box, "host-container-box"

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


def _click_turnstile_checkbox(target, prefer_cdp=True, how=""):
    """
    对 Turnstile 复选框点击。
    target: iframe 元素 或 {x,y,w,h,kind:'box'} 宿主坐标框。
    优先 CDP 坐标点击；iframe 缩成 1x1 时改点宿主左侧。
    """
    clicked = False
    detail = []
    iframe = None
    box = None

    if isinstance(target, dict) and target.get("kind") == "box":
        box = target
        detail.append("target=box")
    else:
        iframe = target
        box = _iframe_box(iframe) if iframe is not None else None
        # collapsed iframe：用宿主容器尺寸
        if (not box) or float(box.get("w") or 0) < 20 or float(box.get("h") or 0) < 20 or "collapsed" in (how or ""):
            host = _host_click_box()
            if host:
                box = host
                detail.append("fallback-host-box")

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

    # 兜底：shadow 内 input（仅 iframe 可用时）
    if not clicked and iframe is not None:
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

    if not clicked and iframe is not None:
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


def _load_turnstile_auto_wait_max() -> int:
    """
    从 config.json 读取 Turnstile 自动通过等待上限（秒）。
    实际等待在 [30, max] 内随机；缺省 max=60。
    """
    default_max = 60
    config_path = os.path.join(os.path.dirname(__file__), "config.json")
    try:
        import json
        with open(config_path, "r", encoding="utf-8") as f:
            conf = json.load(f)
        # 支持 turnstile.auto_wait_max 或顶层 turnstile_auto_wait_max
        raw = None
        if isinstance(conf.get("turnstile"), dict):
            raw = conf["turnstile"].get("auto_wait_max")
        if raw is None:
            raw = conf.get("turnstile_auto_wait_max")
        v = int(raw) if raw is not None else default_max
        if v < 30:
            v = 30
        if v > 180:
            v = 180
        return v
    except Exception:
        return default_max


def _pick_turnstile_auto_wait_secs(timeout: float) -> float:
    """在 [30, configured_max] 内随机，且不超过本次 getTurnstileToken 的总 timeout-5。"""
    configured_max = _load_turnstile_auto_wait_max()
    lo = 30
    hi = max(lo, configured_max)
    # secrets.randbelow(n) → [0, n)
    span = hi - lo + 1
    picked = lo + secrets.randbelow(span)
    # 不能把整个 timeout 吃光，至少给点击阶段留 5s
    cap = max(0.0, float(timeout) - 5.0)
    return float(min(picked, cap)) if cap > 0 else 0.0


def _scroll_turnstile_into_view() -> None:
    """把 Turnstile 宿主滚进视口，避免点到错误坐标。"""
    try:
        page.run_js(
            """
const input = document.querySelector('input[name="cf-turnstile-response"]');
const host = document.querySelector('.cf-turnstile, [data-sitekey]')
  || (input && input.parentElement);
if (host && host.scrollIntoView) {
  host.scrollIntoView({ block: 'center', inline: 'nearest' });
  return true;
}
return false;
            """
        )
    except Exception:
        pass


def getTurnstileToken(timeout=50):
    """
    求解最终注册页 Turnstile。
    优先长等自动通过；若控件长期 1x1 折叠则中途 soft reset + 宿主框点击。
    点击阶段：折叠态最多 4 次，正常最多 3 次；点击前滚入视口。
    """
    refresh_active_page()
    _apply_stealth_patches(page)
    _scroll_turnstile_into_view()
    deadline = time.time() + timeout
    last_diag = ""
    click_attempts = 0
    reset_count = 0
    mid_reset_done = False
    max_clicks = 3

    # 自动通过：30 ~ n 秒随机（n = config turnstile.auto_wait_max，默认 60）
    auto_wait_secs = _pick_turnstile_auto_wait_secs(timeout)
    auto_wait_until = time.time() + auto_wait_secs
    print(
        f"[*] Turnstile 自动通过等待最长 {auto_wait_secs:.0f}s "
        f"（区间 30~{_load_turnstile_auto_wait_max()}s 随机）…"
    )
    auto_start = time.time()
    while time.time() < auto_wait_until:
        token = _read_turnstile_token()
        if token:
            print("[*] Turnstile 已自动通过（无需点击）。")
            return token
        state = _turnstile_widget_state()
        if state.get("failure"):
            print("[Warn] 自动等待阶段检测到 Turnstile failure 反馈页。")
            break
        # 折叠超过 ~12s 且有宿主尺寸：中途 soft reset 一次，给 widget 重渲染机会
        elapsed = time.time() - auto_start
        if (
            not mid_reset_done
            and elapsed >= 12
            and state.get("collapsedOnly")
            and state.get("hostSized")
            and not state.get("failure")
            and reset_count < 2
        ):
            print("[*] 自动等待中控件仍 1x1，执行 mid soft reset…")
            _soft_reset_turnstile()
            mid_reset_done = True
            reset_count += 1
            time.sleep(1.2 + secrets.randbelow(8) / 10.0)
            _scroll_turnstile_into_view()
            continue
        # 已有可点尺寸的 challenge：提前结束自动等待，进入点击
        if state.get("challenge") or state.get("sized"):
            print("[*] 检测到可交互 Turnstile 控件，进入点击阶段。")
            break
        time.sleep(0.4)

    while time.time() < deadline:
        token = _read_turnstile_token()
        if token:
            print("[*] Turnstile token 已获取。")
            return token

        state = _turnstile_widget_state()
        # 折叠态多给几次点击机会
        if state.get("collapsedOnly"):
            max_clicks = 4

        if state.get("failure"):
            last_diag = f"failure-state frames={state.get('frames')}"
            if reset_count < 2 and time.time() + 6 < deadline:
                print("[*] 检测到 Turnstile failure，执行 soft reset。")
                _soft_reset_turnstile()
                reset_count += 1
                wait_end = time.time() + min(8, deadline - time.time())
                while time.time() < wait_end:
                    token = _read_turnstile_token()
                    if token:
                        print("[*] Turnstile soft reset 后已自动通过。")
                        return token
                    if _turnstile_widget_state().get("failure"):
                        break
                    time.sleep(0.4)
                continue
            print("[Debug] Turnstile 已被 Cloudflare 判定 failure，停止连点。")
            break

        if click_attempts >= max_clicks:
            last_diag = f"max-clicks:{click_attempts}"
            # 最后一次 reset 后再等一小段，避免直接放弃
            if reset_count < 2 and time.time() + 5 < deadline:
                print("[*] 点击次数用尽，最后 soft reset 并短等…")
                _soft_reset_turnstile()
                reset_count += 1
                click_attempts = max(0, max_clicks - 1)  # 允许再点 1 次
                wait_end = time.time() + min(5, deadline - time.time())
                while time.time() < wait_end:
                    token = _read_turnstile_token()
                    if token:
                        print("[*] 最终 soft reset 后已自动通过。")
                        return token
                    time.sleep(0.4)
                continue
            break

        target, how = _locate_turnstile_click_target()
        if target is None:
            last_diag = f"locate-fail:{how} state={state}"
            if state.get("collapsedOnly") and reset_count < 2 and time.time() + 8 < deadline:
                print("[*] Turnstile 控件折叠为 1x1，soft reset 一次。")
                _soft_reset_turnstile()
                reset_count += 1
                wait_end = time.time() + min(6, deadline - time.time())
                while time.time() < wait_end:
                    token = _read_turnstile_token()
                    if token:
                        print("[*] Turnstile soft reset 后已自动通过。")
                        return token
                    time.sleep(0.4)
                continue
            time.sleep(0.6)
            continue

        if click_attempts == 0:
            print(f"[*] 已定位 Turnstile ({how})，CDP 点击（最多 {max_clicks} 次）。")

        _scroll_turnstile_into_view()
        time.sleep(0.15 + secrets.randbelow(25) / 100.0)
        clicked, detail = _click_turnstile_checkbox(target, prefer_cdp=True, how=how)
        click_attempts += 1
        last_diag = f"click#{click_attempts} via={how} detail={detail} ok={clicked}"
        print(f"[*] Turnstile 点击尝试 #{click_attempts}: {detail}")

        # 点击后等待：折叠态稍长，给 token 生成时间
        wait_slice = min(7.0 if state.get("collapsedOnly") else 5.0, max(2.5, deadline - time.time()))
        wait_end = time.time() + wait_slice
        while time.time() < wait_end:
            token = _read_turnstile_token()
            if token:
                print(f"[*] Turnstile 点击后已出 token（第 {click_attempts} 次）。")
                return token
            st = _turnstile_widget_state()
            if st.get("failure"):
                print("[Warn] 点击后进入 Turnstile failure 状态。")
                last_diag = f"post-click-failure #{click_attempts}"
                break
            time.sleep(0.35)

        time.sleep(0.25 + secrets.randbelow(25) / 100.0)

    # 最终诊断
    try:
        diag = _turnstile_widget_state()
        print(f"[Debug] Turnstile 失败诊断: {diag} | last={last_diag}")
        if diag.get("failure"):
            raise Exception(
                "failed to solve turnstile: Cloudflare 返回 failure 反馈页"
                "（多为 IP 信誉/浏览器指纹/架构问题，而非单纯点不中）"
            )
        if diag.get("collapsedOnly"):
            raise Exception(
                "failed to solve turnstile: widget 折叠为 1x1 且无 token"
                "（常见于 ARM 容器 / UA 与 Chromium 版本错配 / 代理 IP 信誉偏低）"
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


def fill_profile_and_submit(timeout=None, *, mode: str = "a"):
    # 覆盖 Turnstile 自动通过（30~n 秒随机）+ 短点击 + 表单填写。
    # timeout 默认随 config turnstile.auto_wait_max 放宽。
    # mode="b"：Plan B —— 先等自然成功证据，再 simulate 点击（FlowPilot 思路）
    plan_b = str(mode or "a").lower() in ("b", "plan_b", "plan-b", "2")
    if timeout is None:
        base = float(_load_turnstile_auto_wait_max() + 30)
        timeout = base + (45 if plan_b else 0)

    given_name, family_name, password = build_profile()
    deadline = time.time() + timeout
    turnstile_token = ""
    turnstile_attempted = False

    if plan_b:
        print("[plan-b] 资料页：拟人延迟 + 等人机成功证据后再提交")
        try:
            from plan_b import detect_cf_security_block, human_pause, human_pause_major

            blk = detect_cf_security_block(page)
            if blk:
                raise Exception(f"CF 安全拦截({blk})，Plan B 放弃")
            human_pause_major(800, 1600)
        except Exception as e:
            if "CF 安全拦截" in str(e):
                raise
            print(f"[plan-b] 预检跳过: {e}")

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
            if plan_b:
                try:
                    from plan_b import detect_cf_security_block, human_pause

                    blk = detect_cf_security_block(page)
                    if blk:
                        raise Exception(f"CF 安全拦截({blk})，Plan B 放弃")
                    human_pause(300, 900)
                except Exception as e:
                    if "CF 安全拦截" in str(e):
                        raise
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

        # ── Plan B：先等自然成功证据，再模拟点击；失败再回落到 getTurnstileToken ──
        if plan_b and not turnstile_attempted:
            turnstile_attempted = True
            try:
                from plan_b import wait_turnstile_success, human_pause

                remain = max(30.0, min(120.0, deadline - time.time() - 5))
                print(f"[plan-b] 等待 Turnstile 成功证据（最长 {int(remain)}s）…")
                ev = wait_turnstile_success(page, timeout=remain, log=lambda m: print(m))
                if not ev.get("ok"):
                    print("[plan-b] 自然成功证据超时，尝试 getTurnstileToken 兜底…")
                else:
                    print(f"[plan-b] 人机证据就绪 type={ev.get('type')}")
                human_pause(400, 1000)
            except Exception as e:
                print(f"[plan-b] wait_turnstile: {e}")

        if turnstile_state == "pending" and not turnstile_token:
            if turnstile_attempted and not plan_b:
                remain = max(5, deadline - time.time() - 3)
            else:
                # 自动通过上限 n（默认 60，WebUI 可配）+ 点击缓冲；总预算随 n 放宽
                auto_max = _load_turnstile_auto_wait_max()
                remain = max(auto_max + 15, min(auto_max + 25, deadline - time.time() - 3))
            if not plan_b or not turnstile_token:
                print("[*] 检测到最终注册页存在 Turnstile，优先等待自动通过。")
                turnstile_attempted = True
                turnstile_token = getTurnstileToken(timeout=remain)
                if turnstile_token:
                    if _inject_turnstile_token(turnstile_token):
                        print("[*] Turnstile 响应已同步到最终注册表单。")

        # P1：提交前若 token 被清空/卡住，二次复用已有 token 或再取一次
        if turnstile_state == "pending" or turnstile_state == "not-found":
            pass
        else:
            # ready 时也校验页面是否仍持有 token
            cur = _read_turnstile_token()
            if cur:
                turnstile_token = cur
        if not _read_turnstile_token() and turnstile_token:
            print("[*] 页面 Turnstile token 丢失，二次注入已有 token…")
            _inject_turnstile_token(turnstile_token)
        elif not _read_turnstile_token() and time.time() + 8 < deadline:
            # 卡住：soft reset + 再取一次
            print("[*] 提交前 Turnstile 仍空，soft reset 后二次获取…")
            try:
                _soft_reset_turnstile()
            except Exception:
                pass
            extra = getTurnstileToken(timeout=min(25, max(8, deadline - time.time() - 2)))
            if extra:
                turnstile_token = extra
                _inject_turnstile_token(extra)
                print("[*] Turnstile 二次复用完成。")

        time.sleep(0.6 if not plan_b else 0.9)

        clicked = False
        if plan_b:
            try:
                from plan_b import simulate_submit_click, human_pause

                human_pause(200, 600)
                r = simulate_submit_click(page)
                clicked = bool(r.get("ok"))
                if clicked:
                    print(f"[plan-b] 模拟点击提交: {r.get('text') or 'ok'}")
                elif r.get("reason") == "turnstile-empty":
                    print("[plan-b] 人机 token 仍空，暂不提交")
            except Exception as e:
                print(f"[plan-b] simulate_click 失败: {e}")
                clicked = False

        if not clicked:
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
            tag = "plan-b" if plan_b else "*"
            print(f"[{tag}] 已填写注册资料并点击完成注册: {given_name} {family_name} / {password}")
            return {
                "given_name": given_name,
                "family_name": family_name,
                "password": password,
                "plan": "b" if plan_b else "a",
            }

        time.sleep(0.5 if not plan_b else 0.8)

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
    # P1：最终页 CF/Turnstile 卡住时 soft reset + 二次 token 复用。
    global page
    deadline = time.time() + timeout
    last_url = ""
    cf_retry = 0
    while time.time() < deadline:
        try:
            refresh_active_page()
            current_url = page.url or ""
            if current_url != last_url:
                print(f"[*] 等待重定向到 grok.com，当前: {current_url}")
                last_url = current_url

            # 最终页仍停在 accounts.x.ai 且出现 Turnstile / CF 挑战
            stuck_cf = False
            try:
                st = _turnstile_widget_state() if "accounts.x.ai" in current_url else {}
                if st.get("failure") or st.get("collapsedOnly"):
                    stuck_cf = True
                if not stuck_cf and "accounts.x.ai" in current_url:
                    body_cf = page.run_js(
                        r"""
const t = (document.body && (document.body.innerText || document.body.textContent) || '');
return /checking your browser|just a moment|cf-browser-verification|turnstile|verify you are human/i.test(t)
  || !!document.querySelector('iframe[src*="challenges.cloudflare.com"], input[name="cf-turnstile-response"]');
"""
                    )
                    stuck_cf = bool(body_cf)
            except Exception:
                stuck_cf = False
            if stuck_cf and cf_retry < 3 and time.time() + 12 < deadline:
                cf_retry += 1
                print(f"[*] 最终页疑似 CF/Turnstile 卡住，二次复用 #{cf_retry}…")
                try:
                    _soft_reset_turnstile()
                except Exception:
                    pass
                tok = getTurnstileToken(timeout=min(20, max(8, deadline - time.time() - 5)))
                if tok:
                    _inject_turnstile_token(tok)
                    print(f"[*] 最终页 Turnstile 二次复用完成 len={len(tok)}")
                time.sleep(1.2)
                continue

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
// 年龄确认弹窗也说明已进入产品页
const body = (document.body && (document.body.innerText || document.body.textContent) || '');
if (/请确认你的年龄|Confirm your age|选择你的出生年份|Select your birth year/i.test(body)) return true;
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


def _random_adult_birth_year() -> int:
    """随机成年出生年：年龄约 18–45 岁（含）。"""
    now_year = datetime.datetime.now().year
    min_year = now_year - 45
    max_year = now_year - 18
    if max_year < min_year:
        max_year = min_year
    return min_year + secrets.randbelow(max_year - min_year + 1)


def detect_age_gate() -> bool:
    """页面是否出现「确认年龄 / 出生年份」弹窗。"""
    global page
    try:
        refresh_active_page()
        return bool(page.run_js(r"""
function isVisible(n) {
    if (!n) return false;
    const s = window.getComputedStyle(n);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
}
const body = (document.body && (document.body.innerText || document.body.textContent) || '');
if (/请确认你的年龄|请确认您的年龄|Confirm your age|选择你的出生年份|选择你的出生年|Select your birth year|birth year/i.test(body)) {
    return true;
}
// 对话框内出现 4 位年份输入
const yearInputs = Array.from(document.querySelectorAll('input')).filter((n) => {
    if (!isVisible(n) || n.disabled) return false;
    const ph = String(n.placeholder || '') + ' ' + String(n.name || '') + ' ' + String(n.getAttribute('aria-label') || '');
    const t = String(n.type || '').toLowerCase();
    if (/year|birth|年龄|出生/i.test(ph)) return true;
    if ((t === 'number' || t === 'text' || t === 'tel') && Number(n.maxLength || 0) === 4) return true;
    const v = String(n.value || '').trim();
    if (/^(19|20)\d{2}$/.test(v)) return true;
    return false;
});
return yearInputs.length > 0 && /年龄|continue|确认|confirm|年龄|age/i.test(body);
"""))
    except Exception:
        return False


def fill_age_gate_and_submit(birth_year: int | None = None, timeout: float = 25) -> bool:
    """
    填写年龄弹窗中的出生年份并点「继续」。
    返回 True 表示已提交或弹窗已消失；False 表示未找到/超时。
    """
    global page
    year = int(birth_year if birth_year is not None else _random_adult_birth_year())
    year_s = str(year)
    deadline = time.time() + timeout
    print(f"[*] 年龄门：尝试填写出生年 {year_s}")
    # 节流日志：同类状态最多打 3 次，避免「文案在但未找到年份输入框」刷屏
    _log_counts: dict[str, int] = {}

    def _log_throttled(key: str, msg: str, limit: int = 3) -> None:
        n = _log_counts.get(key, 0)
        if n >= limit:
            return
        _log_counts[key] = n + 1
        print(msg)
        if n + 1 == limit:
            print(f"[Debug] 年龄门：后续同类日志已省略（{key}）")

    while time.time() < deadline:
        try:
            refresh_active_page()
            result = page.run_js(
                r"""
const year = String(arguments[0] || '').trim();

function isVisible(n) {
    if (!n) return false;
    const s = window.getComputedStyle(n);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
}

function setNativeValue(input, value) {
    const isCe = input.isContentEditable || input.getAttribute('contenteditable') === 'true';
    if (isCe) {
        input.focus();
        try {
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, value);
        } catch (e) {
            input.textContent = value;
        }
        input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: value, inputType: 'insertText' }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return;
    }
    const proto = input.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const tracker = input._valueTracker;
    if (tracker) tracker.setValue('');
    if (nativeSetter) {
        nativeSetter.call(input, '');
        nativeSetter.call(input, value);
    } else {
        input.value = '';
        input.value = value;
    }
    input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: value, inputType: 'insertText' }));
    input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: value, inputType: 'insertText' }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
}

// 含 open shadow root 的查询（年龄门常在 portal/shadow 里）
function deepQueryAll(selector, root) {
    const out = [];
    const walk = (node) => {
        if (!node) return;
        try {
            if (node.querySelectorAll) {
                node.querySelectorAll(selector).forEach((el) => out.push(el));
            }
        } catch (e) {}
        const children = node.children || node.childNodes || [];
        for (const c of children) {
            if (c && c.shadowRoot) walk(c.shadowRoot);
            if (c && c.nodeType === 1) walk(c);
        }
    };
    walk(root || document);
    return out;
}

const body = (document.body && (document.body.innerText || document.body.textContent) || '');
const ageCtx = /请确认你的年龄|请确认您的年龄|Confirm your age|选择你的出生年份|选择你的出生年|Select your birth year|birth year|年龄/i.test(body);

const allFields = deepQueryAll('input, textarea, [contenteditable="true"], [role="spinbutton"]');
const inputs = allFields.filter((n) => {
    if (!isVisible(n) || n.disabled || n.readOnly) return false;
    const meta = [
        n.placeholder, n.name, n.id, n.getAttribute('aria-label'), n.getAttribute('data-testid'), n.type,
        n.getAttribute('inputmode'), n.getAttribute('autocomplete')
    ].map((x) => String(x || '')).join(' ');
    if (/year|birth|年龄|出生|age|bday/i.test(meta)) return true;
    const t = String(n.type || '').toLowerCase();
    if ((t === 'number' || t === 'text' || t === 'tel') && Number(n.maxLength || 0) === 4) return true;
    if (n.getAttribute('inputmode') === 'numeric' && ageCtx) return true;
    if (ageCtx && (t === 'number' || t === 'text' || t === 'tel' || n.isContentEditable)) {
        const v = String(n.value || n.textContent || '').trim();
        if (!v || /^(19|20)\d{0,2}$/.test(v)) return true;
    }
    return false;
});

// 优先选看起来像年份的 input
let yearInput = inputs.find((n) => {
    const meta = [n.placeholder, n.name, n.id, n.getAttribute('aria-label'), n.getAttribute('autocomplete')].join(' ');
    return /year|birth|出生|年龄|bday/i.test(meta);
}) || inputs.find((n) => Number(n.maxLength || 0) === 4)
  || inputs.find((n) => String(n.type || '').toLowerCase() === 'number')
  || inputs.find((n) => n.getAttribute('inputmode') === 'numeric')
  || inputs[0] || null;

if (!yearInput) {
    // 下拉/列表式年份（button/listbox）
    const listOpts = deepQueryAll('[role="option"], [role="listbox"] button, select option').filter(isVisible);
    const hit = listOpts.find((n) => String(n.innerText || n.textContent || n.value || '').trim() === year);
    if (hit) {
        hit.click();
        const buttons = deepQueryAll('button, [role="button"], a').filter((n) => {
            return isVisible(n) && !n.disabled && n.getAttribute('aria-disabled') !== 'true';
        });
        const cont = buttons.find((n) => {
            const text = (n.innerText || n.textContent || '').replace(/\s+/g, '');
            const t = text.toLowerCase();
            return text.includes('继续') || t.includes('continue') || text.includes('确认') || t.includes('confirm')
                || text.includes('下一步') || t.includes('next') || t.includes('submit');
        });
        if (cont) cont.click();
        return cont ? 'submitted' : 'filled-no-button';
    }
    return ageCtx ? 'no-input' : 'not-present';
}

yearInput.focus();
yearInput.click();
try { yearInput.select(); } catch (e) {}
setNativeValue(yearInput, year);
const cur = String(yearInput.value || yearInput.textContent || '').trim();
if (cur !== year) {
    setNativeValue(yearInput, '');
    setNativeValue(yearInput, year);
}
const cur2 = String(yearInput.value || yearInput.textContent || '').trim();
if (cur2 !== year) {
    return 'fill-failed:' + cur2;
}

const buttons = deepQueryAll('button, [role="button"], a').filter((n) => {
    return isVisible(n) && !n.disabled && n.getAttribute('aria-disabled') !== 'true';
});
const cont = buttons.find((n) => {
    const text = (n.innerText || n.textContent || '').replace(/\s+/g, '');
    const t = text.toLowerCase();
    return text === '继续' || text.includes('继续') || t === 'continue' || t.includes('continue')
        || text === '确认' || text.includes('确认') || t === 'confirm' || t.includes('confirm')
        || text === '下一步' || t.includes('next') || t.includes('submit');
});
if (!cont) {
    return 'filled-no-button';
}
cont.focus();
cont.click();
return 'submitted';
                """,
                year_s,
            )
        except PageDisconnectedError:
            refresh_active_page()
            result = "disconnected"
        except Exception as e:
            result = f"error:{e}"

        if result == "not-present":
            return False
        if result == "submitted":
            print(f"[*] 年龄门：已提交出生年 {year_s}")
            time.sleep(1.2)
            if not detect_age_gate():
                print("[*] 年龄门：弹窗已关闭")
                return True
            print("[*] 年龄门：已点继续，弹窗可能仍在，继续观察…")
            time.sleep(1.0)
            if not detect_age_gate():
                return True
            continue
        if result == "filled-no-button":
            _log_throttled("no-btn", "[Debug] 年龄门：年份已填，未找到继续按钮")
        elif result == "no-input":
            _log_throttled("no-input", "[Debug] 年龄门：文案在但未找到年份输入框")
        elif isinstance(result, str) and result.startswith("fill-failed"):
            _log_throttled("fill-failed", f"[Debug] 年龄门：年份写入失败 {result}")
        elif result == "disconnected":
            pass
        else:
            _log_throttled(f"st:{result}", f"[Debug] 年龄门：状态 {result}")

        time.sleep(0.6)

    print(f"[Warn] 年龄门：处理超时（目标年 {year_s}）")
    return False


# 年龄门触发用的随机英文短句（避免固定「你好」）
_AGE_GATE_TRIGGER_MESSAGES = (
    "hi",
    "hello",
    "hey",
    "hello there",
    "hi there",
    "good day",
    "how are you",
    "what's up",
    "hey grok",
    "hello world",
    "good morning",
    "good evening",
    "yo",
    "greetings",
    "hi friend",
)


def _random_age_gate_message() -> str:
    return secrets.choice(_AGE_GATE_TRIGGER_MESSAGES)


def send_chat_message(text: str | None = None, timeout: float = 20) -> bool:
    """在 grok.com 输入框发送一条消息（用于触发生日/年龄门）。默认随机英文。"""
    global page
    msg = str(text or "").strip() or _random_age_gate_message()
    deadline = time.time() + timeout
    print(f"[*] 发送聊天消息以触发年龄门: {msg!r}")

    while time.time() < deadline:
        try:
            refresh_active_page()
            # 若年龄门已在，无需再发
            if detect_age_gate():
                print("[*] 发送前已检测到年龄门，跳过发消息")
                return True

            result = page.run_js(
                r"""
const msg = String(arguments[0] || '');

function isVisible(n) {
    if (!n) return false;
    const s = window.getComputedStyle(n);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
}

function isEditableBox(n) {
    if (!n) return false;
    if (n.disabled || n.readOnly) return false;
    const tag = (n.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'INPUT') return true;
    if (n.isContentEditable) return true;
    if (String(n.getAttribute('contenteditable') || '').toLowerCase() === 'true') return true;
    if (String(n.getAttribute('role') || '').toLowerCase() === 'textbox') return true;
    return false;
}

/** 写入聊天框：contenteditable div 绝不能走 Input.value setter（会 Illegal invocation） */
function fillChatInput(el, value) {
    const tag = (el.tagName || '').toUpperCase();
    const isNativeField = tag === 'TEXTAREA' || tag === 'INPUT';
    const isCE = !!(el.isContentEditable || String(el.getAttribute('contenteditable') || '').toLowerCase() === 'true'
        || (String(el.getAttribute('role') || '').toLowerCase() === 'textbox' && !isNativeField));

    el.focus();
    try { el.click(); } catch (e) {}

    if (isNativeField) {
        const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        const tracker = el._valueTracker;
        if (tracker) {
            try { tracker.setValue(''); } catch (e) {}
        }
        if (nativeSetter) {
            nativeSetter.call(el, '');
            nativeSetter.call(el, value);
        } else {
            el.value = value;
        }
        el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: value, inputType: 'insertText' }));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: value, inputType: 'insertText' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return String(el.value || '') === String(value);
    }

    // contenteditable / role=textbox（Grok 主输入是 HTMLDivElement）
    try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
    } catch (e) {}

    let ok = false;
    // 1) execCommand 最接近真实输入，React/ProseMirror 常能接到
    try {
        if (document.execCommand) {
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, value);
            ok = (el.innerText || el.textContent || '').includes(value)
                || (el.innerText || el.textContent || '').trim().length > 0;
        }
    } catch (e) {}

    // 2) 直接写 DOM + 事件
    if (!ok) {
        try {
            el.textContent = '';
            el.textContent = value;
            // 部分编辑器吃 innerHTML
            if (!(el.innerText || el.textContent || '').trim()) {
                el.innerHTML = '';
                el.appendChild(document.createTextNode(value));
            }
            el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: value, inputType: 'insertText' }));
            el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: value, inputType: 'insertText' }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            ok = (el.innerText || el.textContent || '').includes(value)
                || (el.innerText || el.textContent || '').trim().length > 0;
        } catch (e) {
            return false;
        }
    }
    return ok;
}

// 候选：textarea / input 优先，再 contenteditable / role=textbox
const raw = Array.from(document.querySelectorAll(
    'textarea, input[type="text"], input:not([type]), [contenteditable="true"], [contenteditable=""], div[role="textbox"], [role="textbox"]'
)).filter((n) => isVisible(n) && isEditableBox(n));

const scored = raw.map((n) => {
    const meta = [n.placeholder, n.getAttribute('aria-label'), n.getAttribute('data-testid'), n.name, n.id].join(' ');
    if (/year|birth|年龄|出生/i.test(meta)) return null;
    const r = n.getBoundingClientRect();
    if (r.width < 100 || r.height < 20) return null;
    const tag = (n.tagName || '').toUpperCase();
    let score = r.width * r.height;
    if (tag === 'TEXTAREA') score += 1e7;
    if (tag === 'INPUT') score += 5e6;
    if (n.isContentEditable || String(n.getAttribute('role') || '') === 'textbox') score += 1e6;
    // 页面下半部的输入框更像主聊天框
    score += (r.top / Math.max(window.innerHeight, 1)) * 1e5;
    return { n, score };
}).filter(Boolean);

scored.sort((a, b) => b.score - a.score);
const input = scored.length ? scored[0].n : null;

if (!input) {
    return 'no-input';
}

const ok = fillChatInput(input, msg);
if (!ok) return 'fill-failed';

// Enter 发送
const enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
input.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
input.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
input.dispatchEvent(new KeyboardEvent('keyup', enterOpts));

// 发送按钮
const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isVisible);
const sendBtn = buttons.find((n) => {
    const label = (n.innerText || n.textContent || n.getAttribute('aria-label') || n.getAttribute('data-testid') || '').replace(/\s+/g, '');
    const t = label.toLowerCase();
    return t === 'send' || label === '发送' || label.includes('发送')
        || /send/i.test(n.getAttribute('aria-label') || '')
        || /send/i.test(n.getAttribute('data-testid') || '');
});
if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true') {
    try { sendBtn.click(); } catch (e) {}
    return 'sent-click';
}
return 'sent-enter';
                """,
                msg,
            )
        except PageDisconnectedError:
            refresh_active_page()
            result = "disconnected"
        except Exception as e:
            result = f"error:{e}"

        if result in ("sent-enter", "sent-click"):
            print(f"[*] 聊天消息已发送（{result}）")
            time.sleep(1.5)
            return True
        if result == "no-input":
            # 可能还在加载，或年龄门挡住
            if detect_age_gate():
                print("[*] 发消息时检测到年龄门")
                return True
        else:
            print(f"[Debug] 发消息状态: {result}")

        time.sleep(0.8)

    print("[Warn] 发送聊天消息超时（输入框未就绪）")
    return False


def ensure_age_gate_completed(
    trigger_message: str | None = None,
    timeout: float = 45,
) -> dict:
    """
    注册落到 grok.com 后：
      1) 若已有年龄弹窗 → 直接填随机成年出生年
      2) 否则先发一条随机英文短消息触发弹窗，再填写
    失败不抛异常（避免拖死整轮注册），返回状态 dict。
    """
    global page
    birth_year = _random_adult_birth_year()
    message = (trigger_message or "").strip() or _random_age_gate_message()
    status = {
        "attempted": True,
        "triggered_by_message": False,
        "trigger_message": message,
        "age_gate_seen": False,
        "submitted": False,
        "birth_year": birth_year,
    }
    deadline = time.time() + timeout

    try:
        # 先等页面稍稳
        time.sleep(1.0)
        refresh_active_page()

        if detect_age_gate():
            status["age_gate_seen"] = True
            status["submitted"] = fill_age_gate_and_submit(birth_year, timeout=min(25, deadline - time.time()))
            return status

        # 发随机英文消息触发
        sent = send_chat_message(message, timeout=min(20, max(5, deadline - time.time())))
        status["triggered_by_message"] = bool(sent)

        # 等待弹窗出现
        wait_end = time.time() + min(20, max(3, deadline - time.time()))
        while time.time() < wait_end:
            if detect_age_gate():
                status["age_gate_seen"] = True
                break
            time.sleep(0.6)

        if not status["age_gate_seen"]:
            print("[*] 年龄门：发消息后未出现弹窗（可能账号无需确认或已确认）")
            return status

        remain = max(8, deadline - time.time())
        status["submitted"] = fill_age_gate_and_submit(birth_year, timeout=remain)

        # 提交后有时需再点一次继续 / 或输入框恢复
        if status["submitted"]:
            time.sleep(1.0)
            if detect_age_gate():
                print("[*] 年龄门：提交后仍在，再试一次…")
                status["submitted"] = fill_age_gate_and_submit(birth_year, timeout=12)
    except Exception as e:
        print(f"[Warn] 年龄门流程异常（不影响 sso 落盘）: {e}")
        status["error"] = str(e)

    if status.get("submitted"):
        print(f"[*] 年龄门完成 | birth_year={birth_year}")
    elif status.get("age_gate_seen"):
        print(f"[Warn] 年龄门已出现但未成功提交 | birth_year={birth_year}")
    return status


def append_sso_to_txt(sso_value, output_path=DEFAULT_SSO_FILE, email="", password=""):
    # 一行：邮箱 | 密码 | sso（号池导入与导出一致）
    normalized = str(sso_value or "").strip()
    if not normalized:
        raise Exception("待写入的 sso 为空")

    email_s = str(email or "").strip()
    password_s = str(password or "").strip()
    line = f"{email_s} | {password_s} | {normalized}"

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "a", encoding="utf-8") as file:
        file.write(line + "\n")

    print(f"[*] 已追加写入 邮箱|密码|sso 到文件: {output_path}")


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


def run_single_registration(
    output_path=DEFAULT_SSO_FILE, extract_numbers=False, *, plan: str = "a"
):
    # 单轮流程：打开注册页 -> 完成注册 -> 触发生日门(可选) -> 获取 sso -> 写 txt。
    # plan="a"：本项目主流程；plan="b"：Plan B 兜底（FlowPilot 人机等待/模拟点击/CF 拦截）
    # 收码失败：换邮箱最多 max_mail_retry 次（AccountRetryNeeded），不整轮失败。
    plan_mode = "b" if str(plan or "a").lower() in ("b", "plan_b", "plan-b", "2") else "a"
    if plan_mode == "b":
        print("[plan-b] ═══ Plan B 兜底注册开始 ═══")

    max_mail_retry = 3
    try:
        import json as _json_mod
        from runtime_gc import load_max_mail_retry

        conf_mail = {}
        try:
            with open(
                os.path.join(os.path.dirname(__file__), "config.json"),
                "r",
                encoding="utf-8",
            ) as _cf:
                conf_mail = _json_mod.load(_cf) or {}
        except Exception:
            conf_mail = {}
        max_mail_retry = load_max_mail_retry(conf_mail)
    except Exception:
        max_mail_retry = 3

    email = ""
    dev_token = ""
    profile = None
    last_mail_err: Exception | None = None
    for mail_try in range(1, max_mail_retry + 1):
        try:
            if mail_try == 1:
                open_signup_page()
            else:
                print(
                    f"[*] 收码/邮箱重试 {mail_try}/{max_mail_retry} · 重新打开注册页…",
                    flush=True,
                )
                try:
                    open_signup_page()
                except Exception as oe:
                    # 已在注册页时 open 可能失败，继续填邮箱
                    print(f"[Warn] 重试开页: {oe}", flush=True)
            if plan_mode == "b" and mail_try == 1:
                try:
                    from plan_b import detect_cf_security_block, human_pause_major

                    human_pause_major(600, 1400)
                    blk = detect_cf_security_block(page)
                    if blk:
                        raise Exception(f"CF 安全拦截({blk})，Plan B 放弃")
                except Exception as e:
                    if "CF 安全拦截" in str(e):
                        raise
                    print(f"[plan-b] 开页预检跳过: {e}")
            email, dev_token = fill_email_and_submit()
            fill_code_and_submit(email, dev_token)
            print(f"[*] 填写注册资料并提交（Plan {plan_mode.upper()}）…")
            profile = fill_profile_and_submit(mode=plan_mode)
            last_mail_err = None
            break
        except AccountRetryNeeded as re:
            last_mail_err = re
            print(
                f"[*] 可换邮箱重试（{mail_try}/{max_mail_retry}）: {re}",
                flush=True,
            )
            if mail_try >= max_mail_retry:
                raise Exception(
                    f"收码失败已达 max_mail_retry={max_mail_retry}: {re}"
                ) from re
            continue
        except Exception as e:
            # 获取邮箱失败也可换邮箱重试
            msg = str(e)
            if "获取邮箱失败" in msg or "创建邮箱失败" in msg or "获取验证码失败" in msg:
                last_mail_err = e
                print(
                    f"[*] 邮箱阶段失败，换邮箱重试（{mail_try}/{max_mail_retry}）: {e}",
                    flush=True,
                )
                if mail_try >= max_mail_retry:
                    raise
                continue
            raise
    if profile is None:
        raise Exception(f"邮箱/收码阶段失败: {last_mail_err or 'unknown'}")
    # 注册完成后等浏览器跑完 SSO 重定向链落到 grok.com 并登录——grok.com 域的
    # 会话 cookie（含 cf_clearance / sso / sso-rw）此时才会真正写下来。
    if not wait_for_grok_com_landing():
        print("[Warn] 未能落到 grok.com 登录态，sso 质量可能受影响")

    # 发随机英文短消息触发生日/年龄确认弹窗，并自动填随机成年出生年（失败不阻断写 sso）
    age_status = ensure_age_gate_completed(timeout=45)

    sso_value = wait_for_sso_cookie()
    password = str(profile.get("password", "") or "")
    if isinstance(profile, dict):
        profile = {**profile, "plan": plan_mode}

    # W3 · SSO 指纹账本去重（重复不算成功，不入队、不占目标）
    if sso_value:
        try:
            from sso_ledger import claim_sso

            claim = claim_sso(sso_value, email=email)
            if claim.get("duplicate"):
                print(
                    f"[sso-ledger] ✘ 重复 SSO 指纹={str(claim.get('fingerprint') or '')[:12]}… "
                    f"first_email={claim.get('email') or '-'} count={claim.get('count')}",
                    flush=True,
                )
                raise AccountRetryNeeded(
                    f"duplicate SSO fingerprint {str(claim.get('fingerprint') or '')[:16]}"
                )
            if claim.get("ok"):
                print(
                    f"[sso-ledger] ✔ 新指纹={str(claim.get('fingerprint') or '')[:12]}…",
                    flush=True,
                )
        except AccountRetryNeeded:
            raise
        except Exception as le:
            print(f"[Warn] sso ledger: {le}", flush=True)

    # ZDR：导出 SSO 前尽力关闭（enable_disable_zdr 默认 true；失败不挡）
    if sso_value:
        try:
            import json as _json

            _cfg_z = {}
            try:
                _cp = os.path.join(os.path.dirname(__file__), "config.json")
                with open(_cp, "r", encoding="utf-8") as _f:
                    _cfg_z = _json.load(_f) or {}
            except Exception:
                _cfg_z = {}
            _zdr_on = _cfg_z.get("enable_disable_zdr")
            if _zdr_on is None:
                _zdr_on = _cfg_z.get("enableDisableZdr")
            # 默认开启（规格 A1）：仅当显式 false/0/off 时跳过
            if _zdr_on is None:
                _do_zdr = True
            else:
                _do_zdr = str(_zdr_on).strip().lower() not in (
                    "0",
                    "false",
                    "no",
                    "off",
                    "",
                )
            if _do_zdr:
                from zdr_toggle import disable_zdr_for_sso
                from account_tags import set_zdr_tag

                _proxy_z = ""
                try:
                    _proxy_z = next_proxy(_browser_proxy) or _browser_proxy or ""
                except Exception:
                    _proxy_z = _browser_proxy or ""
                _cf_z = ""
                try:
                    if page is not None:
                        for c in list(page.cookies() or []):
                            if isinstance(c, dict):
                                n = str(c.get("name") or "").lower()
                                if n == "cf_clearance":
                                    _cf_z = str(c.get("value") or "").strip()
                                    break
                except Exception:
                    pass
                _zr = disable_zdr_for_sso(
                    sso_value,
                    cf_clearance=_cf_z,
                    proxy=_proxy_z,
                    log=lambda m: print(m, flush=True),
                )
                _closed = bool(_zr.get("ok"))
                set_zdr_tag(
                    closed=_closed,
                    email=email or "",
                    sso=sso_value,
                    error=str(_zr.get("error") or ""),
                    steps=_zr.get("steps"),
                )
                if _closed:
                    print(f"[zdr] ✔ ZDR 已关 · {_zr.get('message')}", flush=True)
                else:
                    print(
                        f"[zdr] ✘ ZDR 仍开/未知（继续导出 SSO）: {_zr.get('error')}",
                        flush=True,
                    )
        except Exception as _ze:
            print(f"[Warn] zdr disable: {_ze}", flush=True)
            try:
                from account_tags import set_zdr_tag

                set_zdr_tag(
                    closed=False,
                    email=email or "",
                    sso=sso_value or "",
                    error=str(_ze)[:300],
                )
            except Exception:
                pass

    append_sso_to_txt(sso_value, output_path, email=email, password=password)

    # W2 · 捕获 CF 上下文供下一轮复用
    try:
        from cf_context import capture_cloudflare_context

        capture_cloudflare_context(
            page,
            browser,
            source="post_register",
            log=lambda m: print(m, flush=True),
        )
    except Exception as cfe:
        print(f"[Warn] cf capture: {cfe}", flush=True)

    # 授权流水线全部移交后台队列：SSO 推送 / Auth 转换 / Auth 推送
    # 注册主流程只落盘 SSO，不阻塞下一轮
    auth_status = {"attempted": False, "ok": False, "queued": False}
    grok2api_status = {"attempted": False, "ok": False, "queued": False}
    if sso_value:
        try:
            proxy_for_auth = ""
            try:
                proxy_for_auth = next_proxy(_browser_proxy) or _browser_proxy or ""
            except Exception:
                proxy_for_auth = _browser_proxy or ""

            # 浏览器 UA / CF cookie 随任务带走（队列 SSO→g2 / NSFW 用）
            # #9：稳定提取 cf_clearance（多域、多 API、document.cookie 兜底）
            ua_hint = ""
            cf_hint = ""
            try:
                if page is not None:
                    try:
                        ua_hint = str(page.run_js("return navigator.userAgent") or "")
                    except Exception:
                        pass
                    cf_map: dict[str, str] = {}
                    want = ("cf_clearance", "__cf_bm", "sso-rw", "sso")

                    def _ingest(name: str, value: str) -> None:
                        n = str(name or "").strip()
                        v = str(value or "").strip()
                        if not n or not v:
                            return
                        key = n.lower()
                        if key in want and key not in cf_map:
                            cf_map[key] = f"{n}={v}"

                    # 1) page.cookies() 各种形态
                    try:
                        cookies = page.cookies()
                        if isinstance(cookies, dict):
                            for k, v in cookies.items():
                                _ingest(str(k), str(v))
                        else:
                            for c in list(cookies or []):
                                if isinstance(c, dict):
                                    _ingest(
                                        str(c.get("name") or c.get("Name") or ""),
                                        str(c.get("value") or c.get("Value") or ""),
                                    )
                    except Exception:
                        pass
                    # 2) browser / tab cookies 再扫（Drission 不同版本）
                    try:
                        br = getattr(page, "browser", None) or browser
                        if br is not None:
                            for getter in (
                                lambda: br.cookies(),
                                lambda: br.get_cookies(),
                                lambda: page.get_cookies(),
                            ):
                                try:
                                    raw = getter()
                                except Exception:
                                    continue
                                if isinstance(raw, dict):
                                    for k, v in raw.items():
                                        _ingest(str(k), str(v))
                                elif isinstance(raw, list):
                                    for c in raw:
                                        if isinstance(c, dict):
                                            _ingest(
                                                str(c.get("name") or ""),
                                                str(c.get("value") or ""),
                                            )
                    except Exception:
                        pass
                    # 3) document.cookie 兜底（当前域）
                    try:
                        doc_ck = str(
                            page.run_js("return document.cookie || ''") or ""
                        )
                        for part in doc_ck.split(";"):
                            part = part.strip()
                            if "=" not in part:
                                continue
                            n, v = part.split("=", 1)
                            _ingest(n, v)
                    except Exception:
                        pass
                    # 优先顺序输出：cf_clearance 必须在前
                    ordered = []
                    for k in want:
                        if k in cf_map:
                            ordered.append(cf_map[k])
                    cf_hint = "; ".join(ordered)
                    if "cf_clearance=" in cf_hint.lower():
                        print(
                            f"[*] 入队 CF cookie 已提取 len={len(cf_hint)} "
                            f"（含 cf_clearance）",
                            flush=True,
                        )
                    else:
                        print(
                            "[Warn] 入队未拿到 cf_clearance（NSFW/g2 可能被 CF 拦）",
                            flush=True,
                        )
            except Exception:
                pass

            from auth_export_queue import enqueue_authorization

            mint_mode = ""
            try:
                with open(
                    os.path.join(os.path.dirname(__file__), "config.json"),
                    "r",
                    encoding="utf-8",
                ) as _mf:
                    mint_mode = str(_json_mod.load(_mf).get("cpa_mint_mode") or "").strip()
            except Exception:
                mint_mode = ""

            q = enqueue_authorization(
                sso=sso_value,
                email=email,
                password=password,
                proxy=proxy_for_auth,
                mint_mode=mint_mode,
                user_agent=ua_hint,
                cloudflare_cookies=cf_hint,
                log=lambda m: print(m, flush=True),
            )
            flags = q.get("flags") or {}
            auth_status = {
                "attempted": bool(flags.get("auto_auth")),
                "ok": bool(q.get("queued") or q.get("skipped")),
                "queued": bool(q.get("queued")),
                "delay_sec": q.get("delay_sec"),
                "pending": q.get("pending"),
                "mint_mode": q.get("mint_mode"),
                "error": q.get("error"),
            }
            grok2api_status = {
                "attempted": bool(flags.get("sso_g2")),
                "ok": bool(q.get("queued") or q.get("skipped")),
                "queued": bool(q.get("queued")),
                "deferred": True,
            }
            if q.get("queued"):
                print(
                    f"[*] 授权已入队后台 · {q.get('delay_sec')}s 后执行"
                    f"（SSO推送/Auth转换/Auth推送）· email={email or '-'}",
                    flush=True,
                )
            elif q.get("skipped"):
                print(
                    f"[*] 授权未入队（自动转换与 SSO 推送均关）· email={email or '-'}",
                    flush=True,
                )
            else:
                print(f"[Warn] 授权入队失败: {q.get('error')}", flush=True)
                auth_status["ok"] = False
                grok2api_status["ok"] = False
        except Exception as e:
            print(f"[Warn] 授权入队异常（不影响 sso 落盘）: {e}", flush=True)
            auth_status = {"attempted": True, "ok": False, "queued": False, "error": str(e)}
            grok2api_status = {"attempted": False, "ok": False, "error": str(e)[:200]}

    if extract_numbers:
        extract_visible_numbers()

    result = {
        "email": email,
        "sso": sso_value,
        "age_gate": age_status,
        "auth": auth_status,
        "grok2api": grok2api_status,
        **profile,
    }

    if run_logger:
        run_logger.info(
            "注册成功 | email=%s | password=%s | given=%s | family=%s | age_year=%s | age_ok=%s",
            email,
            profile.get("password", ""),
            profile.get("given_name", ""),
            profile.get("family_name", ""),
            age_status.get("birth_year"),
            age_status.get("submitted"),
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
    # logger 就绪后再打一次环境摘要，确保 WebUI/日志文件都能看到（不依赖模块 import 时的 print）
    _emit(
        f"[*] 运行环境: system={platform.system()} machine={platform.machine()} "
        f"python={platform.python_version()} DISPLAY={os.environ.get('DISPLAY', '')!r} "
        f"window={_WINDOW_W}x{_WINDOW_H} headless=False"
    )
    _emit(f"[*] 浏览器版本(启动前): {_probe_browser_version()}")
    print("", flush=True)
    print("══════════════════════════════════════", flush=True)
    print("  Grok 注册机启动", flush=True)
    print(f"  计划轮数: {total}", flush=True)
    print(f"  SSO 输出: {args.output}", flush=True)
    print("══════════════════════════════════════", flush=True)

    # 代理诊断：行首 [proxy] 保证 WebUI 不过滤；开了代理却无节点则停，避免静默直连
    try:
        def _mask_proxy_url(u: str) -> str:
            u = str(u or "").strip()
            if not u:
                return ""
            try:
                if parse_proxy_url:
                    p = parse_proxy_url(u)
                    if p and p.get("has_auth"):
                        return (
                            f"{p.get('scheme')}://{str(p.get('username') or '')[:8]}…:***"
                            f"@{p.get('host')}:{p.get('port')}"
                        )
                    if p:
                        return f"{p.get('scheme')}://{p.get('host')}:{p.get('port')}"
            except Exception:
                pass
            return u.split("@")[-1] if "@" in u else u[:48]

        _cfgp = os.path.join(os.path.dirname(__file__), "config.json")
        _c0 = {}
        if os.path.isfile(_cfgp):
            import json as _j0

            with open(_cfgp, "r", encoding="utf-8") as _f0:
                _c0 = _j0.load(_f0) or {}
        def _flag_on_cfg(v, default=False):
            if isinstance(v, bool):
                return v
            if v is None:
                return default
            s = str(v).strip().lower()
            if s in ("1", "true", "yes", "on", "enabled"):
                return True
            if s in ("0", "false", "no", "off", "disabled", ""):
                return False
            return default

        # 不依赖未导入的 proxy_enabled/load_proxy_pool；直接读 config.json
        _cf0 = _flag_on_cfg(_c0.get("cf_proxy_enabled"), False)
        _pe0 = _cf0 or _flag_on_cfg(_c0.get("proxy_enabled"), False)
        _pool_sw0 = (not _cf0) and _flag_on_cfg(_c0.get("proxy_pool_enabled"), False)
        _pool_raw = _c0.get("proxy_pool")
        if isinstance(_pool_raw, list):
            _pool_n0 = len([x for x in _pool_raw if str(x or "").strip()])
        elif isinstance(_pool_raw, str):
            _pool_n0 = len(
                [
                    ln
                    for ln in _pool_raw.splitlines()
                    if ln.strip() and not ln.strip().startswith("#")
                ]
            )
        else:
            _pool_n0 = 0
        _px0 = str(_c0.get("proxy") or "").strip()
        _bpx0 = str(_c0.get("browser_proxy") or "").strip()
        _diag0 = _c0.get("_proxy_diag") if isinstance(_c0.get("_proxy_diag"), dict) else {}
        if _diag0:
            print(
                f"[proxy] writeConfig mode={_diag0.get('mode')} "
                f"enabled={_diag0.get('proxy_enabled')} pool_n={_diag0.get('pool_n')} "
                f"single={_diag0.get('has_proxy')} browser={_diag0.get('has_browser_proxy')}"
                + (" auto_pool_fallback=1" if _diag0.get("auto_pool_fallback") else ""),
                flush=True,
            )
        if _cf0:
            print(
                f"[proxy] 模式=CF独立 local={_mask_proxy_url(_px0 or _bpx0) or '-'} "
                f"domain={_c0.get('cf_proxy_domain') or '-'} → set_proxy 本地 cfwp",
                flush=True,
            )
        elif not _pe0:
            print(
                "[proxy] 模式=直连 (proxy_enabled=false)。"
                "若界面勾了代理仍见此行：请保存设置后重新启动注册。",
                flush=True,
            )
        elif _pool_sw0 or _pool_n0 > 0:
            print(
                f"[proxy] 模式=代理池 switch={_pool_sw0} 可用={_pool_n0} 条 "
                f"→ 每轮 acquire/next_proxy",
                flush=True,
            )
            if _pool_n0 <= 0:
                print(
                    "[proxy][!] 代理池已开但可用 IP=0 → 停止，避免误直连。"
                    "请导入可用池或关闭「使用代理池」并填单条。",
                    flush=True,
                )
                raise SystemExit(2)
        elif _px0 or _bpx0:
            print(
                f"[proxy] 模式=单条 proxy={_mask_proxy_url(_px0) or '-'} "
                f"browser_proxy={_mask_proxy_url(_bpx0) or '-'} → set_proxy/本地转发",
                flush=True,
            )
        else:
            print(
                "[proxy][!] 已启用代理，但 config 无 proxy / browser_proxy / proxy_pool。"
                "停止注册，避免误直连。请填写单条或导入可用池后保存再启动。",
                flush=True,
            )
            raise SystemExit(2)
    except SystemExit:
        raise
    except Exception as _pe_log:
        print(f"[proxy][!] 代理模式摘要失败: {_pe_log}", flush=True)

    current_round = 0
    success_count = 0
    fail_count = 0
    collected_sso: list = []
    recycle_every = 5
    try:
        import json as _json_mod
        from runtime_gc import load_recycle_every, cleanup_runtime_memory, clear_temp_profiles

        conf_rt = {}
        try:
            with open(
                os.path.join(os.path.dirname(__file__), "config.json"),
                "r",
                encoding="utf-8",
            ) as _rf:
                conf_rt = _json_mod.load(_rf) or {}
        except Exception:
            conf_rt = {}
        recycle_every = load_recycle_every(conf_rt)
        try:
            # 启动自检：quiet 仅 FAIL 才输出（不刷 PASS 列表）
            from optimization_checks import main as _opt_main

            _code = _opt_main(quiet=True)
            if _code != 0:
                print("[Warn] 自检有 FAIL 项，继续运行", flush=True)
        except Exception as oe:
            print(f"[Warn] 自检跳过: {oe}", flush=True)
        try:
            from tab_pool import TabPool

            TabPool.init(_new_chromium_options, log_callback=None)
        except Exception as te:
            print(f"[Warn] TabPool 初始化跳过: {te}", flush=True)
        # 启动 GC / 清临时：成功静默，失败才打日志
        cleanup_runtime_memory(
            log=lambda m: print(m, flush=True), force=True, silent_ok=True
        )
        clear_temp_profiles(log=None)
    except Exception as ge:
        print(f"[Warn] runtime_gc 初始化: {ge}", flush=True)

    # 代理池模式：可用池无 IP → 直接停止（不进入注册循环）
    try:
        import json as _j_pool_guard

        def _flag_on(raw, default=True) -> bool:
            if raw is None:
                return bool(default)
            if isinstance(raw, bool):
                return raw
            s = str(raw).strip().lower()
            if s in ("0", "false", "no", "off", "disabled"):
                return False
            if s in ("1", "true", "yes", "on", "enabled"):
                return True
            return bool(default)

        _cfg_path = os.path.join(os.path.dirname(__file__), "config.json")
        _cg = {}
        if os.path.isfile(_cfg_path):
            with open(_cfg_path, "r", encoding="utf-8") as _fg:
                _cg = _j_pool_guard.load(_fg) or {}
        _master = _flag_on(_cg.get("proxy_enabled"), True)
        # 必须显式开池（writeConfig 在 UI 开「使用代理池」时写 true）
        _pool_on = _flag_on(_cg.get("proxy_pool_enabled"), False)
        if _master and _pool_on:
            _pp = _cg.get("proxy_pool") or _cg.get("proxies") or []
            if not isinstance(_pp, list):
                _pp = [_pp] if _pp else []
            _alive = [
                str(x).strip()
                for x in _pp
                if str(x or "").strip() and not str(x).strip().startswith("#")
            ]
            if not _alive:
                print(
                    "[Stop] 代理池模式已开启，但可用池内无代理 IP。"
                    "请先测活迁入可用池，或关闭「使用代理池」/「启用代理」。",
                    flush=True,
                )
                raise SystemExit(2)
    except SystemExit:
        raise
    except Exception as _pg_e:
        print(f"[Warn] 可用池检查跳过: {_pg_e}", flush=True)

    force_browser_recycle = True  # 首轮必须新起浏览器
    try:
        while True:
            if args.count > 0 and current_round >= args.count:
                break

            current_round += 1
            print(f"")
            # 首轮 / 失败后 / 每 N 成功：完整 quit+restart；否则 clear_session 复用进程
            do_full_restart = force_browser_recycle or browser is None
            if do_full_restart:
                try:
                    from cf_context import clear_thread_cf_context

                    # 完整重启浏览器后 CF 与 TLS/IP 失效，丢弃
                    clear_thread_cf_context()
                except Exception:
                    pass
                try:
                    stop_browser()
                except Exception:
                    pass
                try:
                    from tab_pool import TabPool

                    TabPool.release_tab()
                except Exception:
                    pass
                start_browser()
                force_browser_recycle = False
            else:
                # W2 · 复用：清身份 + 恢复 CF（不清掉 cf_clearance）
                cleared = False
                try:
                    from cf_context import clear_identity_keep_cf, clear_thread_cf_context

                    if page is not None:
                        cleared = clear_identity_keep_cf(
                            page,
                            browser,
                            log=lambda m: print(m, flush=True),
                        )
                    try:
                        from tab_pool import TabPool

                        # TabPool 全清 cookie 后立刻 restore 线程内 CF
                        TabPool.clear_session()
                        try:
                            from cf_context import restore_cloudflare_context

                            restore_cloudflare_context(
                                page, log=lambda m: print(m, flush=True)
                            )
                        except Exception:
                            pass
                    except Exception:
                        pass
                    if cleared:
                        print("[*] 浏览器会话已清理（复用进程，已保 CF）", flush=True)
                except Exception as ce:
                    print(f"[Warn] clear_session 失败，改为重启: {ce}", flush=True)
                    cleared = False
                    try:
                        from cf_context import clear_thread_cf_context

                        clear_thread_cf_context()
                    except Exception:
                        pass
                if not cleared:
                    try:
                        from cf_context import clear_thread_cf_context

                        clear_thread_cf_context()
                    except Exception:
                        pass
                    try:
                        stop_browser()
                    except Exception:
                        pass
                    start_browser()
            # start_browser 内已打指纹；仅首轮详打一次（避免双份）
            log_runtime_fingerprint(page, force=False)
            # 不打印「本轮代理」（省日志；代理异常时仍有降级/切换行）
            print(
                f"─── 第 {current_round}/{total} 轮 ────────────────────────"
                f"（recycle_every={recycle_every} restart={do_full_restart}）"
            )

            # 注册方案：Plan A/B/C 可单独开关；已开则按 A→B→C 顺序兜底
            try:
                from plan_b import (
                    load_plan_a_enabled_from_config,
                    load_plan_b_enabled_from_config,
                    load_plan_c_enabled_from_config,
                )

                plan_a_enabled = load_plan_a_enabled_from_config()
                plan_b_enabled = load_plan_b_enabled_from_config()
                plan_c_enabled = load_plan_c_enabled_from_config()
            except Exception:
                plan_a_enabled = True
                plan_b_enabled = True
                plan_c_enabled = False

            used_plan = ""
            result = None
            last_err: Exception | None = None
            err_parts: list[str] = []

            if not (plan_a_enabled or plan_b_enabled or plan_c_enabled):
                fail_count += 1
                print(
                    f"✘ 第 {current_round} 轮跳过：注册方案 A/B/C 均已关闭，请在「注册方案」中至少开启一项"
                )
                if args.count == 0 or current_round < args.count:
                    time.sleep(0.5)
                continue

            print(
                f"[plan] 本轮启用: "
                f"A={'开' if plan_a_enabled else '关'} "
                f"B={'开' if plan_b_enabled else '关'} "
                f"C={'开' if plan_c_enabled else '关'}（顺序 A→B→C）"
            )

            def _is_hard_proxy_fail(err: BaseException | str | None) -> bool:
                """A 因代理/网络硬失败时，B 拟人兜底无意义（同一坏链路）。"""
                s = str(err or "").lower()
                keys = (
                    "chrome-error",
                    "chromewebdata",
                    "can't be reached",
                    "can’t be reached",
                    "代理/网络不可达",
                    "代理/隧道错误",
                    "注册页无法访问",
                    "连续硬失败",
                    "err_proxy",
                    "err_tunnel",
                    "err_connection",
                    "err_timed_out",
                    "err_name_not_resolved",
                )
                return any(k in s for k in keys)

            # ---------- Plan A ----------
            if result is None and plan_a_enabled:
                try:
                    print("[plan-a] 浏览器主流程…")
                    result = run_single_registration(
                        args.output, extract_numbers=args.extract_numbers, plan="a"
                    )
                    used_plan = "a"
                except KeyboardInterrupt:
                    print("")
                    print("[Info] 收到中断信号，停止后续轮次。")
                    break
                except AccountRetryNeeded as e:
                    # 含 W3 重复 SSO：不记成功，可换号继续（不占成功配额）
                    last_err = e
                    err_parts.append(f"A:retry:{str(e)[:50]}")
                    print(f"[plan-a] ⟳ 可重试: {e}")
                except Exception as e:
                    last_err = e
                    err_parts.append(f"A:{str(e)[:60]}")
                    print(f"[plan-a] ✘ 失败: {e}")

            # ---------- Plan B ----------
            # 硬代理失败跳过 B：换代理已在 open_signup 内做，拟人无法打通 can't be reached
            skip_b_hard = result is None and plan_b_enabled and _is_hard_proxy_fail(last_err)
            if skip_b_hard:
                print(
                    "[plan-b] 跳过：Plan A 为代理/网络硬失败（chrome-error），"
                    "拟人兜底无效；已/将降级代理后进入下一方案或下一轮",
                    flush=True,
                )
                err_parts.append("B:skipped_hard_proxy")

            if result is None and plan_b_enabled and not skip_b_hard:
                try:
                    print("[plan-b] 拟人兜底…")
                    try:
                        stop_browser()
                    except Exception:
                        pass
                    time.sleep(0.5 + secrets.randbelow(40) / 100.0)
                    start_browser()
                    log_runtime_fingerprint(page, force=False)
                    result = run_single_registration(
                        args.output,
                        extract_numbers=args.extract_numbers,
                        plan="b",
                    )
                    used_plan = "b"
                except KeyboardInterrupt:
                    print("")
                    print("[Info] 收到中断信号，停止后续轮次。")
                    break
                except Exception as e:
                    last_err = e
                    err_parts.append(f"B:{str(e)[:60]}")
                    print(f"[plan-b] ✘ 失败: {e}")

            # ---------- Plan C (hybrid) ----------
            if result is None and plan_c_enabled:
                try:
                    from hybrid_register import run_hybrid_registration

                    print("[plan-c] Hybrid 协议…")
                    hy = run_hybrid_registration(
                        args.output, extract_numbers=args.extract_numbers
                    )
                    if hy and hy.get("sso"):
                        result = hy
                        used_plan = "c"
                    else:
                        msg = "hybrid 未返回 sso"
                        err_parts.append(f"C:{msg}")
                        print(f"[plan-c] ✘ {msg}")
                except KeyboardInterrupt:
                    print("")
                    print("[Info] 收到中断信号，停止后续轮次。")
                    break
                except Exception as e:
                    last_err = e
                    err_parts.append(f"C:{str(e)[:60]}")
                    print(f"[plan-c] ✘ 失败: {e}")

            if result is None:
                fail_count += 1
                detail = " | ".join(err_parts) if err_parts else str(last_err or "全部方案失败")
                print(f"✘ 第 {current_round} 轮失败/跳过（{detail}）")
                try:
                    from pools import demote_proxy_to_pending

                    if _browser_proxy:
                        demote_proxy_to_pending(
                            _browser_proxy,
                            reason=f"注册失败:{detail[:40]}",
                        )
                except Exception as de:
                    print(f"[Warn] 失败降级回调异常: {de}")
            else:
                collected_sso.append(result["sso"])
                success_count += 1
                tag = (
                    "Plan C"
                    if used_plan == "c"
                    else ("Plan B" if used_plan == "b" else "Plan A")
                )
                # 邮箱已在「注册成功 | email=…」行输出，此处不再重复
                print(f"✔ 第 {current_round} 轮成功（{tag}）")
                try:
                    from pools import bump_proxy_register_success

                    if _browser_proxy:
                        bump_proxy_register_success(_browser_proxy, delta=1)
                except Exception as be:
                    print(f"[Warn] 代理成功计数回调异常: {be}")
                # P2/3：成功后 GC；每 N 成功强制下轮重启浏览器
                try:
                    from runtime_gc import on_register_success

                    gr = on_register_success(
                        recycle_every=recycle_every,
                        log=lambda m: print(m, flush=True),
                    )
                    if gr.get("need_browser_recycle"):
                        force_browser_recycle = True
                        print(
                            f"[gc] 下轮将强制重启浏览器（成功累计达 recycle_every={recycle_every}）",
                            flush=True,
                        )
                except Exception as ge:
                    print(f"[Warn] GC 回调: {ge}", flush=True)

            if result is None:
                # 失败也做轻量 GC，下轮重启浏览器
                force_browser_recycle = True
                try:
                    from runtime_gc import cleanup_runtime_memory

                    cleanup_runtime_memory(
                        log=lambda m: print(m, flush=True), force=False
                    )
                except Exception:
                    pass

            if args.count == 0 or current_round < args.count:
                time.sleep(0.5)

    finally:
        stop_browser()
        # 后台 SSO→Auth 队列：等待已入队任务完成（含延迟），避免进程退出丢任务
        try:
            from auth_export_queue import queue_stats, wait_queue_idle

            st = queue_stats()
            if st.get("pending", 0) > 0 or st.get("queue_size", 0) > 0:
                # 最长等 delay_max + mint 余量（默认约 3 分钟量级；可配置更长）
                try:
                    from auth_export_queue import load_delay_range

                    _lo, _hi = load_delay_range()
                    wait_cap = float(_hi) + 180.0
                except Exception:
                    wait_cap = 300.0
                print(
                    f"[auth-queue] 注册结束，等待后台转换队列"
                    f"（pending≈{st.get('pending')} · 最长 {wait_cap:.0f}s）…",
                    flush=True,
                )
                ok = wait_queue_idle(timeout=wait_cap)
                st2 = queue_stats()
                print(
                    f"[auth-queue] 队列{'已清空' if ok else '超时仍有剩余'}"
                    f" · ok={st2.get('done_ok')} fail={st2.get('done_fail')}"
                    f" pending≈{st2.get('pending')}",
                    flush=True,
                )
        except Exception as qe:
            print(f"[Warn] 等待 auth 队列异常: {qe}", flush=True)
        print(f"")
        print(f"══════════════════════════════════════")
        print(f"  注册机运行结束")
        print(f"成功: {success_count}  失败: {fail_count}  共计: {current_round}")
        if collected_sso:
            print(f"  SSO 已保存到: {args.output}")
        print(f"══════════════════════════════════════")


if __name__ == "__main__":
    main()
