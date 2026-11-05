@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在打开 Chrome，请在弹出的窗口里登录 1199.scum8.com ...
node login.mjs
echo.
pause
