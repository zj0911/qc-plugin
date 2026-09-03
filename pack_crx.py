#!/usr/bin/env python3
"""打包 Chrome 扩展：生成 .crx + 发行 .zip（PEM 在文件夹同级，Chrome 读取后 ID 一致）"""
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
    print("      请备份 extension.pem！丢失会导致扩展 ID 变化。")
else:
    print("[1/4] 已有私钥，跳过。")

# 2. 导出公钥 + 计算扩展 ID
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
folder_name = f"质检优化助手_v{version}"
zip_path = os.path.join(RELEASES_DIR, f"extension_{version}.zip")
crx_path = os.path.join(RELEASES_DIR, f"extension_{version}.crx")
dist_zip_path = os.path.join(RELEASES_DIR, f"{folder_name}.zip")

# 4. 打包
print(f"[3/4] 打包 CRX + ZIP (v{version}) ...")

skip_dirs = {'.git', 'releases', '__pycache__'}
skip_files = {'extension.pem', 'pack_crx.py', 'build_crx.sh', 'release.sh'}

pack_files = []
for root, dirs, files in os.walk(SCRIPT_DIR):
    dirs[:] = [d for d in dirs if d not in skip_dirs]
    for fname in files:
        if fname in skip_files or fname.endswith('.sh') or fname.endswith('.py'):
            continue
        pack_files.append((os.path.join(root, fname),
                           os.path.relpath(os.path.join(root, fname), SCRIPT_DIR)))

# ---- CRX (不含私钥，供 Chrome 自动更新) ----
print("   -> 生成 .crx ...")
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
    for fp, arcname in pack_files:
        zf.write(fp, arcname)

with open(zip_path, 'rb') as fz:
    zip_data = fz.read()

proc = subprocess.Popen(
    f'openssl dgst -sha256 -sign "{PEM_FILE}"',
    shell=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE
)
signature, sig_err = proc.communicate(input=zip_data)
if proc.returncode != 0:
    print(f"签名失败: {sig_err.decode(errors='replace')}"); sys.exit(1)

crx_data = (b'Cr24' + struct.pack('<I', 2) +
            struct.pack('<I', len(pubkey_der)) + struct.pack('<I', len(signature)) +
            pubkey_der + signature + zip_data)
with open(crx_path, 'wb') as f:
    f.write(crx_data)

# ---- 发行 ZIP (Chrome 加载解压扩展时检查 parent_dir/文件夹名.pem) ----
print("   -> 生成发行 .zip ...")
with zipfile.ZipFile(dist_zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
    # 扩展文件: 质检优化助手_v5.0.4/manifest.json, ...
    for fp, arcname in pack_files:
        zf.write(fp, f"{folder_name}/{arcname}")
    # PEM 文件在文件夹同级: 质检优化助手_v5.0.4.pem
    zf.write(PEM_FILE, f"{folder_name}.pem")

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
   ├── releases/extension_{version}.crx      ← 自动更新用
   ├── releases/{folder_name}.zip            ← 发给其他人
   └── updates/extension.xml

📋 其他人安装:
   1. 解压 {folder_name}.zip 到固定文件夹（不要改文件夹名）
   2. chrome://extensions → 开发者模式
   3. "加载已解压的扩展程序" → 选 {folder_name}/ 文件夹
   4. 扩展 ID 固定为 {ext_id}，自动更新生效

🚀 发版:
   git add releases/ updates/ && git commit -m "v{version}" && git push
""")