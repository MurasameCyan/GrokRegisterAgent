#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TabPool — 每线程一个 Chromium（cookie 隔离）。

接口:
    TabPool.init(options_factory)
    TabPool.get_tab()
    TabPool.clear_session()   # 清 cookie/storage，保进程
    TabPool.release_tab()     # 退出当前线程浏览器
    TabPool.mark_served() / served_count()
    TabPool.refresh_tab()     # 完整回收
    TabPool.shutdown()
"""
from __future__ import annotations

import threading
from typing import Any, Callable, Optional


class TabPool:
    _options_factory: Optional[Callable[[], Any]] = None
    _options_lock = threading.Lock()
    _thread_local = threading.local()
    _all_browsers: list[Any] = []
    _all_browsers_lock = threading.Lock()

    @classmethod
    def init(cls, browser_options_or_factory, log_callback=None):
        with cls._options_lock:
            if callable(browser_options_or_factory):
                cls._options_factory = browser_options_or_factory
            else:
                cls._options_factory = lambda: browser_options_or_factory
        # 成功初始化不刷日志；失败由调用方打印

    @classmethod
    def _create_browser(cls):
        from DrissionPage import Chromium

        with cls._options_lock:
            factory = cls._options_factory
        if factory is None:
            return None
        options = factory()
        browser = Chromium(options)
        with cls._all_browsers_lock:
            cls._all_browsers.append(browser)
        return browser

    @classmethod
    def _unregister(cls, browser) -> None:
        if browser is None:
            return
        with cls._all_browsers_lock:
            try:
                cls._all_browsers = [b for b in cls._all_browsers if b is not browser]
            except Exception:
                pass

    @classmethod
    def get_tab(cls, url=None):
        tab = getattr(cls._thread_local, "tab", None)
        if tab is not None:
            return tab
        browser = cls._create_browser()
        if browser is None:
            raise RuntimeError("TabPool not initialized — call init() first")
        tab_ids = browser.tab_ids
        if tab_ids:
            tab = browser.get_tab(tab_ids[0])
        else:
            tab = browser.new_tab()
        cls._thread_local.browser = browser
        cls._thread_local.tab = tab
        cls._thread_local.served = 0
        return tab

    @classmethod
    def sync_tab(cls):
        browser = getattr(cls._thread_local, "browser", None)
        if browser is None:
            return
        tabs = browser.tab_ids
        if tabs:
            cls._thread_local.tab = browser.get_tab(tabs[-1])

    @classmethod
    def clear_session(cls, log_callback=None) -> bool:
        browser = getattr(cls._thread_local, "browser", None)
        tab = getattr(cls._thread_local, "tab", None)
        if browser is None:
            return False
        ok = True
        try:
            if tab is not None:
                try:
                    tab.get("about:blank")
                except Exception:
                    pass
                for js in (
                    "try{localStorage.clear()}catch(e){}",
                    "try{sessionStorage.clear()}catch(e){}",
                    "try{indexedDB.databases&&indexedDB.databases().then(ds=>ds.forEach(d=>indexedDB.deleteDatabase(d.name)))}catch(e){}",
                ):
                    try:
                        tab.run_js(js)
                    except Exception:
                        pass
            cleared = False
            for target in (tab, browser):
                if target is None or cleared:
                    continue
                for attr_path in (("set", "cookies", "clear"), ("cookies", "clear")):
                    try:
                        obj = target
                        for name in attr_path[:-1]:
                            obj = getattr(obj, name)
                        getattr(obj, attr_path[-1])()
                        cleared = True
                        break
                    except Exception:
                        continue
            try:
                tabs = list(browser.tab_ids or [])
                if len(tabs) > 1:
                    keep = tabs[0]
                    for tid in tabs[1:]:
                        try:
                            browser.get_tab(tid).close()
                        except Exception:
                            pass
                    cls._thread_local.tab = browser.get_tab(keep)
                elif tabs:
                    cls._thread_local.tab = browser.get_tab(tabs[0])
            except Exception:
                cls.sync_tab()
            if log_callback:
                served = int(getattr(cls._thread_local, "served", 0) or 0)
                log_callback(f"[*] 浏览器会话已清理（复用进程, served={served}）")
            return ok
        except Exception as exc:
            if log_callback:
                log_callback(f"[!] clear_session 失败: {exc}")
            return False

    @classmethod
    def mark_served(cls) -> int:
        n = int(getattr(cls._thread_local, "served", 0) or 0) + 1
        cls._thread_local.served = n
        return n

    @classmethod
    def served_count(cls) -> int:
        return int(getattr(cls._thread_local, "served", 0) or 0)

    @classmethod
    def release_tab(cls):
        browser = getattr(cls._thread_local, "browser", None)
        if browser is not None:
            try:
                browser.quit(del_data=True)
            except TypeError:
                try:
                    browser.quit()
                except Exception:
                    pass
            except Exception:
                pass
            cls._unregister(browser)
        cls._thread_local.browser = None
        cls._thread_local.tab = None
        cls._thread_local.served = 0

    @classmethod
    def refresh_tab(cls):
        cls.release_tab()
        return cls.get_tab()

    @classmethod
    def shutdown(cls):
        cls.release_tab()
        with cls._all_browsers_lock:
            browsers = list(cls._all_browsers)
            cls._all_browsers.clear()
        for b in browsers:
            try:
                b.quit(del_data=True)
            except TypeError:
                try:
                    b.quit()
                except Exception:
                    pass
            except Exception:
                pass

    @classmethod
    def live_count(cls) -> int:
        with cls._all_browsers_lock:
            return len(cls._all_browsers)

    @classmethod
    def get_browser(cls):
        return getattr(cls._thread_local, "browser", None)
