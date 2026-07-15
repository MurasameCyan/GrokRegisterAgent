# 注册后关闭 ZDR 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 注册成功拿到 SSO 后、导出 SSO / 转换 Auth 之前，尽力关闭账号级 ZDR（消除 `File content is currently unsupported for ZDR customers` / `X-Zero-Retention: true`），并用 **关/开** 标签在 SSO 号池与 Auth 列表展示；失败不挡主流程。

**架构：** 镜像 NSFW 栈：`zdr_toggle.py`（curl_cffi + gRPC-web 候选 feature + probe）→ `account_tags` 侧车 + patch auth JSON → 主路径在 `append_sso_to_txt` 前调用、队列 mint 后补刀 → TS 侧 `accountTags`/`accountStore`/`cpaAuthStore` 合并 → `ZdrBadge` + 设置项 `enableDisableZdr`（默认 true）。

**技术栈：** Python 3（curl_cffi）、Express/TS server、React 设置/号池/Auth 页、现有 gRPC-web protobuf 手编码模式。

**规格：** `docs/superpowers/specs/2026-07-16-disable-zdr-design.md`

---

## 文件结构

| 文件 | 职责 |
|------|------|
| 创建 `register/zdr_toggle.py` | `encode_grpc_feature_control`、`disable_zdr_for_sso`、probe |
| 创建 `register/tests/test_zdr_toggle.py` | 编码与标签逻辑单测（无网络） |
| 修改 `register/account_tags.py` | `set_zdr_tag`、`patch_auth_file_zdr` |
| 修改 `register/DrissionPage_example.py` | claim_sso 后、append_sso 前调用 |
| 修改 `register/auth_export_queue.py` | `_maybe_zdr_after_mint` 补刀 + patch |
| 修改 `register/config.example.json` | `enable_disable_zdr: true` |
| 修改 `src/shared/settings.ts` | `enableDisableZdr` 默认 true |
| 修改 `server/src/bot/registerRuntime.ts` | 写入 `config.enable_disable_zdr` |
| 修改 `server/src/accountTags.ts` | 解析 zdr_* → UI 字段 |
| 修改 `server/src/accountStore.ts` | listAccounts 合并 zdr |
| 修改 `server/src/cpaAuthStore.ts` | Auth 列表合并 zdr |
| 修改 `src/shared/runEvents.ts` | AccountRecord zdr* |
| 修改 `src/shared/ipc.ts` | CpaAuthItem zdr* |
| 创建 `src/renderer/components/domain/ZdrBadge.tsx` | 关/开/— |
| 修改 `src/renderer/pages/PoolPage.tsx` | SSO tag |
| 修改 `src/renderer/pages/AuthPage.tsx` | ZDR 列 |
| 修改 `src/renderer/components/domain/SettingsForm.tsx` | 开关 |

语义约定（全计划一致）：

- 落盘 snake：`zdr_closed` / `zdr_attempted` / `zdr_at` / `zdr_error`
- TS camel：`zdrClosed` / `zdrAttempted` / `zdrAt` / `zdrError` / `zdrStatus: 'closed' | 'open' | 'none'`
- `zdr_closed=true` → UI **关**（closed）；`false` 且 attempted → **开**（open）

---

### 任务 1：zdr_toggle 编码 + 单测

**文件：**
- 创建：`register/zdr_toggle.py`
- 创建：`register/tests/test_zdr_toggle.py`
- 参考：`register/nsfw_toggle.py`（会话/帧格式）

- [ ] **步骤 1：编写失败的单测**

创建 `register/tests/__init__.py`（空）与 `register/tests/test_zdr_toggle.py`：

```python
# -*- coding: utf-8 -*-
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from zdr_toggle import encode_grpc_feature_control, FEATURE_URL


def test_encode_frame_has_grpc_prefix_and_feature_key():
    key = b"zero_data_retention"
    frame = encode_grpc_feature_control(key, enabled=0)
    assert frame[0] == 0x00
    payload_len = struct.unpack(">I", frame[1:5])[0]
    payload = frame[5:]
    assert len(payload) == payload_len
    assert key in payload
    # enabled=0 → field1 varint 0
    assert b"\x10\x00" in payload


def test_encode_enabled_one_matches_nsfw_shape():
    key = b"always_show_nsfw_content"
    frame = encode_grpc_feature_control(key, enabled=1)
    assert b"\x10\x01" in frame
    assert key in frame


def test_feature_url_is_update_user_feature_controls():
    assert "UpdateUserFeatureControls" in FEATURE_URL
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
cd register
python -m pytest tests/test_zdr_toggle.py -v
```

预期：FAIL（`ModuleNotFoundError: zdr_toggle` 或 import 失败）。

若无 pytest：

```powershell
python -c "import tests.test_zdr_toggle"
```

预期：ImportError。

- [ ] **步骤 3：实现 `register/zdr_toggle.py`（编码 + 主入口骨架）**

```python
# -*- coding: utf-8 -*-
"""关闭 / 探测 Grok 账号级 ZDR（Zero Data Retention）。

协议优先：UpdateUserFeatureControls 候选 feature keys + 响应头 X-Zero-Retention probe。
失败不抛；由调用方写 tag（关=closed / 开=open）。

注意：公开文档无已证实 key；DEFAULT_FEATURE_ATTEMPTS 可配置增补。
"""
from __future__ import annotations

import re
import struct
import time
from typing import Any, Callable, Optional

LogFn = Callable[[str], None]

FEATURE_URL = "https://grok.com/auth_mgmt.AuthManagement/UpdateUserFeatureControls"

# (feature_key, enabled_varint) — 尽力尝试；HAR 后增补
DEFAULT_FEATURE_ATTEMPTS: list[tuple[str, int]] = [
    ("zero_data_retention", 0),
    ("zero_retention", 0),
    ("zdr", 0),
    ("disable_zero_data_retention", 1),
    ("allow_file_uploads", 1),
    ("allow_file_content", 1),
]


def _noop(_: str) -> None:
    return None


def _preview(res: Any, limit: int = 200) -> str:
    try:
        text = str(getattr(res, "text", None) or "")
    except Exception:
        text = ""
    return re.sub(r"\s+", " ", text).strip()[:limit]


def encode_grpc_feature_control(feature_key: bytes | str, enabled: int = 1) -> bytes:
    """与 nsfw_toggle.encode_grpc_nsfw_settings 同布局，key/enabled 可配。"""
    key = feature_key if isinstance(feature_key, bytes) else str(feature_key).encode("utf-8")
    en = int(enabled) & 0x7F
    field1_content = bytes([0x10, en])
    field1 = bytes([0x0A, len(field1_content)]) + field1_content
    field2_inner = bytes([0x0A, len(key)]) + key
    field2 = bytes([0x12, len(field2_inner)]) + field2_inner
    payload = field1 + field2
    return b"\x00" + struct.pack(">I", len(payload)) + payload


def _header_zdr_true(res: Any) -> Optional[bool]:
    """True=仍 ZDR；False=明确非 ZDR；None=未知。"""
    try:
        headers = {
            str(k).lower(): str(v)
            for k, v in dict(getattr(res, "headers", {}) or {}).items()
        }
    except Exception:
        return None
    raw = headers.get("x-zero-retention")
    if raw is None:
        return None
    v = str(raw).strip().lower()
    if v in ("true", "1", "yes"):
        return True
    if v in ("false", "0", "no"):
        return False
    return None


def _is_cf_block(res: Any) -> bool:
    try:
        headers = {
            str(k).lower(): str(v).lower()
            for k, v in dict(getattr(res, "headers", {}) or {}).items()
        }
        text = str(getattr(res, "text", None) or "").lower()
        server = headers.get("server", "")
        ctype = headers.get("content-type", "")
        code = int(getattr(res, "status_code", 0) or 0)
        return code in (403, 429, 503) and (
            "cloudflare" in server
            or "cloudflare" in text
            or "cf-error" in text
            or "__cf_chl" in text
            or "text/html" in ctype
        )
    except Exception:
        return False


def _try_feature(
    session: Any, log: LogFn, timeout: float, feature: str, enabled: int
) -> dict[str, Any]:
    headers = {
        "content-type": "application/grpc-web+proto",
        "x-grpc-web": "1",
        "origin": "https://grok.com",
        "referer": "https://grok.com/",
    }
    try:
        res = session.post(
            FEATURE_URL,
            data=encode_grpc_feature_control(feature, enabled=enabled),
            headers=headers,
            timeout=timeout,
        )
        zdr = _header_zdr_true(res)
        log(
            f"[zdr] feature={feature} en={enabled} status={res.status_code} "
            f"x-zero-retention={zdr} body={_preview(res)}"
        )
        return {
            "feature": feature,
            "enabled": enabled,
            "ok_http": 200 <= int(res.status_code or 0) < 300,
            "status": int(res.status_code or 0),
            "zdr_header": zdr,
            "cf_block": _is_cf_block(res),
            "body": _preview(res),
        }
    except Exception as e:
        return {
            "feature": feature,
            "enabled": enabled,
            "ok_http": False,
            "error": str(e)[:300],
            "zdr_header": None,
        }


def _probe_retention(session: Any, log: LogFn, timeout: float) -> dict[str, Any]:
    """轻量 probe：GET grok.com/ + 可选 rest，收集 X-Zero-Retention。"""
    out: dict[str, Any] = {"skipped": False, "samples": []}
    urls = [
        "https://grok.com/",
        "https://grok.com/rest/app-chat/conversations",
    ]
    any_true = False
    any_false = False
    for url in urls:
        try:
            res = session.get(url, timeout=min(12.0, timeout))
            zdr = _header_zdr_true(res)
            sample = {
                "url": url,
                "status": int(getattr(res, "status_code", 0) or 0),
                "zdr_header": zdr,
            }
            out["samples"].append(sample)
            log(f"[zdr] probe {url} status={sample['status']} x-zero-retention={zdr}")
            if zdr is True:
                any_true = True
            elif zdr is False:
                any_false = True
        except Exception as e:
            out["samples"].append({"url": url, "error": str(e)[:200]})
    if any_true:
        out["still_zdr"] = True
    elif any_false:
        out["still_zdr"] = False
    else:
        out["still_zdr"] = None
        out["note"] = "no X-Zero-Retention header on probe samples"
    return out


def disable_zdr_for_sso(
    sso: str,
    *,
    cf_clearance: str = "",
    proxy: str = "",
    timeout: float = 20.0,
    max_attempts: int = 2,
    retry_delay_sec: float = 2.0,
    feature_attempts: list[tuple[str, int]] | None = None,
    log: Optional[LogFn] = None,
) -> dict[str, Any]:
    """尽力关闭 ZDR 并 probe。

    返回:
      ok: bool  — True 仅当判定已关（closed）
      zdr_status: "closed" | "open" | "unknown"
      error, steps, probe, attempts
    """
    log = log or _noop
    sso = str(sso or "").strip()
    if sso.lower().startswith("sso="):
        sso = sso[4:]
    if not sso:
        return {
            "ok": False,
            "zdr_status": "open",
            "error": "empty sso",
        }

    try:
        from curl_cffi import requests as cf_requests
    except ImportError as e:
        return {
            "ok": False,
            "zdr_status": "open",
            "error": f"curl_cffi required: {e}",
        }

    attempts_list = feature_attempts or list(DEFAULT_FEATURE_ATTEMPTS)
    proxies = {"http": proxy, "https": proxy} if proxy else None
    cookie_parts = [f"sso={sso}", f"sso-rw={sso}"]
    if cf_clearance:
        cookie_parts.append(f"cf_clearance={str(cf_clearance).strip()}")
    ua = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    )
    n_att = max(1, min(int(max_attempts or 2), 4))
    last: dict[str, Any] = {
        "ok": False,
        "zdr_status": "open",
        "error": "not attempted",
    }

    for attempt in range(1, n_att + 1):
        steps: dict[str, Any] = {"features": []}
        try:
            with cf_requests.Session(
                impersonate="chrome120", proxies=proxies
            ) as session:
                session.headers.update(
                    {
                        "user-agent": ua,
                        "cookie": "; ".join(cookie_parts),
                        "accept": "*/*",
                    }
                )
                try:
                    session.get("https://grok.com/", timeout=min(12.0, timeout))
                except Exception:
                    pass

                for feat, en in attempts_list:
                    steps["features"].append(
                        _try_feature(session, log, timeout, feat, en)
                    )

                probe = _probe_retention(session, log, timeout)
                steps["probe"] = probe
                still = probe.get("still_zdr")

                # 判定：probe 明确仍 ZDR → open；明确非 ZDR → closed；
                # 未知 → 保守 open（规格：无证据不标关）
                if still is True:
                    last = {
                        "ok": False,
                        "zdr_status": "open",
                        "error": "probe still X-Zero-Retention: true",
                        "steps": steps,
                        "probe": probe,
                        "attempts": attempt,
                    }
                elif still is False:
                    log(f"[zdr] ✔ probe 非 ZDR（第 {attempt} 次）")
                    return {
                        "ok": True,
                        "zdr_status": "closed",
                        "message": "ZDR closed (probe X-Zero-Retention false)",
                        "steps": steps,
                        "probe": probe,
                        "attempts": attempt,
                    }
                else:
                    last = {
                        "ok": False,
                        "zdr_status": "open",
                        "error": "probe inconclusive; conservatively mark open",
                        "steps": steps,
                        "probe": probe,
                        "attempts": attempt,
                    }
                    log(f"[zdr] ✘ 第 {attempt}/{n_att} probe 无结论: {last['error']}")
        except Exception as e:
            last = {
                "ok": False,
                "zdr_status": "open",
                "error": str(e)[:300],
                "steps": steps,
                "attempts": attempt,
            }
            log(f"[zdr] ✘ 第 {attempt}/{n_att} 异常: {e}")
        if attempt < n_att:
            time.sleep(max(0.5, float(retry_delay_sec or 2.0)) * attempt)
    return last
```

- [ ] **步骤 4：运行测试确认通过**

```powershell
cd register
python -m pytest tests/test_zdr_toggle.py -v
```

预期：PASS（3 passed）。

- [ ] **步骤 5：Commit**

```bash
git add register/zdr_toggle.py register/tests/test_zdr_toggle.py register/tests/__init__.py
git commit -m "feat(register): add zdr_toggle encode and disable_zdr_for_sso"
```

---

### 任务 2：account_tags 侧车与 auth patch

**文件：**
- 修改：`register/account_tags.py`
- 修改：`register/tests/test_zdr_toggle.py`（追加 tag 测试）

- [ ] **步骤 1：追加失败测试**

在 `test_zdr_toggle.py` 末尾增加（使用临时目录 monkeypatch `_PATH`）：

```python
import json
import account_tags as at


def test_set_zdr_tag_and_patch_auth(tmp_path, monkeypatch):
    tag_path = tmp_path / "account_tags.json"
    monkeypatch.setattr(at, "_PATH", tag_path)
    tag = at.set_zdr_tag(
        closed=True, email="a@b.com", sso="x" * 20, error=""
    )
    assert tag["zdr_closed"] is True
    assert tag["zdr_attempted"] is True
    data = json.loads(tag_path.read_text(encoding="utf-8"))
    assert data["by_email"]["a@b.com"]["zdr_closed"] is True

    auth = tmp_path / "auth.json"
    auth.write_text("{}", encoding="utf-8")
    assert at.patch_auth_file_zdr(auth, closed=False, error="still on")
    doc = json.loads(auth.read_text(encoding="utf-8"))
    assert doc["zdr_closed"] is False
    assert doc["zdr_attempted"] is True
    assert "still on" in doc["zdr_error"]
```

- [ ] **步骤 2：运行确认失败**

```powershell
python -m pytest register/tests/test_zdr_toggle.py::test_set_zdr_tag_and_patch_auth -v
```

预期：FAIL（`set_zdr_tag` 不存在）。

- [ ] **步骤 3：在 `account_tags.py` 实现**

在 `set_nsfw_tag` 之后追加（风格完全对齐 `set_nsfw_tag` / `patch_auth_file_nsfw`）：

```python
def set_zdr_tag(
    *,
    closed: bool,
    email: str = "",
    sso: str = "",
    error: str = "",
    steps: Any = None,
) -> dict[str, Any]:
    """写入 ZDR 关闭结果：closed=True → 关；False → 开。"""
    tag = {
        "zdr_closed": bool(closed),
        "zdr_attempted": True,
        "zdr_at": _now_iso(),
        "zdr_error": (error or "")[:300] if not closed else "",
    }
    if steps is not None:
        try:
            tag["zdr_steps"] = steps
        except Exception:
            pass
    with _LOCK:
        data = _load()
        email_k = str(email or "").strip().lower()
        if email_k:
            prev = dict(data["by_email"].get(email_k) or {})
            prev.update(tag)
            data["by_email"][email_k] = prev
        h = sso_hash(sso)
        if h:
            prev = dict(data["by_sso_hash"].get(h) or {})
            prev.update(tag)
            data["by_sso_hash"][h] = prev
        _save(data)
    return tag


def patch_auth_file_zdr(path: str | Path, *, closed: bool, error: str = "") -> bool:
    """把 zdr 字段写回 CPA auth JSON（不挡主流程）。"""
    p = Path(path)
    if not p.is_file():
        return False
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(doc, dict):
            return False
        doc["zdr_closed"] = bool(closed)
        doc["zdr_attempted"] = True
        doc["zdr_at"] = _now_iso()
        if not closed and error:
            doc["zdr_error"] = str(error)[:300]
        elif closed:
            doc.pop("zdr_error", None)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(p)
        return True
    except Exception:
        return False
```

- [ ] **步骤 4：测试通过 + Commit**

```bash
python -m pytest register/tests/test_zdr_toggle.py -v
git add register/account_tags.py register/tests/test_zdr_toggle.py
git commit -m "feat(register): account_tags set_zdr_tag and patch_auth_file_zdr"
```

---

### 任务 3：主路径 DrissionPage — SSO 落盘前调用

**文件：**
- 修改：`register/DrissionPage_example.py`（约 `claim_sso` 成功后、`append_sso_to_txt` 前，~4105–4106）

- [ ] **步骤 1：在 claim 成功与 append 之间插入**

在 `append_sso_to_txt(...)` **之前**插入（注意：cf_clearance 完整提取在后续 CF 块；此处做轻量提取，与队列侧一致）：

```python
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
                    "0", "false", "no", "off", ""
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
```

- [ ] **步骤 2：人工 diff 确认顺序**

确认顺序为：`claim_sso` → ZDR 块 → `append_sso_to_txt` → CF capture → 队列。

- [ ] **步骤 3：Commit**

```bash
git add register/DrissionPage_example.py
git commit -m "feat(register): disable ZDR before SSO export"
```

---

### 任务 4：auth_export_queue 补刀

**文件：**
- 修改：`register/auth_export_queue.py`
- 修改：`register/config.example.json`

- [ ] **步骤 1：新增 `_maybe_zdr_after_mint`**

放在 `_maybe_nsfw_and_sub2api` 旁（或在其开头/结尾调用）。逻辑：

```python
def _maybe_zdr_after_mint(
    mint_result: dict[str, Any],
    *,
    conf: dict[str, Any],
    proxy: str,
    log: LogFn,
    sso: str = "",
    cloudflare_cookies: str = "",
) -> None:
    """mint 后补刀关 ZDR：已 closed 则跳过；写 tag + patch auth。"""
    if not mint_result or not mint_result.get("ok"):
        return
    # 默认 true（A1）；仅显式 falsy 跳过
    raw = conf.get("enable_disable_zdr")
    if raw is None:
        raw = conf.get("enableDisableZdr")
    if raw is not None and not _truthy(raw):
        return
    try:
        from account_tags import get_tag, set_zdr_tag, patch_auth_file_zdr
        from zdr_toggle import disable_zdr_for_sso

        sso_val = (sso or "").strip()
        email_val = str(mint_result.get("email") or "").strip()
        paths = mint_result.get("paths") or (
            [mint_result.get("path")] if mint_result.get("path") else []
        )
        if not sso_val:
            for p in paths:
                if not p:
                    continue
                try:
                    doc = json.loads(Path(str(p)).read_text(encoding="utf-8"))
                    sso_val = str(doc.get("sso") or "").strip()
                    if not email_val:
                        email_val = str(doc.get("email") or "").strip()
                    if sso_val:
                        break
                except Exception:
                    continue
        prev = get_tag(email=email_val, sso=sso_val)
        if prev.get("zdr_attempted") and prev.get("zdr_closed") is True:
            log("[auth-queue] ZDR 已关，跳过补刀")
            for p in paths:
                if p:
                    try:
                        patch_auth_file_zdr(p, closed=True, error="")
                    except Exception:
                        pass
            return

        cf = ""
        raw_cf = (cloudflare_cookies or "").strip()
        if "cf_clearance=" in raw_cf:
            for part in raw_cf.split(";"):
                part = part.strip()
                if part.lower().startswith("cf_clearance="):
                    cf = part.split("=", 1)[-1].strip()
                    break
        elif raw_cf and "=" not in raw_cf:
            cf = raw_cf

        closed = False
        err = ""
        steps = None
        if sso_val:
            r = disable_zdr_for_sso(
                sso_val, cf_clearance=cf, proxy=proxy or "", log=log
            )
            closed = bool(r.get("ok"))
            err = str(r.get("error") or "")
            steps = r.get("steps")
            if closed:
                log(f"[auth-queue] ✔ ZDR 已关 · {r.get('message')}")
            else:
                log(f"[auth-queue] ✘ ZDR 仍开（不影响授权）: {err}")
        else:
            err = "no sso"
            log("[auth-queue] ZDR 跳过：无 SSO")

        set_zdr_tag(
            closed=closed, email=email_val, sso=sso_val, error=err, steps=steps
        )
        for p in paths:
            if p:
                try:
                    patch_auth_file_zdr(p, closed=closed, error=err)
                except Exception:
                    pass
        mint_result["zdr_closed"] = closed
        mint_result["zdr_attempted"] = True
        mint_result["zdr_error"] = err if not closed else ""
    except Exception as e:
        log(f"[auth-queue] zdr skip（不影响授权）: {e}")
```

- [ ] **步骤 2：在所有调用 `_maybe_nsfw_and_sub2api(...)` 的地方之后调用 `_maybe_zdr_after_mint(...)` 相同参数**

（当前约 539、587 两处；grep `_maybe_nsfw_and_sub2api` 全覆盖。）

- [ ] **步骤 3：`config.example.json` 增加**

```json
"enable_disable_zdr": true,
"_comment_enable_disable_zdr": "注册 SSO 导出前 + mint 后尝试关闭 ZDR；默认 true；失败标开不挡流水线",
```

- [ ] **步骤 4：Commit**

```bash
git add register/auth_export_queue.py register/config.example.json
git commit -m "feat(register): queue ZDR disable after mint + config flag"
```

---

### 任务 5：设置 + registerRuntime

**文件：**
- 修改：`src/shared/settings.ts`（`enableNsfw` 旁）
- 修改：`server/src/bot/registerRuntime.ts`（`enable_nsfw` 映射旁 ~384）
- 修改：`src/renderer/components/domain/SettingsForm.tsx`（NSFW ToggleRow 旁）

- [ ] **步骤 1：settings 类型与默认值**

在 `AppSettings` / defaults：

```ts
  /** 注册后 SSO 导出前尝试关闭 ZDR（失败标开、不挡流水线） */
  enableDisableZdr: boolean;
```

defaults：

```ts
  enableDisableZdr: true,
```

- [ ] **步骤 2：registerRuntime 写入 config.json**

```ts
  if ((settings as { enableDisableZdr?: boolean }).enableDisableZdr === false) {
    config.enable_disable_zdr = false;
  } else {
    // 默认 true（规格 A1）；undefined 也写 true
    config.enable_disable_zdr = true;
  }
```

- [ ] **步骤 3：SettingsForm ToggleRow**

紧挨 NSFW 开关：

```tsx
          <ToggleRow
            label="关闭 ZDR"
            hint="注册成功后、SSO 导出前用 SSO 尝试关 Zero Retention；probe 失败标「开」，不影响导出与授权"
            checked={draft.enableDisableZdr !== false}
            onChange={(v) => update('enableDisableZdr', v)}
          />
```

- [ ] **步骤 4：typecheck**

```powershell
npm run typecheck
```

预期：PASS（若 Settings 表单/序列化漏字段则修）。

- [ ] **步骤 5：Commit**

```bash
git add src/shared/settings.ts server/src/bot/registerRuntime.ts src/renderer/components/domain/SettingsForm.tsx
git commit -m "feat: enableDisableZdr setting default true + runtime config"
```

---

### 任务 6：TS 侧车解析 + Store 合并

**文件：**
- 修改：`server/src/accountTags.ts`
- 修改：`server/src/accountStore.ts`
- 修改：`server/src/cpaAuthStore.ts`
- 修改：`src/shared/runEvents.ts`
- 修改：`src/shared/ipc.ts`

- [ ] **步骤 1：扩展共享类型**

`runEvents.ts` AccountRecord 在 nsfw 后：

```ts
  /** ZDR：true=已关 / false=仍开或失败 / null=未尝试 */
  zdrClosed?: boolean | null;
  zdrAttempted?: boolean;
  zdrAt?: string;
  zdrError?: string;
  /** closed | open | none */
  zdrStatus?: 'closed' | 'open' | 'none';
```

`ipc.ts` CpaAuthItem 同样字段。

- [ ] **步骤 2：accountTags.ts**

扩展 `AccountTagEntry`：

```ts
  zdr_closed?: boolean;
  zdr_attempted?: boolean;
  zdr_at?: string;
  zdr_error?: string;
```

新增（可复用 `lookupNsfwTag` 同一 lookup，因 entry 已合并；或别名 `lookupAccountTag = lookupNsfwTag`）：

```ts
export type ZdrUiStatus = 'closed' | 'open' | 'none';

export function zdrStatusFromTag(tag: AccountTagEntry | null | undefined): {
  zdrClosed: boolean | null;
  zdrAttempted: boolean;
  zdrAt?: string;
  zdrError?: string;
  zdrStatus: ZdrUiStatus;
} {
  if (!tag || !tag.zdr_attempted) {
    return { zdrClosed: null, zdrAttempted: false, zdrStatus: 'none' };
  }
  if (tag.zdr_closed === true) {
    return {
      zdrClosed: true,
      zdrAttempted: true,
      zdrAt: tag.zdr_at,
      zdrStatus: 'closed'
    };
  }
  return {
    zdrClosed: false,
    zdrAttempted: true,
    zdrAt: tag.zdr_at,
    zdrError: tag.zdr_error,
    zdrStatus: 'open'
  };
}
```

- [ ] **步骤 3：accountStore listAccounts**

在现有 nsfw 合并 map 内同时：

```ts
      const zdr = zdrStatusFromTag(
        lookupNsfwTag(tags, {
          email: a.email,
          sso: a.sso,
          ssoHash: a.sso ? ssoHashHex(a.sso) : undefined
        })
      );
      return {
        ...a,
        nsfwEnabled: side.nsfwEnabled,
        // ...existing nsfw...
        nsfwStatus: side.nsfwStatus,
        zdrClosed: zdr.zdrClosed,
        zdrAttempted: zdr.zdrAttempted,
        zdrAt: zdr.zdrAt,
        zdrError: zdr.zdrError,
        zdrStatus: zdr.zdrStatus
      } as AccountRecord;
```

- [ ] **步骤 4：cpaAuthStore 列表项**

镜像 nsfw 块（auth JSON 优先，否则侧车）：

```ts
      let zdrClosed: boolean | null = null;
      let zdrAttempted = false;
      let zdrAt: string | null = null;
      let zdrError: string | null = null;
      if (data.zdr_attempted === true || data.zdrAttempted === true) {
        zdrAttempted = true;
        zdrClosed = data.zdr_closed === true || data.zdrClosed === true;
        zdrAt = String(data.zdr_at || data.zdrAt || '').trim() || null;
        zdrError = String(data.zdr_error || data.zdrError || '').trim() || null;
      } else {
        const sideZ = zdrStatusFromTag(
          lookupNsfwTag(accountTags, {
            email: emailStr,
            ssoHash: ssoHash || undefined
          })
        );
        zdrClosed = sideZ.zdrClosed;
        zdrAttempted = sideZ.zdrAttempted;
        zdrAt = sideZ.zdrAt || null;
        zdrError = sideZ.zdrError || null;
      }
      const zdrStatus: 'closed' | 'open' | 'none' = !zdrAttempted
        ? 'none'
        : zdrClosed
          ? 'closed'
          : 'open';
```

推入 `items.push({ ..., zdrClosed, zdrAttempted, zdrAt, zdrError, zdrStatus })`。

- [ ] **步骤 5：typecheck + Commit**

```powershell
npm run typecheck
git add server/src/accountTags.ts server/src/accountStore.ts server/src/cpaAuthStore.ts src/shared/runEvents.ts src/shared/ipc.ts
git commit -m "feat: merge zdr tags into SSO and Auth stores"
```

---

### 任务 7：ZdrBadge + Pool + Auth UI

**文件：**
- 创建：`src/renderer/components/domain/ZdrBadge.tsx`
- 修改：`src/renderer/pages/PoolPage.tsx`
- 修改：`src/renderer/pages/AuthPage.tsx`

- [ ] **步骤 1：创建 ZdrBadge**

```tsx
import { cn } from '@renderer/lib/cn';

/** ZDR：关=已关闭 / 开=仍开或失败 / 灰=未尝试 */
export function ZdrBadge({
  status,
  error,
  className
}: {
  status?: 'closed' | 'open' | 'none' | null;
  error?: string | null;
  className?: string;
}) {
  const s = status || 'none';
  if (s === 'closed') {
    return (
      <span
        title="ZDR 已关闭（probe 非 Zero Retention）"
        className={cn(
          'inline-flex items-center rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400',
          className
        )}
      >
        ZDR关
      </span>
    );
  }
  if (s === 'open') {
    return (
      <span
        title={error ? `ZDR 仍开: ${error}` : 'ZDR 未关闭或探测仍为开（不影响授权）'}
        className={cn(
          'inline-flex items-center rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400',
          className
        )}
      >
        ZDR开
      </span>
    );
  }
  return (
    <span
      title="未尝试关闭 ZDR"
      className={cn('inline-flex items-center text-[10px] text-muted-foreground', className)}
    >
      —
    </span>
  );
}
```

- [ ] **步骤 2：PoolPage**

`import { ZdrBadge } from '...'`，在 `NsfwBadge` 旁：

```tsx
          <ZdrBadge
            status={
              account.zdrStatus ??
              (account.zdrAttempted
                ? account.zdrClosed
                  ? 'closed'
                  : 'open'
                : 'none')
            }
            error={account.zdrError}
          />
```

- [ ] **步骤 3：AuthPage**

表头 NSFW 后增加：

```tsx
                <th className="w-[3.5rem] px-2 py-2.5 font-medium">ZDR</th>
```

单元格 NSFW 列后：

```tsx
                    <td className="w-[3.5rem] min-w-[3.5rem] px-2 py-2.5">
                      <ZdrBadge
                        status={
                          item.zdrStatus ??
                          (item.zdrAttempted
                            ? item.zdrClosed
                              ? 'closed'
                              : 'open'
                            : 'none')
                        }
                        error={item.zdrError}
                      />
                    </td>
```

- [ ] **步骤 4：typecheck + server build + Commit**

```powershell
npm run typecheck
npm run server:build
git add src/renderer/components/domain/ZdrBadge.tsx src/renderer/pages/PoolPage.tsx src/renderer/pages/AuthPage.tsx
git commit -m "feat(ui): ZdrBadge on SSO pool and Auth column"
```

---

### 任务 8：端到端验收

- [ ] **步骤 1：Python 单测全绿**

```powershell
cd register
python -m pytest tests/test_zdr_toggle.py -v
```

- [ ] **步骤 2：TS 构建**

```powershell
npm run typecheck
npm run server:build
```

- [ ] **步骤 3：手工冒烟清单（有真号时）**

1. 设置「关闭 ZDR」保持开。
2. 跑一轮注册，日志应出现 `[zdr]`。
3. SSO 号池出现 ZDR关 或 ZDR开 tag。
4. Auth 转换后该列有值；auth JSON 含 `zdr_closed` / `zdr_attempted`。
5. 关闭设置开关后新账号应为 —（未尝试）。

- [ ] **步骤 4：最终 commit（若有修）**

```bash
git status
# 若有遗漏修复
git commit -m "fix: disable-ZDR wiring polish"
```

---

## 规格覆盖自检

| 规格需求 | 任务 |
|----------|------|
| disable_zdr_for_sso + 候选 keys + probe | 任务 1 |
| set_zdr_tag / patch_auth_file_zdr | 任务 2 |
| SSO 落盘前调用 | 任务 3 |
| 队列补刀 + 幂等 | 任务 4 |
| enableDisableZdr 默认 true + runtime | 任务 5 |
| AccountRecord / CpaAuthItem / stores | 任务 6 |
| ZdrBadge SSO tag + Auth 列 | 任务 7 |
| 失败不挡 / 保守标开 | 任务 1 判定逻辑 + 3/4 try/except |
| 非目标（不做 UI 点控件 / 企业合同） | 未列入任务 |

## 占位符扫描

无 TODO/待定；feature keys 列表为可运行常量（可后续 HAR 增补，不阻塞合并）。

## 类型一致性

- `zdrStatus`: `'closed' \| 'open' \| 'none'`（全栈统一，**不用** ok/fail）
- `zdrClosed` boolean vs 侧车 `zdr_closed`
- 配置：`enableDisableZdr`（TS）↔ `enable_disable_zdr`（Python config.json）
