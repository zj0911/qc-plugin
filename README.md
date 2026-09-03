v5.0.4 — 质检优化助手：添加自动更新支持

概述

本次发布为 QC Plugin 添加了自动更新支持。通过在插件清单中配置 update_url 并配合仓库中的发布脚本，插件现在可以检测并自动安装新版本，简化了用户更新流程。
主要改动

新增：自动更新支持（update_url）
新增：发布脚本（用于构建、打包并在 GitHub Releases 发布资产）
优化：若干与发布相关的元数据和构建配置调整
升级说明

如果你是用户：更新后插件会自动检测新版本（前提是插件已启用自动更新并且 update_url 配置正确）。
如果你是管理员/发布者：
确保 package.json / manifest 中 version 更新到 v5.0.4。
确保 update_url 指向一个可被插件访问到的更新 manifest（例如 GitHub Releases 的 raw asset URL 或自建的更新 JSON）。
在发布前执行下列发布步骤（见下方“发布步骤”）。
兼容性 / 破坏性变更

无破坏性变更。自动更新为向后兼容特性，但在首次启用时可能需要用户授权或重启宿主应用。
下载与校验

请在 Releases 页面下载对应平台的打包文件（例：qc-plugin-v5.0.4.zip）。
推荐在下载后校验 SHA256：
shasum -a 256 qc-plugin-v5.0.4.zip
发布步骤（建议）

确认所有变更已合并到发布分支并运行测试。
更新版本号（package.json / manifest）为 v5.0.4 并提交。
本地打包构建产物（如 zip、tar.gz 等）。
计算并记录校验和（SHA256）。
shasum -a 256 build/qc-plugin-v5.0.4.zip > qc-plugin-v5.0.4.zip.sha256
使用 GitHub CLI 创建 Release 并附带资产：
gh release create v5.0.4 build/qc-plugin-v5.0.4.zip --title "v5.0.4 — 质检优化助手：添加自动更新支持" --notes-file RELEASE_NOTES.md
如果你使用脚本自动发布（仓库中已有脚本），确认脚本：
已更新版本号、生成的资产路径与上述一致
有正确的 GitHub_TOKEN 权限并在 CI 中执行
验证：在一个干净环境安装插件并确认自动更新逻辑可触发与完成。
发布检查清单

 版本号已更新到 v5.0.4
 测试通过（本地或 CI）
 打包产物已生成并能被解压、加载
 生成并保存 SHA256 校验和
 RELEASE_NOTES.md（或 release body）已准备好
 GitHub Release 已创建并附带资产
 update_url 在插件清单中指向正确地址（并在 release notes 中说明）
 若有自动更新服务器/endpoint，已部署并返回正确的更新元数据
