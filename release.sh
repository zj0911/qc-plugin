#!/bin/bash
# ============================================================
# 质检优化助手 - 一键打包 + 发布脚本
# 用法: bash release.sh
# 前置: 先手动修改 manifest.json 里的 version
# ============================================================
set -e

CHROME_EXE="C:/Program Files/Google/Chrome/Application/chrome.exe"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PEM_FILE="${SCRIPT_DIR}/extension.pem"
RELEASES_DIR="${SCRIPT_DIR}/releases"

mkdir -p "${RELEASES_DIR}"

# ---- 1. 检查私钥 ----
if [ ! -f "${PEM_FILE}" ]; then
  echo "[1/5] 🔑 未找到 extension.pem，正在生成..."
  openssl genpkey -algorithm RSA -out "${PEM_FILE}" -pkeyopt rsa_keygen_bits:2048
  echo "      ✅ 私钥已生成。请备份 extension.pem！此文件不能丢失。"
else
  echo "[1/5] 🔑 已有私钥，跳过。"
fi

# ---- 2. 读版本号 ----
VERSION=$(grep -oP '"version"\s*:\s*"\K[0-9.]+' "${SCRIPT_DIR}/manifest.json")
if [ -z "$VERSION" ]; then
  echo "❌ 无法从 manifest.json 读取版本号"
  exit 1
fi
echo "[2/5] 📋 版本: ${VERSION}"

# ---- 3. 打包 .crx ----
CRX_FILE="${RELEASES_DIR}/extension_${VERSION}.crx"
echo "[3/5] 📦 正在打包..."
if [ -f "${CRX_FILE}" ]; then
  rm -f "${CRX_FILE}"
fi

# 用 Chrome 打包（避免弹出对话框需关闭所有 Chrome 窗口）
"${CHROME_EXE}" --pack-extension="${SCRIPT_DIR}" \
                --pack-extension-key="${PEM_FILE}" \
                --no-message-box 2>/dev/null

# Chrome 把 .crx 生成在脚本目录的父目录
PARENT_CRX="$(dirname "${SCRIPT_DIR}")/$(basename "${SCRIPT_DIR}").crx"
if [ -f "${PARENT_CRX}" ]; then
  mv "${PARENT_CRX}" "${CRX_FILE}"
  echo "      ✅ ${CRX_FILE}"
else
  echo "      ⚠️ 自动打包失败，尝试用 openssl 手动打包..."
  # Fallback: 手动 ZIP + 签名头
  TMP_ZIP="${RELEASES_DIR}/extension_${VERSION}.zip"
  cd "${SCRIPT_DIR}"
  zip -r "${TMP_ZIP}" . -x "releases/*" ".git/*" "*.sh" "*.md"
  cd -
  openssl sha256 -sign "${PEM_FILE}" <(openssl sha256 -binary < "${TMP_ZIP}") > "${CRX_FILE}.sig"
  cat "${CRX_FILE}.sig" "${TMP_ZIP}" > "${CRX_FILE}"
  rm -f "${TMP_ZIP}" "${CRX_FILE}.sig"
  echo "      ✅ ${CRX_FILE} (手动打包)"
fi

# ---- 4. 更新 extension.xml ----
# 跳过了自动计算 extension ID（需要私钥在浏览器首次加载时确定）
# 首次使用请在 chrome://extensions 查看扩展 ID 后手动填入
echo "[4/5] 📄 更新 extension.xml ..."
cat > "${SCRIPT_DIR}/updates/extension.xml" << XML
<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/protocol" protocol="2.0">
  <app appid="YOUR_EXTENSION_ID_HERE">
    <updatecheck codebase="https://raw.githubusercontent.com/zj0911/qc-plugin/main/releases/extension_${VERSION}.crx"
                 version="${VERSION}" />
  </app>
</gupdate>
XML
echo "      ⚠️ 请手动把 XML 里的 YOUR_EXTENSION_ID_HERE 替换为实际扩展 ID"

# ---- 5. Git 提交 & 推送 ----
echo "[5/5] 🚀 推送到 GitHub ..."
cd "${SCRIPT_DIR}"
git add -A
git commit -m "release: v${VERSION}" || echo "      (无变更可提交)"
git tag "v${VERSION}" 2>/dev/null || true
git push origin main --tags
echo "      ✅ 已推送"

echo ""
echo "============================================"
echo "✅ 发布完成！"
echo ""
echo "⚠️ 请检查两件事："
echo "1. chrome://extensions 查看你的扩展 ID"
echo "2. 把 updates/extension.xml 里的 YOUR_EXTENSION_ID_HERE 替换为实际 ID，重新提交"
echo ""
echo "用户将在 5 小时内自动更新到 ${VERSION}"
echo "============================================"