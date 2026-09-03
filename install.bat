@echo off
chcp 65001 >nul
title 质检优化助手 - 一键安装
echo ================================
echo   质检优化助手 v5.0.4 安装
echo ================================
echo.

set "EXT_ID=mjigmdancgpbknlgnmgpbeokljdadfpl"
set "UPDATE_URL=https://raw.githubusercontent.com/zj0911/qc-plugin/main/updates/extension.xml"

:: 写入注册表：Chrome 会在下次启动时自动安装并保持更新
reg add "HKCU\Software\Policies\Google\Chrome\ExtensionInstallForcelist" /v 1 /t REG_SZ /d "%EXT_ID%;%UPDATE_URL%" /f >nul 2>&1

if %ERRORLEVEL% EQU 0 (
    echo [√] 注册表已配置
) else (
    echo [X] 注册表写入失败，请以管理员身份运行
    pause
    exit /b 1
)

echo.
echo ================================
echo   安装步骤：
echo.
echo   1. 完全关闭 Chrome（所有窗口）
echo   2. 重新打开 Chrome
echo   3. Chrome 会自动安装"质检优化助手"
echo      首次可能需要点"启用扩展程序"
echo.
echo   之后每次发新版，Chrome 自动更新！
echo ================================
echo.

:: 关闭 Chrome
taskkill /F /IM chrome.exe >nul 2>&1

echo 正在关闭 Chrome...
timeout /t 3 /nobreak >nul

:: 重新打开 Chrome
start chrome

echo Chrome 已启动，等待几秒扩展会自动安装...
timeout /t 8 /nobreak >nul
start chrome "chrome://extensions"
echo.
echo 切换到打开的扩展管理页面，
echo 应该能看到"质检优化助手"正在安装。
echo.
echo 扩展 ID: %EXT_ID%
echo.
pause