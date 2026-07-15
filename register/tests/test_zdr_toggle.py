# -*- coding: utf-8 -*-
import json
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


def test_set_zdr_tag_and_patch_auth(tmp_path, monkeypatch):
    import account_tags as at

    tag_path = tmp_path / "account_tags.json"
    monkeypatch.setattr(at, "_PATH", tag_path)
    tag = at.set_zdr_tag(closed=True, email="a@b.com", sso="x" * 20, error="")
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
