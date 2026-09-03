#!/usr/bin/env python3
"""打包 Chrome 扩展：生成 .crx（含 update_url 自动更新）和 .zip（含 key.pem 保持扩展 ID 一致）"""
import os, sys, struct, hashlib, subprocess, json, zipfile, shutil

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PEM_FILE = os.path.join(SCRIPT_DIR, "extension.pem")
RELEASES_DIR = os.path.join(SCRIPT_DIR, "releases")

def run_binary(cmd):
    p = subprocess.run(cmd, shell=True, capture_output=True)
    if p.returncode != 0:
        print(f"命令失败: {cmd}\n{p.stderr.decode(errors='replace')}")
        sys.exit(1)
    return p.stdout

# 1. 生成私钥（仅首次）
if not os.path.exists(PEM_FILE):
    print("[1/4] 生成私钥 extension.pem ...")
    run_binary(f'openssl genpkey -algorithm RSA -out "{PEM_FILE}" -pkeyopt rsa_keygen_bits:2048')
    print("      请备份 extension.pem！丢失会导致扩展 ID 变化，所有用户需重装。")
else:
    print("[1/4] 已有私钥，跳过。")

# 2. 导出公钥 DER + 扩展 ID
print("[2/4] 导出公钥 + 计算扩展 ID ...")
pubkey_der = run_binary(f'openssl rsa -in "{PEM_FILE}" -pubout -outform DER')
if not pubkey_der:
    print("导出公钥失败"); sys.exit(1)

ext_hash = hashlib.sha256(pubkey_der).hexdigest()[:32]
ext_id = ''
for i in range(0, 32):
    ext_id += 'abcdefghijklmnopqrstuvwxyz234567'[int(ext_hash[i], 16)]
ext_id = ext_id[:32]
print(f"   扩展 ID: {ext_id}")

# 3. 读版本号
with open(os.path.join(SCRIPT_DIR, "manifest.json"), 'r', encoding='utf-8') as f:
    manifest = json.load(f)
version = manifest["version"]

os.makedirs(RELEASES_DIR, exist_ok=True)
zip_path = os.path.join(RELEASES_DIR, f"extension_{version}.zip")
crx_path = os.path.join(RELEASES_DIR, f"extension_{version}.crx")

# 4. 打包 CRX + 发行 ZIP
print(f"[3/4] 打包 CRX + ZIP (v{version}) ...")

skip_dirs = {'.git', 'releases', '__pycache__'}
skip_files = {'extension.pem', 'pack_crx.py', 'build_crx.sh', 'release.sh'}

# 收集所有需要打包的文件
pack_files = []
for root, dirs, files in os.walk(SCRIPT_DIR):
    dirs[:] = [d for d in dirs if d not in skip_dirs]
    for fname in files:
        if fname in skip_files or fname.endswith('.sh') or fname.endswith('.py'):
            continue
        pack_files.append((os.path.join(root, fname), os.path.relpath(os.path.join(root, fname), SCRIPT_DIR)))

# ---- 打包 CRX（不含私钥）----
print("   -> 生成 .crx ...")
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
    for fp, arcname in pack_files:
        zf.write(fp, arcname)

with open(zip_path, 'rb') as fz:
    zip_data = fz.read()

# RSA 签名
proc = subprocess.Popen(
    f'openssl dgst -sha256 -sign "{PEM_FILE}"',
    shell=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE
)
signature, sig_err = proc.communicate(input=zip_data)
if proc.returncode != 0:
    print(f"签名失败: {sig_err.decode(errors='replace')}"); sys.exit(1)

# CRX v2 拼装
magic = b'Cr24'
crx_data = magic + struct.pack('<I', 2) + struct.pack('<I', len(pubkey_der)) + struct.pack('<I', len(signature)) + pubkey_der + signature + zip_data
with open(crx_path, 'wb') as f:
    f.write(crx_data)

# ---- 打包发行 ZIP（含 key.pem，这样解压加载后 ID 一致）----
print("   -> 生成发行 .zip（含 key.pem）...")
dist_zip_path = os.path.join(RELEASES_DIR, f"质检优化助手_v{version}.zip")
with zipfile.ZipFile(dist_zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
    # 先写入所有正常文件
    for fp, arcname in pack_files:
        zf.write(fp, arcname)
    # 再写入 key.pem（从 extension.pem 复制，Chrome 解压加载时用它保持 ID 一致）
    zf.write(PEM_FILE, 'key.pem')

# 5. 更新 extension.xml
print("[4/4] 更新 extension.xml ...")
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

print(f"""
✅ 打包完成

   扩展 ID: {ext_id}

   文件:
   ├── releases/extension_{version}.crx    ← Chrome 自动更新用
   ├── releases/质检优化助手_v{version}.zip  ← 发给其他人安装用
   └── updates/extension.xml              ← 已自动填入 ID

📋 其他人安装步骤:
   1. 下载 质检优化助手_v{version}.zip
   2. 解压到一个固定文件夹（不要删/移动）
   3. chrome://extensions → 开发者模式 → "加载已解压的扩展程序" → 选文件夹
   4. 之后自动更新生效 ✨

🚀 发版:
   git add releases/ updates/ && git commit -m "v{version}" && git push
""")