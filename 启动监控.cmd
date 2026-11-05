@echo off
chcp 65001 >nul
cd /d "%~dp0"
title SCUM 在线监控
where node >nul 2>nul || (echo 没有找到 node，请先安装 Node.js && pause && exit /b 1)
node server.mjs --open
echo.
echo 监控已停止。
pause
