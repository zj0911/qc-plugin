#!/usr/bin/env python3
"""手动打包 Chrome 扩展为 .crx 文件（CRX v2 格式，无需启动 Chrome）"""
import os, sys, struct, hashlib, subprocess, json, zipfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PEM_FILE = os.path.join(SCRIPT_DIR, "extension.pem")
RELEASES_DIR = os.path.join(SCRIPT_DIR, "releases")

def run_binary(cmd):
    """运行命令并返回原始二进制 stdout"""
    p = subprocess.run(cmd, shell=True, capture_output=True)
    if p.returncode != 0:
        print(f"命令失败: {cmd}\n{p.stderr.decode()}")
        sys.exit(1)
    return p.stdout

# 1. 生成私钥（仅首次）
if not os.path.exists(PEM_FILE):
    print("[1/4] 生成私钥 extension.pem ...")
    run_binary(f'openssl genpkey -algorithm RSA -out "{PEM_FILE}" -pkeyopt rsa_keygen_bits:2048')
    print("      请备份 extension.pem！丢失会导致扩展 ID 变化。")
else:
    print("[1/4] 已有私钥，跳过。")

# 2. 导出公钥 DER（二进制）
print("[2/4] 导出公钥 ...")
pubkey_der = run_binary(f'openssl rsa -in "{PEM_FILE}" -pubout -outform DER')
if not pubkey_der:
    print("导出公钥失败")
    sys.exit(1)

# 3. 打包 ZIP
print("[3/4] 打包 ZIP ...")
with open(os.path.join(SCRIPT_DIR, "manifest.json"), 'r', encoding='utf-8') as f:
    manifest = json.load(f)
version = manifest["version"]

os.makedirs(RELEASES_DIR, exist_ok=True)
zip_path = os.path.join(RELEASES_DIR, f"extension_{version}.zip")
crx_path = os.path.join(RELEASES_DIR, f"extension_{version}.crx")

with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
    skip_dirs = {'.git', 'releases', '__pycache__'}
    skip_exts = {'.sh', '.py', '.pem', '.md'}
    for root, dirs, files in os.walk(SCRIPT_DIR):
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        for fname in files:
            if any(fname.endswith(e) for e in skip_exts) or fname == 'extension.pem':
                continue
            fp = os.path.join(root, fname)
            zf.write(fp, os.path.relpath(fp, SCRIPT_DIR))

# 4. 签名 + 拼装 CRX v2
print("[4/4] 签名并生成 .crx ...")

# 读 ZIP 内容
with open(zip_path, 'rb') as fz:
    zip_data = fz.read()

# 对 ZIP 做 SHA256 + RSA 签名
proc = subprocess.Popen(
    f'openssl dgst -sha256 -sign "{PEM_FILE}"',
    shell=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE
)
signature, sig_err = proc.communicate(input=zip_data)
if proc.returncode != 0:
    print(f"签名失败: {sig_err.decode()}")
    sys.exit(1)

# 拼装 CRX v2 header
magic = b'Cr24'
version_le = struct.pack('<I', 2)
pk_len_le = struct.pack('<I', len(pubkey_der))
sig_len_le = struct.pack('<I', len(signature))

crx_data = magic + version_le + pk_len_le + sig_len_le + pubkey_der + signature + zip_data
with open(crx_path, 'wb') as f:
    f.write(crx_data)

# 计算扩展 ID（128 位 SHA256 的前 128 位的转 base32）
ext_hash = hashlib.sha256(pubkey_der).hexdigest()[:32]
ext_id = ''
i = 0
while i < 32:
    ext_id += 'abcdefghijklmnopqrstuvwxyz234567'[int(ext_hash[i], 16)]
    i += 1
ext_id = ext_id[:32]

print(f"\n✅ 打包完成: {crx_path}")
print(f"   扩展 ID: {ext_id}")

# 自动更新 XML
xml_path = os.path.join(SCRIPT_DIR, "updates", "extension.xml")
xml_content = f'''<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/protocol" protocol="2.0">
  <app appid="{ext_id}">
    <updatecheck codebase="https://raw.githubusercontent.com/zj0911/qc-plugin/main/releases/extension_{version}.crx"
                 version="{version}" />
  </app>
</gupdate>'''
with open(xml_path, 'w', encoding='utf-8') as f:
    f.write(xml_content)
print(f"   updates/extension.xml 已自动填入扩展 ID")

print(f"\n📋 下一步:")
print(f"   1. git add releases/extension_{version}.crx && git add updates/ && git push")
print(f"   2. 或到 GitHub Release 页面上传 releases/extension_{version}.crx")
print(f"   3. 发 crx 给其他人安装，之后自动更新生效")