# -*- coding: utf-8 -*-
"""
U2 · cpa_xai 兼容包（对齐 clean 包入口，转发到本仓库现有 mint 实现）。

clean 原结构:
  cpa_xai.mint / oauth_device / browser_confirm / writer / probe

本仓库映射:
  mint_and_export     → auth_service.sso_to_cpa_auth / tokens_to_cpa_auth
  device code         → oauth_device_mint / browser_device_mint
  browser consent     → browser_device_mint.mint_with_password_browser
  probe               → cpa_probe
"""
from __future__ import annotations

from typing import Any, Callable, Optional

LogFn = Callable[[str], None]


def mint_and_export(
    *,
    sso: str = "",
    email: str = "",
    password: str = "",
    proxy: str = "",
    mint_mode: str = "pkce",
    skip_remote: bool = False,
    log: Optional[LogFn] = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """SSO → CPA auth 文件（可选远程）。"""
    from auth_service import sso_to_cpa_auth

    return sso_to_cpa_auth(
        sso=sso,
        email=email,
        proxy=proxy,
        mint_mode=mint_mode,
        skip_remote=skip_remote,
        log=log or (lambda m: print(m, flush=True)),
        **{k: v for k, v in kwargs.items() if k in (
            "require_grok_45", "require_chat_probe", "out_dir"
        )},
    )


def mint_with_browser(
    *,
    email: str,
    password: str,
    proxy: str = "",
    log: Optional[LogFn] = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Device 授权 + 浏览器同意流（密码登录路径）。"""
    from browser_device_mint import mint_with_password_browser

    return mint_with_password_browser(
        email=email,
        password=password,
        proxy=proxy,
        log=log or (lambda m: print(m, flush=True)),
        **kwargs,
    )


def request_device_code(proxy: str = "", **kwargs: Any) -> dict[str, Any]:
    try:
        from oauth_device_mint import request_device_code as _rdc

        return _rdc(proxy=proxy, **kwargs)
    except Exception as e:
        return {"ok": False, "error": str(e)}


def probe_models(access_token: str, proxy: str = "", **kwargs: Any) -> dict[str, Any]:
    from cpa_probe import probe_models as _pm

    return _pm(access_token, proxy=proxy, **kwargs)


def probe_mini_response(access_token: str, proxy: str = "", **kwargs: Any) -> dict[str, Any]:
    from cpa_probe import probe_mini_response as _p

    return _p(access_token, proxy=proxy, **kwargs)


__all__ = [
    "mint_and_export",
    "mint_with_browser",
    "request_device_code",
    "probe_models",
    "probe_mini_response",
]
