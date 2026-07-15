"""Minimal protobuf / gRPC-web helpers for AuthManagement RPCs.

Field numbers verified from capture_out/rpc (2026-07-14).
"""
from __future__ import annotations

import struct
from typing import Iterable


def encode_varint(n: int) -> bytes:
    out = bytearray()
    n = int(n)
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            break
    return bytes(out)


def encode_key(field_no: int, wire_type: int) -> bytes:
    return encode_varint((field_no << 3) | wire_type)


def encode_string(field_no: int, value: str) -> bytes:
    raw = (value or "").encode("utf-8")
    return encode_key(field_no, 2) + encode_varint(len(raw)) + raw


def encode_bytes(field_no: int, value: bytes) -> bytes:
    value = value or b""
    return encode_key(field_no, 2) + encode_varint(len(value)) + value


def encode_bool(field_no: int, value: bool) -> bytes:
    return encode_key(field_no, 0) + encode_varint(1 if value else 0)


def encode_int(field_no: int, value: int) -> bytes:
    return encode_key(field_no, 0) + encode_varint(value)


def join_fields(parts: Iterable[bytes]) -> bytes:
    return b"".join(parts)


def wrap_grpc_web(payload: bytes) -> bytes:
    payload = payload or b""
    return b"\x00" + struct.pack(">I", len(payload)) + payload


def unwrap_grpc_web(frame: bytes) -> bytes:
    if not frame or len(frame) < 5:
        return frame or b""
    out = bytearray()
    i = 0
    while i + 5 <= len(frame):
        flags = frame[i]
        ln = struct.unpack(">I", frame[i + 1 : i + 5])[0]
        i += 5
        chunk = frame[i : i + ln]
        i += ln
        if flags == 0:
            out.extend(chunk)
    return bytes(out) if out else frame


def scan_strings(blob: bytes, min_len: int = 3) -> list[str]:
    found = []
    i = 0
    n = len(blob or b"")
    while i < n:
        if 32 <= blob[i] < 127:
            j = i
            while j < n and 32 <= blob[j] < 127:
                j += 1
            if j - i >= min_len:
                found.append(blob[i:j].decode("ascii", errors="ignore"))
            i = j + 1
        else:
            i += 1
    return found


# Verified field maps
CREATE_EMAIL_FIELDS = {"email": 1, "castle_request_token": 3}
VERIFY_CODE_FIELDS = {"email": 1, "code": 2}
VALIDATE_PASSWORD_FIELDS = {"email": 4, "password": 5}


def encode_create_email_validation_code(email: str, castle_token: str) -> bytes:
    payload = join_fields(
        [
            encode_string(CREATE_EMAIL_FIELDS["email"], email),
            encode_string(CREATE_EMAIL_FIELDS["castle_request_token"], castle_token),
        ]
    )
    return wrap_grpc_web(payload)


def encode_verify_email_validation_code(email: str, code: str) -> bytes:
    clean = str(code or "").replace("-", "").strip()
    payload = join_fields(
        [
            encode_string(VERIFY_CODE_FIELDS["email"], email),
            encode_string(VERIFY_CODE_FIELDS["code"], clean),
        ]
    )
    return wrap_grpc_web(payload)


def encode_validate_password(email: str, password: str) -> bytes:
    payload = join_fields(
        [
            encode_string(VALIDATE_PASSWORD_FIELDS["email"], email),
            encode_string(VALIDATE_PASSWORD_FIELDS["password"], password),
        ]
    )
    return wrap_grpc_web(payload)
