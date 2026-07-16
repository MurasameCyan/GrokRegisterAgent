#!/usr/bin/env bash
# 下载 sing-box Linux 客户端到 register/bin/sing-box/linux-{amd64,arm64}
# 供 GitHub Actions 在 docker build 前调用；二进制不入库。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${ROOT}/register/bin/sing-box"
VERSION="${SING_BOX_VERSION:-1.13.14}"
# 默认同时拉 amd64 + arm64（多架构镜像与 cfwp 一致）
ARCHS="${SING_BOX_ARCHS:-amd64 arm64}"

mkdir -p "${OUT_DIR}"

for arch in ${ARCHS}; do
  case "${arch}" in
    amd64|arm64|arm) ;;
    *)
      echo "unsupported arch: ${arch}" >&2
      exit 1
      ;;
  esac
  url="https://github.com/SagerNet/sing-box/releases/download/v${VERSION}/sing-box-${VERSION}-linux-${arch}.tar.gz"
  tmp="$(mktemp -d)"
  echo "fetching ${url}"
  curl -fsSL "${url}" -o "${tmp}/sing-box.tgz"
  tar -xzf "${tmp}/sing-box.tgz" -C "${tmp}"
  bin="$(find "${tmp}" -type f -name sing-box | head -n1)"
  if [[ -z "${bin}" ]]; then
    echo "sing-box binary not found in archive for ${arch}" >&2
    exit 1
  fi
  install -m 755 "${bin}" "${OUT_DIR}/linux-${arch}"
  rm -rf "${tmp}"
  echo "OK ${OUT_DIR}/linux-${arch} ($(wc -c < "${OUT_DIR}/linux-${arch}") bytes)"
done

ls -la "${OUT_DIR}"
