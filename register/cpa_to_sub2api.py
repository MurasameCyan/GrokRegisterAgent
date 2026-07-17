# -*- coding: utf-8 -*-
"""P3: CPA xai auth JSON → sub2api 官方 ImportData 形态（可直接导入）。

对齐 Wei-Shaw/sub2api：
- 文档头：type=sub2api-data / version=1 / proxies / accounts
  （frontend ImportDataModal.isValidDataPayload + backend validateDataHeader）
- 账号：platform=grok, type=oauth, credentials 扁平
  （domain.PlatformGrok + AccountTypeOAuth + DataAccount）
- credentials 字段对齐 GrokOAuthService.BuildAccountCredentials
  （access_token / expires_at / refresh_token / token_type / id_token /
   client_id / email / sub / base_url …）
- xai 溯源标签只放 extra（不污染 credentials，避免非官方键干扰）
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

LogFn = Callable[[str], None]

# sub2api domain constants
SUB2API_PLATFORM_GROK = "grok"
SUB2API_ACCOUNT_TYPE_OAUTH = "oauth"
SUB2API_DATA_TYPE = "sub2api-data"
SUB2API_DATA_VERSION = 1

# xai.DefaultClientID / DefaultCLIBaseURL
XAI_DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
XAI_DEFAULT_CLI_BASE_URL = "https://cli-chat-proxy.grok.com/v1"


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _email_key(email: str) -> str:
    return str(email or "").strip().lower().replace("@", "_at_").replace(".", "_")


def _parse_expires_unix(raw: Any) -> Optional[int]:
    """Parse various expiry forms → unix seconds (for DataAccount.expires_at)."""
    if raw is None or raw == "":
        return None
    if isinstance(raw, (int, float)):
        ts = float(raw)
        if ts > 1e12:  # ms
            ts = ts / 1000.0
        if ts > 1e9:
            return int(ts)
        return None
    s = str(raw).strip()
    if not s:
        return None
    if re.fullmatch(r"\d+(\.\d+)?", s):
        return _parse_expires_unix(float(s))
    # ISO
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    except ValueError:
        return None


def _normalize_expires_at(raw: Any) -> str:
    """Normalize expires to RFC3339 UTC string (credentials.expires_at).

    Go time.RFC3339 / sub2api BuildAccountCredentials 使用该格式。
    """
    unix = _parse_expires_unix(raw)
    if unix is not None:
        try:
            return (
                datetime.fromtimestamp(unix, tz=timezone.utc)
                .replace(microsecond=0)
                .isoformat()
                .replace("+00:00", "Z")
            )
        except (OSError, OverflowError, ValueError):
            pass
    s = str(raw or "").strip()
    if not s:
        return ""
    if re.match(r"^\d{4}-\d{2}-\d{2}T", s):
        if s.endswith("+00:00"):
            return s[:-6] + "Z"
        return s
    return s


def _cpa_tokens(cpa: dict[str, Any]) -> tuple[str, str]:
    """Extract access/refresh from CPA flat auth or nested auth/credentials."""
    access = str(cpa.get("access_token") or "").strip()
    refresh = str(cpa.get("refresh_token") or "").strip()
    if not access or not refresh:
        nested = cpa.get("auth") if isinstance(cpa.get("auth"), dict) else None
        if not nested and isinstance(cpa.get("credentials"), dict):
            nested = cpa.get("credentials")
        if isinstance(nested, dict):
            access = access or str(nested.get("access_token") or "").strip()
            refresh = refresh or str(nested.get("refresh_token") or "").strip()
    return access, refresh


def cpa_xai_to_sub2api_account(
    cpa: dict[str, Any],
    *,
    source: str = "cpa_xai",
) -> dict[str, Any]:
    """CPA/xai auth → sub2api DataAccount（可直接 ImportData）。

    必填（与 validateDataAccount 一致）：
      name, platform=grok, type=oauth, credentials(非空且含 token)
    credentials 仅含官方 BuildAccountCredentials 键。
    """
    email = str(cpa.get("email") or "").strip()
    name = email or str(cpa.get("name") or cpa.get("sub") or "grok-oauth")
    access, refresh = _cpa_tokens(cpa)
    if not access:
        raise ValueError("missing access_token")
    if not refresh:
        raise ValueError("missing refresh_token")

    client_id = (
        str(cpa.get("client_id") or "").strip()
        or (
            str((cpa.get("auth") or {}).get("client_id") or "").strip()
            if isinstance(cpa.get("auth"), dict)
            else ""
        )
        or XAI_DEFAULT_CLIENT_ID
    )
    expired_raw = (
        cpa.get("expires_at")
        or cpa.get("expired")
        or (
            (cpa.get("auth") or {}).get("expires_at")
            if isinstance(cpa.get("auth"), dict)
            else None
        )
    )
    expires_at = _normalize_expires_at(expired_raw)
    base_url = (
        str(cpa.get("base_url") or "").strip()
        or XAI_DEFAULT_CLI_BASE_URL
    )
    if base_url.endswith("cli-chat-proxy.grok.com"):
        base_url = base_url + "/v1"
    base_url = base_url.rstrip("/")
    if not base_url.endswith("/v1") and "cli-chat-proxy.grok.com" in base_url:
        base_url = base_url + "/v1"

    # —— 与 sub2api BuildAccountCredentials 一致（仅官方键）——
    credentials: dict[str, Any] = {
        "access_token": access,
        "refresh_token": refresh,
        "token_type": str(cpa.get("token_type") or "Bearer"),
        "client_id": client_id,
        "base_url": base_url or XAI_DEFAULT_CLI_BASE_URL,
    }
    if expires_at:
        credentials["expires_at"] = expires_at
    id_token = cpa.get("id_token")
    if not id_token and isinstance(cpa.get("auth"), dict):
        id_token = cpa["auth"].get("id_token")
    if id_token:
        credentials["id_token"] = str(id_token).strip()
    if email:
        credentials["email"] = email
    sub = str(cpa.get("sub") or "").strip()
    if sub:
        credentials["sub"] = sub
    for opt_key in (
        "scope",
        "team_id",
        "subscription_tier",
        "entitlement_status",
    ):
        val = cpa.get(opt_key)
        if val is not None and str(val).strip():
            credentials[opt_key] = val

    account: dict[str, Any] = {
        "name": name,
        "platform": SUB2API_PLATFORM_GROK,
        "type": SUB2API_ACCOUNT_TYPE_OAUTH,
        "credentials": credentials,
        "extra": {
            # xai 溯源标签（平台仍是 grok；sub2api 调度认 platform）
            "auth_provider": "xai",
            "provider": "xai",
            "source": source,
            "email": email,
            "email_key": _email_key(email),
            "name": name,
            "mint_channel": cpa.get("mint_channel"),
            "has_grok_45": cpa.get("has_grok_45"),
            "last_refresh": cpa.get("last_refresh") or _now_iso(),
        },
        "concurrency": int(cpa.get("concurrency") or 1),
        "priority": int(cpa.get("priority") or 0),
    }

    # 对齐 GrokSession2CPA / sub2api 惯例：
    # - 有 refresh：不写账号级 expires_at / auto_pause（access≈6h，写了会被 pause）
    # - 无 refresh：才钉 access exp + auto_pause
    # credentials.expires_at 仍保留，供 token 级展示/刷新
    if not refresh:
        exp_unix = _parse_expires_unix(expired_raw)
        if exp_unix is not None:
            account["expires_at"] = exp_unix
            account["auto_pause_on_expired"] = True

    return account


def build_sub2api_document(accounts: list[dict[str, Any]]) -> dict[str, Any]:
    """官方 Export/Import 文档（ImportDataModal 可直接选文件导入）。"""
    return {
        "type": SUB2API_DATA_TYPE,
        "version": SUB2API_DATA_VERSION,
        "exported_at": _now_iso(),
        "proxies": [],
        "accounts": accounts,
    }


def is_sub2api_importable(doc: dict[str, Any]) -> tuple[bool, str]:
    """轻量自检：是否满足 sub2api 前端 + validateDataAccount 最低条件。"""
    if not isinstance(doc, dict):
        return False, "not an object"
    t = doc.get("type")
    if t not in (None, "", SUB2API_DATA_TYPE, "sub2api-bundle"):
        return False, f"unsupported type: {t}"
    ver = doc.get("version")
    if ver not in (None, 0, SUB2API_DATA_VERSION):
        return False, f"unsupported version: {ver}"
    if not isinstance(doc.get("proxies"), list):
        return False, "proxies must be array"
    accounts = doc.get("accounts")
    if not isinstance(accounts, list):
        return False, "accounts must be array"
    if not accounts:
        return False, "accounts empty"
    for i, acc in enumerate(accounts):
        if not isinstance(acc, dict):
            return False, f"accounts[{i}] not object"
        if not str(acc.get("name") or "").strip():
            return False, f"accounts[{i}] missing name"
        if str(acc.get("platform") or "").strip() != SUB2API_PLATFORM_GROK:
            return False, f"accounts[{i}] platform must be grok"
        if str(acc.get("type") or "").strip() != SUB2API_ACCOUNT_TYPE_OAUTH:
            return False, f"accounts[{i}] type must be oauth"
        creds = acc.get("credentials")
        if not isinstance(creds, dict) or not creds:
            return False, f"accounts[{i}] credentials required"
        if not str(creds.get("access_token") or "").strip():
            return False, f"accounts[{i}] missing access_token"
        if not str(creds.get("refresh_token") or "").strip():
            return False, f"accounts[{i}] missing refresh_token"
    return True, "ok"


def convert_cpa_file(
    cpa_path: str | Path,
    out_dir: str | Path | None = None,
) -> tuple[Path, dict[str, Any]]:
    cpa_path = Path(cpa_path).expanduser().resolve()
    cpa = json.loads(cpa_path.read_text(encoding="utf-8-sig"))
    account = cpa_xai_to_sub2api_account(cpa, source="cpa_xai")
    doc = build_sub2api_document([account])
    ok, reason = is_sub2api_importable(doc)
    if not ok:
        raise ValueError(f"sub2api importable check failed: {reason}")
    reg_dir = Path(__file__).resolve().parent
    out_dir = Path(out_dir or (reg_dir / "data" / "sub2api")).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"sub2api-{cpa_path.stem}.json"
    out_file.write_text(
        json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return out_file, doc


def rebuild_combined(cpa_dir: str | Path, out_file: str | Path) -> Path:
    cpa_dir = Path(cpa_dir).expanduser().resolve()
    accounts: list[dict[str, Any]] = []
    for p in sorted(cpa_dir.glob("xai-*.json")):
        try:
            cpa = json.loads(p.read_text(encoding="utf-8-sig"))
            accounts.append(cpa_xai_to_sub2api_account(cpa, source="cpa_xai"))
        except Exception:
            continue
    out_file = Path(out_file).expanduser().resolve()
    out_file.parent.mkdir(parents=True, exist_ok=True)
    doc = build_sub2api_document(accounts)
    out_file.write_text(
        json.dumps(doc, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return out_file


def export_after_cpa_result(
    result: dict[str, Any],
    config: dict[str, Any] | None = None,
    log: Optional[LogFn] = None,
) -> dict[str, Any]:
    """mint 成功后可选导出 sub2api。config.sub2api_export_enabled 默认 False。

    产出文件可直接在 sub2api 管理端「导入数据」选中使用。
    """
    cfg = config or {}
    log = log or (lambda m: None)
    enabled = cfg.get("sub2api_export_enabled")
    if enabled is None:
        enabled = cfg.get("sub2apiExportEnabled")
    if not enabled:
        return {"ok": False, "skipped": True, "reason": "disabled"}

    paths: list[str] = []
    if result.get("path"):
        paths.append(str(result["path"]))
    for p in result.get("paths") or []:
        if p and str(p) not in paths:
            paths.append(str(p))
    if not paths:
        return {"ok": False, "error": "missing cpa path"}

    reg_dir = Path(__file__).resolve().parent
    raw_out = cfg.get("sub2api_export_dir") or "data/sub2api"
    out_dir = Path(str(raw_out))
    if not out_dir.is_absolute():
        out_dir = (reg_dir / out_dir).resolve()
    cpa_dir = Path(
        cfg.get("cpa_auth_dir") or cfg.get("auth_dir") or (reg_dir / "data" / "auth")
    )
    if not cpa_dir.is_absolute():
        cpa_dir = (reg_dir / cpa_dir).resolve()
    if not cpa_dir.is_dir():
        alt = reg_dir / "data" / "auth"
        if alt.is_dir():
            cpa_dir = alt

    single_paths: list[str] = []
    for cp in paths:
        try:
            sp, doc = convert_cpa_file(cp, out_dir=out_dir)
            single_paths.append(str(sp))
            n = len((doc.get("accounts") or []))
            log(f"[sub2api] export ok (importable) accounts={n} -> {sp}")
        except Exception as e:
            log(f"[sub2api] convert fail {cp}: {e}")

    combined_path = Path(
        cfg.get("sub2api_combined_file") or (out_dir / "sub2api-accounts.json")
    )
    if not combined_path.is_absolute():
        combined_path = (out_dir / combined_path.name).resolve()
    try:
        rebuild_combined(cpa_dir, combined_path)
        log(f"[sub2api] combined -> {combined_path}")
    except Exception as e:
        log(f"[sub2api] combined fail: {e}")

    return {
        "ok": bool(single_paths),
        "paths": single_paths,
        "combined_path": str(combined_path),
    }
