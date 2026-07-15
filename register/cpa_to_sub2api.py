# -*- coding: utf-8 -*-
"""P3: CPA xai auth JSON → sub2api accounts 导出。"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

LogFn = Callable[[str], None]


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _email_key(email: str) -> str:
    return str(email or "").strip().lower().replace("@", "_at_").replace(".", "_")


def cpa_xai_to_sub2api_account(
    cpa: dict[str, Any],
    *,
    source: str = "cpa_xai",
) -> dict[str, Any]:
    email = str(cpa.get("email") or "").strip()
    name = email or str(cpa.get("name") or cpa.get("sub") or "xai")
    return {
        "name": name,
        "provider": "xai",
        "auth": {
            "access_token": cpa.get("access_token") or "",
            "refresh_token": cpa.get("refresh_token") or "",
            "id_token": cpa.get("id_token"),
            "expires_at": cpa.get("expires_at") or cpa.get("expired"),
            "token_type": cpa.get("token_type") or "Bearer",
            "client_id": cpa.get("client_id") or "",
            "token_endpoint": cpa.get("token_endpoint")
            or "https://auth.x.ai/oauth2/token",
            "redirect_uri": cpa.get("redirect_uri")
            or "http://127.0.0.1:56121/callback",
            "headers": cpa.get("headers") or {},
        },
        "extra": {
            "email": email,
            "email_key": _email_key(email),
            "name": name,
            "auth_provider": "xai",
            "source": source,
            "mint_channel": cpa.get("mint_channel"),
            "has_grok_45": cpa.get("has_grok_45"),
            "last_refresh": cpa.get("last_refresh") or _now_iso(),
        },
    }


def build_sub2api_document(accounts: list[dict[str, Any]]) -> dict[str, Any]:
    return {"exported_at": _now_iso(), "proxies": [], "accounts": accounts}


def convert_cpa_file(
    cpa_path: str | Path,
    out_dir: str | Path | None = None,
) -> tuple[Path, dict[str, Any]]:
    cpa_path = Path(cpa_path).expanduser().resolve()
    cpa = json.loads(cpa_path.read_text(encoding="utf-8-sig"))
    account = cpa_xai_to_sub2api_account(cpa, source="cpa_xai")
    doc = build_sub2api_document([account])
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
    out_file.write_text(
        json.dumps(build_sub2api_document(accounts), ensure_ascii=False, indent=2)
        + "\n",
        encoding="utf-8",
    )
    return out_file


def export_after_cpa_result(
    result: dict[str, Any],
    config: dict[str, Any] | None = None,
    log: Optional[LogFn] = None,
) -> dict[str, Any]:
    """mint 成功后可选导出 sub2api。config.sub2api_export_enabled 默认 False。"""
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
    # 默认 data/sub2api（相对 register/）
    raw_out = cfg.get("sub2api_export_dir") or "data/sub2api"
    out_dir = Path(str(raw_out))
    if not out_dir.is_absolute():
        out_dir = (reg_dir / out_dir).resolve()
    cpa_dir = Path(
        cfg.get("cpa_auth_dir") or cfg.get("auth_dir") or (reg_dir / "data" / "auth")
    )
    if not cpa_dir.is_absolute():
        cpa_dir = (reg_dir / cpa_dir).resolve()
    # 常见目录：data/auth
    if not cpa_dir.is_dir():
        alt = reg_dir / "data" / "auth"
        if alt.is_dir():
            cpa_dir = alt

    single_paths: list[str] = []
    for cp in paths:
        try:
            sp, _ = convert_cpa_file(cp, out_dir=out_dir)
            single_paths.append(str(sp))
            log(f"[sub2api] export -> {sp}")
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
