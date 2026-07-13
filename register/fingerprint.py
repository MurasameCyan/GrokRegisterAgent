"""注册浏览器随机特征（UA / 语言 / 时区 / 平台）。

每轮注册调用 build_fingerprint() 得到一份配置，再 apply_to_options / inject_stealth。
"""
from __future__ import annotations

import random
import secrets
from dataclasses import dataclass, asdict
from typing import Any


_CHROME_VERS = [120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131]


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

    def to_dict(self) -> dict:
        return asdict(self)


_TZ_POOL = [
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "America/Toronto",
    "Europe/London",
    "Europe/Berlin",
    "Europe/Paris",
    "Asia/Singapore",
    "Asia/Tokyo",
    "Australia/Sydney",
]

_LANG_POOL = [
    (["en-US", "en"], "en-US,en;q=0.9"),
    (["en-GB", "en"], "en-GB,en;q=0.9"),
    (["en-US", "en", "es"], "en-US,en;q=0.9,es;q=0.8"),
]


def _chrome_ua(platform_token: str, chrome_major: int) -> str:
    return (
        f"Mozilla/5.0 ({platform_token}) AppleWebKit/537.36 "
        f"(KHTML, like Gecko) Chrome/{chrome_major}.0.0.0 Safari/537.36"
    )


def build_fingerprint(seed: str | None = None) -> BrowserFingerprint:
    rnd = random.Random(seed) if seed else random.Random(secrets.randbits(64))
    chrome = rnd.choice(_CHROME_VERS)
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
    ]
    w, h = rnd.choice(sizes)
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
    """返回注入页面的 stealth JS。"""
    langs_js = json_dumps(fp.languages)
    return f"""
(() => {{
  try {{
    Object.defineProperty(navigator, 'webdriver', {{ get: () => undefined }});
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
    const tz = {json_dumps(fp.timezone)};
    const orig = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function () {{
      const r = orig.apply(this, arguments);
      try {{ r.timeZone = tz; }} catch (e) {{}}
      return r;
    }};
  }} catch (e) {{}}
}})();
"""


def json_dumps(v: Any) -> str:
    import json

    return json.dumps(v, ensure_ascii=False)
