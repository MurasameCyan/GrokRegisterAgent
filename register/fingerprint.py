"""注册浏览器随机特征（UA / 语言 / 时区 / 平台）。

每轮注册调用 build_fingerprint() 得到一份配置，再 apply_to_options / inject_stealth。
"""
from __future__ import annotations

import random
import secrets
from dataclasses import dataclass, asdict
from typing import Any


# 贴近当前主流桌面 Chrome（仍随机，避免全员同一大版本）
# 有限规避：版本池越新越贴近真实用户分布；仍无保证不被 bot 模型命中
# 注意：UA 大版本应尽量贴近真实 Chromium（见 build_fingerprint(chrome_major=…)）
_CHROME_VERS = [128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150]


@dataclass
class BrowserFingerprint:
    user_agent: str
    platform: str  # Win32 / MacIntel / Linux x86_64
    languages: list[str]
    accept_lang: str
    timezone: str
    locale: str
    hardware_concurrency: int
    device_memory: int
    max_touch_points: int
    window_w: int
    window_h: int
    # WebGL 伪装（stealth 用；无保证）
    webgl_vendor: str = "Google Inc. (NVIDIA)"
    webgl_renderer: str = "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)"

    def to_dict(self) -> dict:
        return asdict(self)


_TZ_POOL = [
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Toronto",
    "America/Phoenix",
    "Europe/London",
    "Europe/Berlin",
    "Europe/Paris",
    "Europe/Amsterdam",
    "Asia/Singapore",
    "Asia/Tokyo",
    "Asia/Hong_Kong",
    "Australia/Sydney",
    "Pacific/Auckland",
]

_LANG_POOL = [
    (["en-US", "en"], "en-US,en;q=0.9"),
    (["en-GB", "en"], "en-GB,en;q=0.9"),
    (["en-US", "en", "es"], "en-US,en;q=0.9,es;q=0.8"),
    (["en-CA", "en"], "en-CA,en;q=0.9"),
    (["en-AU", "en"], "en-AU,en;q=0.9"),
]

# 常见桌面 GPU 字符串（仅降低「全员同一 WebGL」；无法对抗服务端 bot_flag 签发）
_WEBGL_POOL = [
    (
        "Google Inc. (NVIDIA)",
        "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    ),
    (
        "Google Inc. (NVIDIA)",
        "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    ),
    (
        "Google Inc. (Intel)",
        "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    ),
    (
        "Google Inc. (Intel)",
        "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
    ),
    (
        "Google Inc. (AMD)",
        "ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)",
    ),
    (
        "Google Inc. (Apple)",
        "ANGLE (Apple, Apple M1, OpenGL 4.1)",
    ),
]


def _chrome_ua(platform_token: str, chrome_major: int) -> str:
    return (
        f"Mozilla/5.0 ({platform_token}) AppleWebKit/537.36 "
        f"(KHTML, like Gecko) Chrome/{chrome_major}.0.0.0 Safari/537.36"
    )


def build_fingerprint(
    seed: str | None = None,
    *,
    chrome_major: int | None = None,
    prefer_native_os: bool = True,
) -> BrowserFingerprint:
    """生成浏览器指纹。

    chrome_major: 若传入真实 Chromium 大版本，UA 将使用该版本（±0~1 微调），
    避免「二进制 150 + UA 137」被 Turnstile 直接判定异常。
    prefer_native_os: Linux 容器上提高 Linux UA 权重，减少 Win/Mac 错配。
    """
    import platform as _plat

    rnd = random.Random(seed) if seed else random.Random(secrets.randbits(64))
    if chrome_major and 80 <= int(chrome_major) <= 200:
        # 贴近真实版本：多数用精确 major，少数 ±1（仍在合理范围）
        base = int(chrome_major)
        jitter = rnd.choice([0, 0, 0, 0, 1, -1])
        chrome = max(100, base + jitter)
    else:
        chrome = rnd.choice(_CHROME_VERS)

    sys_name = (_plat.system() or "").lower()
    if prefer_native_os and sys_name == "linux":
        # 容器多为 Linux：70% Linux / 25% Win / 5% Mac（Mac 在 Linux 上最易穿帮）
        r = rnd.random()
        if r < 0.70:
            choice = 2
        elif r < 0.95:
            choice = 0
        else:
            choice = 1
    elif prefer_native_os and sys_name == "windows":
        r = rnd.random()
        choice = 0 if r < 0.80 else (1 if r < 0.90 else 2)
    elif prefer_native_os and sys_name == "darwin":
        r = rnd.random()
        choice = 1 if r < 0.80 else (0 if r < 0.95 else 2)
    else:
        choice = rnd.randrange(3)

    if choice == 0:
        # Windows
        platform = "Win32"
        token = "Windows NT 10.0; Win64; x64"
        max_touch = 0
    elif choice == 1:
        platform = "MacIntel"
        token = "Macintosh; Intel Mac OS X 10_15_7"
        max_touch = 0
    else:
        platform = "Linux x86_64"
        token = "X11; Linux x86_64"
        max_touch = 0

    langs, accept = rnd.choice(_LANG_POOL)
    tz = rnd.choice(_TZ_POOL)
    # 常见分辨率（含 Xvfb 常用）
    sizes = [
        (1920, 1080),
        (1680, 1050),
        (1600, 900),
        (1536, 864),
        (1440, 900),
        (1366, 768),
        (1280, 720),
        (2560, 1440),
    ]
    w, h = rnd.choice(sizes)
    # 平台与 WebGL 串尽量一致，避免 Linux+Apple / Win+Apple 等明显错配
    if platform == "MacIntel":
        mac_pool = [x for x in _WEBGL_POOL if "Apple" in x[0] or "Intel" in x[0]]
        wv, wr = rnd.choice(mac_pool or _WEBGL_POOL)
    else:
        non_apple = [x for x in _WEBGL_POOL if "Apple" not in x[0]]
        wv, wr = rnd.choice(non_apple or _WEBGL_POOL)
    return BrowserFingerprint(
        user_agent=_chrome_ua(token, chrome),
        platform=platform,
        languages=list(langs),
        accept_lang=accept,
        timezone=tz,
        locale=langs[0],
        hardware_concurrency=rnd.choice([4, 6, 8, 12, 16]),
        device_memory=rnd.choice([4, 8, 16]),
        max_touch_points=max_touch,
        window_w=w,
        window_h=h,
        webgl_vendor=wv,
        webgl_renderer=wr,
    )


def apply_to_chromium_options(co: Any, fp: BrowserFingerprint) -> None:
    """写入 ChromiumOptions（DrissionPage）。"""
    try:
        co.set_user_agent(fp.user_agent)
    except Exception:
        try:
            co.set_argument(f"--user-agent={fp.user_agent}")
        except Exception:
            pass
    try:
        co.set_argument(f"--window-size={fp.window_w},{fp.window_h}")
        co.set_argument(f"--lang={fp.locale}")
        co.set_argument(f"--accept-lang={fp.accept_lang}")
    except Exception:
        pass


def stealth_js(fp: BrowserFingerprint) -> str:
    """返回注入页面的 stealth JS（有限规避，无法改服务端 bot_flag_source）。"""
    langs_js = json_dumps(fp.languages)
    return f"""
(() => {{
  try {{
    Object.defineProperty(navigator, 'webdriver', {{ get: () => undefined }});
  }} catch (e) {{}}
  try {{
    if (!window.chrome) window.chrome = {{ runtime: {{}}, loadTimes: function() {{}}, csi: function() {{}}, app: {{}} }};
    else {{
      try {{ if (!window.chrome.runtime) window.chrome.runtime = {{}}; }} catch (e) {{}}
    }}
  }} catch (e) {{}}
  try {{
    Object.defineProperty(navigator, 'languages', {{ get: () => {langs_js} }});
  }} catch (e) {{}}
  try {{
    Object.defineProperty(navigator, 'language', {{ get: () => {json_dumps(fp.locale)} }});
  }} catch (e) {{}}
  try {{
    Object.defineProperty(navigator, 'platform', {{ get: () => {json_dumps(fp.platform)} }});
  }} catch (e) {{}}
  try {{
    Object.defineProperty(navigator, 'hardwareConcurrency', {{ get: () => {fp.hardware_concurrency} }});
  }} catch (e) {{}}
  try {{
    Object.defineProperty(navigator, 'deviceMemory', {{ get: () => {fp.device_memory} }});
  }} catch (e) {{}}
  try {{
    Object.defineProperty(navigator, 'maxTouchPoints', {{ get: () => {fp.max_touch_points} }});
  }} catch (e) {{}}
  try {{
    // 伪造 plugins 长度，避免 headless 常见 empty plugins
    const fakePlugins = {{
      length: 5,
      item: function(i) {{ return this[i] || null; }},
      namedItem: function() {{ return null; }},
      refresh: function() {{}},
      0: {{ name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }},
      1: {{ name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' }},
      2: {{ name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }},
    }};
    Object.defineProperty(navigator, 'plugins', {{ get: () => fakePlugins }});
  }} catch (e) {{}}
  try {{
    const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (originalQuery) {{
      window.navigator.permissions.query = (parameters) => (
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({{ state: Notification.permission }})
          : originalQuery.call(window.navigator.permissions, parameters)
      );
    }}
  }} catch (e) {{}}
  try {{
    const tz = {json_dumps(fp.timezone)};
    const orig = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function () {{
      const r = orig.apply(this, arguments);
      try {{ r.timeZone = tz; }} catch (e) {{}}
      return r;
    }};
  }} catch (e) {{}}
  try {{
    // WebGL vendor/renderer 伪装（降低全员同 GPU 串；不保证）
    const vendor = {json_dumps(fp.webgl_vendor)};
    const renderer = {json_dumps(fp.webgl_renderer)};
    const patchGetParam = (proto) => {{
      if (!proto || !proto.getParameter) return;
      const orig = proto.getParameter;
      proto.getParameter = function (param) {{
        const UNMASKED_VENDOR = 0x9245;
        const UNMASKED_RENDERER = 0x9246;
        if (param === UNMASKED_VENDOR) return vendor;
        if (param === UNMASKED_RENDERER) return renderer;
        return orig.apply(this, arguments);
      }};
    }};
    try {{ patchGetParam(WebGLRenderingContext && WebGLRenderingContext.prototype); }} catch (e) {{}}
    try {{ patchGetParam(WebGL2RenderingContext && WebGL2RenderingContext.prototype); }} catch (e) {{}}
  }} catch (e) {{}}
  try {{
    // 弱化 AutomationControlled / cdc_ 痕迹（尽力）
    const clean = (obj) => {{
      if (!obj) return;
      for (const k of Object.getOwnPropertyNames(obj)) {{
        if (/^cdc_|^\\$cdc_|^__driver|^__webdriver|^__selenium|^__fxdriver/i.test(k)) {{
          try {{ delete obj[k]; }} catch (e) {{}}
        }}
      }}
    }};
    clean(window);
    clean(document);
  }} catch (e) {{}}
}})();
"""


def human_pause(min_ms: int = 120, max_ms: int = 480) -> float:
    """步骤间随机停顿（秒）。有限行为随机，无法事后抹掉已签发 bot_flag。"""
    import time

    lo = max(0, int(min_ms))
    hi = max(lo, int(max_ms))
    secs = (lo + secrets.randbelow(hi - lo + 1)) / 1000.0
    time.sleep(secs)
    return secs


def json_dumps(v: Any) -> str:
    import json

    return json.dumps(v, ensure_ascii=False)
