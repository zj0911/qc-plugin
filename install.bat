@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

title 质检优化助手 - 安装
echo ================================
echo   质检优化助手 v5.0.4 安装脚本
echo ================================
echo.

set "TARGET=%USERPROFILE%\qc-plugin"

:: 1. 创建目标文件夹
if not exist "%TARGET%" mkdir "%TARGET%"

:: 2. 复制扩展文件
echo [1/3] 复制扩展文件到 %TARGET% ...
xcopy /E /Y /Q "%~dp0qc-plugin\*" "%TARGET%\" >nul 2>&1

:: 3. 复制密钥文件（Chrome 需要扩展文件夹同级 .pem）
echo [2/3] 复制密钥文件 ...
copy /Y "%~dp0qc-plugin.pem" "%USERPROFILE%\qc-plugin.pem" >nul 2>&1

:: 4. 打开扩展管理页面
echo [3/3] 打开 Chrome 扩展管理页面 ...
start chrome "chrome://extensions"

echo.
echo ================================
echo   请手动完成最后一步：
echo.
echo   1. 开启右上角"开发者模式"
echo   2. 点击"加载已解压的扩展程序"
echo   3. 选择文件夹: %TARGET%
echo.
echo   安装后扩展 ID 固定为:
echo   mjigmdancgpbknlgnmgpbeokljdadfpl
echo.
echo   之后版本更新全自动，无需操作。
echo ================================
echo.
pause