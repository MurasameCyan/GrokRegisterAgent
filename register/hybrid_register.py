# -*- coding: utf-8 -*-
"""
Plan C · Hybrid 注册：浏览器 harvest（Castle/CF/Turnstile）+ 协议 gRPC/Server Action。

对齐 regkit AuthManagementClient 真实流水线：
  open signup → harvest castle（UI 提交 CreateEmail）→ VerifyEmail → ValidatePassword
  → Turnstile → create_user_via_server_action → SSO materialize → 落盘

入口：
  run_hybrid_registration(output_path, extract_numbers=False)  # DrissionPage_example 调用
  hybrid_register(...) / register_one_hybrid(...)
"""
from __future__ import annotations

import json
import os
import secrets
import string
import time
import traceback
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

LogFn = Callable[[str], None]
ROOT = Path(__file__).resolve().parent


def _noop(_: str) -> None:
    return None


def protocol_available() -> bool:
    try:
        from protocol import ProtocolSession, AuthManagementClient  # noqa: F401

        return True
    except Exception:
        return False


def load_next_action_from_capture() -> str:
    rpc = ROOT / "capture_out" / "rpc"
    for name in ("03_SignUpSubmit.req.headers.json",):
        p = rpc / name
        if p.is_file():
            try:
                h = json.loads(p.read_text(encoding="utf-8"))
                return str(h.get("next-action") or h.get("Next-Action") or "")
            except Exception:
                pass
    if rpc.is_dir():
        for f in rpc.glob("*.req.headers.json"):
            try:
                h = json.loads(f.read_text(encoding="utf-8"))
                if h.get("next-action"):
                    return str(h["next-action"])
            except Exception:
                pass
    return ""


def _build_profile() -> tuple[str, str, str]:
    try:
        from grok_register_ttk import build_profile

        return build_profile()
    except Exception:
        given_pool = ["Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley"]
        family_pool = ["Smith", "Johnson", "Williams", "Brown", "Jones"]
        alphabet = string.ascii_letters + string.digits
        password = "".join(secrets.choice(alphabet) for _ in range(12)) + "aA1!"
        return secrets.choice(given_pool), secrets.choice(family_pool), password


def _get_email_and_token() -> tuple[str, str]:
    try:
        from grok_register_ttk import get_email_and_token

        email, tok = get_email_and_token()
        return str(email), str(tok)
    except Exception:
        from email_register import create_temp_email

        email, _pw, jwt = create_temp_email()
        return str(email), str(jwt or "")


def _get_mail_code(mail_token: str, email: str, log: LogFn) -> str:
    try:
        from email_register import get_oai_code

        code = get_oai_code(mail_token, email, timeout=90)
        return str(code or "").replace("-", "").strip()
    except Exception as e:
        log(f"[hybrid] get_oai_code: {e}")
        return ""


def _load_proxy() -> str:
    try:
        conf = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
        return str(
            conf.get("proxy")
            or conf.get("browser_proxy")
            or conf.get("resolved_proxy")
            or ""
        ).strip()
    except Exception:
        return ""


def hybrid_register(
    *,
    email: str = "",
    password: str = "",
    proxy: str = "",
    birth_year: int = 1995,
    name: str = "",
    page: Any = None,
    log: Optional[LogFn] = None,
    mail_token: str = "",
    should_stop: Optional[Callable[[], bool]] = None,
) -> dict[str, Any]:
    """单账号 hybrid。可传入已有 email/password/mail_token，否则自建。"""
    log = log or _noop
    stop = should_stop or (lambda: False)
    _ = birth_year  # 协议路径用 profile 生日字段时由 server action 隐式处理

    if not protocol_available():
        return {
            "ok": False,
            "error": "hybrid protocol 未就绪：register/protocol 导入失败",
            "mode": "hybrid",
        }

    try:
        from browser.token_harvester import BrowserTokenSession
        from protocol.grpc_client import AuthManagementClient
        from protocol.session import ProtocolSession
    except Exception as e:
        return {"ok": False, "error": f"import: {e}", "mode": "hybrid"}

    t0 = time.time()
    proxy = (proxy or _load_proxy()).strip()
    action = load_next_action_from_capture()

    # 邮箱
    if not email or not mail_token:
        try:
            email, mail_token = _get_email_and_token()
        except Exception as e:
            return {"ok": False, "error": f"create email: {e}", "mode": "hybrid"}
    email = str(email).strip()
    log(f"[hybrid] email={email}")

    given, family, prof_password = _build_profile()
    if password:
        prof_password = password
    if name:
        parts = str(name).strip().split(None, 1)
        given = parts[0]
        if len(parts) > 1:
            family = parts[1]

    try:
        with BrowserTokenSession(log=log) as browser:
            if stop():
                return {"ok": False, "error": "stopped", "mode": "hybrid"}
            browser.open_signup()
            browser.install_network_hook()
            action = action or browser.scrape_next_action() or action

            # UI 提交邮箱以触发原生 CreateEmail + 捕获 castle
            castle = browser.harvest_castle_via_email_submit(email, timeout=45)
            browser_cookies = browser.export_cookies()
            if not castle or len(castle) < 1000 or not str(castle).startswith("IBYIll"):
                # 宽松：允许非 IBYIll 前缀但足够长的 token
                if not castle or len(str(castle)) < 800:
                    log(
                        f"[hybrid] bad castle len={len(castle or '')} "
                        f"head={(castle or '')[:24]}"
                    )
                    return {
                        "ok": False,
                        "error": f"castle 无效 len={len(castle or '')}",
                        "mode": "hybrid",
                    }

            ua = browser.browser_user_agent() or ""
            sess = ProtocolSession(
                proxy=proxy,
                user_agent=ua,
                impersonate="chrome131",
            )
            jar = dict(browser_cookies or {})
            for stale in ("sso", "sso-rw"):
                jar.pop(stale, None)
            sess.set_cookies(jar)
            client = AuthManagementClient(sess)
            if action:
                client.next_action = action

            browser_sent = browser.create_email_sent_via_browser()
            if browser_sent:
                log(
                    f"[hybrid] CreateEmail via browser OK (skip protocol) "
                    f"castle_len={len(castle)}"
                )
            else:
                r1 = client.create_email_validation_code(email, castle)
                log(
                    f"[hybrid] CreateEmail status={r1.get('status')} "
                    f"castle_len={len(castle)}"
                )
                if int(r1.get("status") or 0) >= 400:
                    body_hint = ""
                    try:
                        raw = r1.get("raw") or b""
                        if b"cloudflare" in raw[:500].lower() or b"<!DOCTYPE" in raw[:200]:
                            body_hint = " (Cloudflare block)"
                    except Exception:
                        pass
                    log(
                        f"[hybrid] CreateEmail fail{body_hint} "
                        f"strings={r1.get('strings')[:2] if r1.get('strings') else []}"
                    )
                    return {
                        "ok": False,
                        "error": f"CreateEmail fail status={r1.get('status')}",
                        "mode": "hybrid",
                    }
            if stop():
                return {"ok": False, "error": "stopped", "mode": "hybrid"}

            clean = _get_mail_code(mail_token, email, log)
            if not clean:
                log("[hybrid] no mail code")
                return {"ok": False, "error": "no mail code", "mode": "hybrid"}
            log(f"[hybrid] code={clean}")

            r2 = client.verify_email_validation_code(email, clean)
            log(f"[hybrid] VerifyEmail status={r2.get('status')}")
            if int(r2.get("status") or 0) >= 400:
                log(f"[hybrid] VerifyEmail fail {r2.get('strings')}")
                return {
                    "ok": False,
                    "error": f"VerifyEmail fail status={r2.get('status')}",
                    "mode": "hybrid",
                }
            if stop():
                return {"ok": False, "error": "stopped", "mode": "hybrid"}

            try:
                client.validate_password(email, prof_password)
            except Exception:
                pass

            turnstile = browser.get_turnstile_token(timeout=90, inject=True)
            if len(turnstile) < 80:
                # 尝试驱动 UI 到 profile 再取 turnstile
                try:
                    browser.prepare_profile_step_for_turnstile(email, clean, timeout=60)
                    turnstile = browser.get_turnstile_token(timeout=60, inject=True)
                except Exception as te:
                    log(f"[hybrid] turnstile retry: {te}")
            if len(turnstile) < 80:
                log(f"[hybrid] turnstile short len={len(turnstile)}")
                return {
                    "ok": False,
                    "error": f"turnstile short len={len(turnstile)}",
                    "mode": "hybrid",
                }

            castle2 = browser.read_captured_castle() or castle
            if len(str(castle2)) < 800:
                castle2 = castle
            browser_cookies = browser.export_cookies()
            jar2 = dict(browser_cookies or {})
            for stale in ("sso", "sso-rw"):
                jar2.pop(stale, None)
            sess.set_cookies(jar2)

            action = (
                action
                or browser.scrape_next_action()
                or load_next_action_from_capture()
            )
            if not action:
                client.next_action = ""
                action = client.discover_next_action(timeout=60)
            known = "7f50061dd2f5b389a530e4a048d5fdf0c48d1d9259"
            if not action:
                action = known
                log(f"[hybrid] next-action fallback={action[:16]}...")
            elif action != known:
                log(
                    f"[hybrid] next-action discovered={action[:20]}... "
                    f"known={known[:16]}..."
                )
            else:
                log(f"[hybrid] next-action={action[:20]}...")
            client.next_action = action
            if stop():
                return {"ok": False, "error": "stopped", "mode": "hybrid"}

            def _do_signup(act: str):
                return client.create_user_via_server_action(
                    email=email,
                    code=clean,
                    given_name=given,
                    family_name=family,
                    password=prof_password,
                    turnstile_token=turnstile,
                    castle_token=castle2,
                    next_action=act,
                    conversion_id=str(uuid.uuid4()),
                )

            r3 = _do_signup(action)
            sso = r3.get("sso") or ""
            if not sso:
                ck = r3.get("cookies") or {}
                sso = ck.get("sso") or ck.get("sso-rw") or ""
            body_txt = str(r3.get("text") or "")
            if (not sso) and action != known and (
                "isLoggedInWithSSO" in body_txt or int(r3.get("status") or 0) == 200
            ):
                log(f"[hybrid] retry sign-up with known next-action={known[:16]}...")
                jar3 = dict(browser.export_cookies() or {})
                for stale in ("sso", "sso-rw"):
                    jar3.pop(stale, None)
                sess.set_cookies(jar3)
                r3 = _do_signup(known)
                sso = r3.get("sso") or ""
                if not sso:
                    ck = r3.get("cookies") or {}
                    sso = ck.get("sso") or ck.get("sso-rw") or ""
                body_txt = str(r3.get("text") or "")

            log(
                f"[hybrid] sign-up status={r3.get('status')} sso_len={len(sso)} "
                f"elapsed={time.time() - t0:.1f}s"
            )
            if not sso:
                return {
                    "ok": False,
                    "error": f"no sso body={body_txt[:200]}",
                    "mode": "hybrid",
                    "cookies": list((r3.get("cookies") or {}).keys())[:12],
                }

            # wrapper SSO → session SSO
            try:
                from protocol.sso_util import (
                    is_session_sso,
                    is_wrapper_sso,
                    materialize_sso_via_browser,
                    materialize_sso_via_http,
                )

                if is_wrapper_sso(sso) or not is_session_sso(sso):
                    log(
                        f"[hybrid] sso looks like wrapper len={len(sso)}; materialize…"
                    )
                    sess_sso = ""
                    page_obj = page
                    if page_obj is None:
                        try:
                            from grok_register_ttk import _get_page

                            page_obj = _get_page()
                        except Exception:
                            page_obj = None
                    if page_obj is not None:
                        sess_sso = materialize_sso_via_browser(
                            page_obj, sso, log=log, timeout=40
                        )
                    if not sess_sso or not is_session_sso(sess_sso):
                        jar_full = dict(browser.export_cookies() or {})
                        sess_sso = (
                            materialize_sso_via_http(
                                sso,
                                proxy=proxy,
                                extra_cookies=jar_full,
                                log=log,
                            )
                            or sess_sso
                        )
                    if sess_sso and is_session_sso(sess_sso):
                        log(f"[hybrid] session sso ready len={len(sess_sso)}")
                        sso = sess_sso
                    else:
                        log(
                            f"[hybrid] WARN still non-session sso len={len(sso)}; "
                            f"CPA mint may fail"
                        )
            except Exception as me:
                log(f"[hybrid] sso materialize: {me}")

            # 导出 cookie 列表（含 cf_clearance）
            jar_full = dict(browser.export_cookies() or {})
            if sso:
                jar_full["sso"] = sso
                jar_full["sso-rw"] = jar_full.get("sso-rw") or sso
            cookie_list = [
                {"name": k, "value": v, "domain": ".x.ai", "path": "/"}
                for k, v in jar_full.items()
                if k and v is not None
            ]
            # W3 · SSO 去重
            try:
                from sso_ledger import claim_sso

                claim = claim_sso(sso, email=email)
                if claim.get("duplicate"):
                    log(
                        f"[hybrid][sso-ledger] ✘ 重复指纹 "
                        f"{str(claim.get('fingerprint') or '')[:12]}…"
                    )
                    return {
                        "ok": False,
                        "error": "duplicate SSO fingerprint",
                        "duplicate": True,
                        "mode": "hybrid",
                        "fingerprint": claim.get("fingerprint"),
                    }
            except Exception as le:
                log(f"[hybrid] sso ledger: {le}")

            # W2 · 缓存 CF（供主循环下一轮 restore）
            try:
                from cf_context import CloudflareContext, set_thread_cf_context

                cf_str = str(jar_full.get("cf_clearance") or "")
                if cf_str and not cf_str.startswith("cf_clearance="):
                    cf_str = f"cf_clearance={cf_str}"
                bm = str(jar_full.get("__cf_bm") or "")
                if bm and not bm.startswith("__cf_bm="):
                    bm = f"__cf_bm={bm}" if bm else ""
                parts = [p for p in (cf_str, bm) if p]
                if parts:
                    set_thread_cf_context(
                        CloudflareContext(
                            user_agent=ua or "",
                            cloudflare_cookies="; ".join(parts),
                            captured_at=time.time(),
                            source="hybrid",
                        )
                    )
                    log(f"[hybrid][cf-ctx] 已缓存 CF parts={len(parts)}")
            except Exception as cfe:
                log(f"[hybrid] cf cache: {cfe}")

            log(f"[hybrid] ✔ OK email={email} sso_len={len(sso)} cookies={len(cookie_list)}")
            return {
                "ok": True,
                "sso": sso,
                "email": email,
                "password": prof_password,
                "mode": "hybrid",
                "cookies": cookie_list,
                "cf_clearance": jar_full.get("cf_clearance") or "",
                "elapsed": round(time.time() - t0, 2),
            }
    except Exception as e:
        log(f"[hybrid] exception: {e}")
        try:
            log(traceback.format_exc().splitlines()[-3])
        except Exception:
            pass
        return {"ok": False, "error": str(e)[:400], "mode": "hybrid"}


def register_one_hybrid(
    *,
    log: Optional[LogFn] = None,
    proxy: str = "",
    user_agent: str = "",
    next_action: str = "",
    accounts_file: Optional[Path] = None,
    should_stop: Optional[Callable[[], bool]] = None,
    post_success: bool = True,
) -> bool:
    """regkit 兼容：成功返回 True。"""
    _ = user_agent, next_action, post_success
    log = log or _noop
    r = hybrid_register(proxy=proxy or "", log=log, should_stop=should_stop)
    if not r.get("ok"):
        return False
    email = r.get("email") or ""
    password = r.get("password") or ""
    sso = r.get("sso") or ""
    if accounts_file and email and sso:
        try:
            accounts_file = Path(accounts_file)
            accounts_file.parent.mkdir(parents=True, exist_ok=True)
            with accounts_file.open("a", encoding="utf-8") as f:
                f.write(f"{email}----{password}----{sso}\n")
        except Exception as e:
            log(f"[hybrid] save file fail: {e}")
    return True


def run_hybrid_registration(
    output_path: str = "",
    extract_numbers: bool = False,
    log: Optional[LogFn] = None,
) -> dict[str, Any]:
    """主循环入口（DrissionPage_example plan-c）。

    成功时返回含 sso/email/password 的 dict（与 run_single_registration 形状对齐）。
    """
    _ = extract_numbers
    log = log or (lambda m: print(m, flush=True))
    r = hybrid_register(proxy=_load_proxy(), log=log)
    if not r.get("ok"):
        log(f"[hybrid] ✘ {r.get('error')}")
        return r

    email = r.get("email") or ""
    password = r.get("password") or ""
    sso = r.get("sso") or ""

    # 落盘 SSO 行
    try:
        out = Path(output_path) if output_path else ROOT / "sso.txt"
        out = Path(out)
        out.parent.mkdir(parents=True, exist_ok=True)
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"{email}|{password}|{sso}\n")
        log(f"[hybrid] 已写入 {out}")
    except Exception as we:
        log(f"[hybrid] 写文件失败: {we}")

    # 尝试入授权队列（若可用）
    try:
        cookies = r.get("cookies") or []
        cf_parts = []
        for c in cookies:
            if isinstance(c, dict) and c.get("name") and c.get("value"):
                n = str(c["name"])
                if n.lower() in ("cf_clearance", "__cf_bm", "sso", "sso-rw"):
                    cf_parts.append(f"{n}={c['value']}")
        cf_hint = "; ".join(cf_parts) or str(r.get("cf_clearance") or "")
        try:
            from auth_export_queue import enqueue_authorization as _enq
        except Exception:
            from auth_export_queue import enqueue_sso_to_auth as _enq
        _enq(
            sso=sso,
            email=email,
            password=password,
            cloudflare_cookies=cf_hint,
            log=log,
        )
    except Exception as qe:
        log(f"[hybrid] auth queue skip: {qe}")

    return {
        "ok": True,
        "sso": sso,
        "email": email,
        "password": password,
        "mode": "hybrid",
        "cookies": r.get("cookies") or [],
        "cf_clearance": r.get("cf_clearance") or "",
    }


# 别名：旧封装名
run_hybrid_registration_flow = run_hybrid_registration


def run_hybrid_registration_job(count, log_callback=None, controller=None):
    """批量 job（CLI/Web 兼容）。"""
    log = log_callback or (lambda m: print(m, flush=True))
    if controller is None:
        try:
            from grok_register_ttk import CliStopController

            controller = CliStopController()
        except Exception:

            class _C:
                def should_stop(self):
                    return False

            controller = _C()

    success_count = 0
    fail_count = 0
    try:
        from grok_register_ttk import now_beijing

        ts = now_beijing()
    except Exception:
        ts = time.strftime("%Y%m%d_%H%M%S")
    accounts_output_file = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        f"accounts_hybrid_{ts}.txt",
    )
    log(f"[*] 混合模式启动，目标数量: {count}")
    log(f"[*] 成功账号将实时保存到: {accounts_output_file}")
    proxy = _load_proxy()
    next_action = load_next_action_from_capture()

    i = 0
    try:
        while i < int(count):
            if controller.should_stop():
                break
            log(f"--- [hybrid] 开始第 {i + 1}/{count} 个账号 ---")
            ok = register_one_hybrid(
                log=log,
                proxy=proxy,
                next_action=next_action,
                accounts_file=Path(accounts_output_file),
                should_stop=controller.should_stop,
            )
            if ok:
                success_count += 1
            else:
                fail_count += 1
            i += 1
            log(f"[*] 当前统计: 成功 {success_count} | 失败 {fail_count}")
            if controller.should_stop():
                break
            time.sleep(1)
    except KeyboardInterrupt:
        try:
            controller.stop()
        except Exception:
            pass
        log("[!] 收到 Ctrl+C，正在停止")
    except Exception as exc:
        log(f"[!] 混合任务异常: {exc}")

    log(f"[*] 混合任务结束。成功 {success_count} | 失败 {fail_count}")
    return {
        "success": success_count,
        "fail": fail_count,
        "accounts_file": accounts_output_file,
        "stopped": bool(getattr(controller, "should_stop", lambda: False)()),
    }
