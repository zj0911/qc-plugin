#!/bin/bash
# ============================================================
# 质检优化助手 - 仅打包 .crx（不推送）
# 用法: bash build_crx.sh
# ============================================================
set -e

CHROME_EXE="C:/Program Files/Google/Chrome/Application/chrome.exe"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PEM_FILE="${SCRIPT_DIR}/extension.pem"
RELEASES_DIR="${SCRIPT_DIR}/releases"

mkdir -p "${RELEASES_DIR}"

VERSION=$(grep -oP '"version"\s*:\s*"\K[0-9.]+' "${SCRIPT_DIR}/manifest.json")
echo "当前版本: ${VERSION}"

CRX_FILE="${RELEASES_DIR}/extension_${VERSION}.crx"
[ -f "${CRX_FILE}" ] && rm -f "${CRX_FILE}"

"${CHROME_EXE}" --pack-extension="${SCRIPT_DIR}" \
                --pack-extension-key="${PEM_FILE}" \
                --no-message-box 2>/dev/null

PARENT_CRX="$(dirname "${SCRIPT_DIR}")/$(basename "${SCRIPT_DIR}").crx"
if [ -f "${PARENT_CRX}" ]; then
  mv "${PARENT_CRX}" "${CRX_FILE}"
  echo "✅ 打包完成: ${CRX_FILE}"
else
  echo "❌ 打包失败，请确保 Chrome 已安装且路径正确"
  exit 1
fi