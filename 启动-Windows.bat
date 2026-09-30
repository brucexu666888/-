@echo off
chcp 65001 >nul
title 销售资料库
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode
node scripts\check-node.js
if errorlevel 1 goto nonode

if not exist node_modules (
  echo 首次运行，正在安装依赖（约 1 分钟）...
  call npm install --registry=https://registry.npmmirror.com
  if errorlevel 1 call npm install
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo.
echo ================================================
echo   销售资料库正在启动，浏览器会自动打开
echo   地址：http://localhost:3000
echo   默认管理员：admin   密码：admin123
echo   使用期间请不要关闭本窗口；关闭窗口即停止服务
echo ================================================
echo.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
call npm start
pause
exit /b 0

:nonode
echo.
echo 需要先安装 Node.js（22.13 或更高版本）。
echo 即将打开下载页面：请下载 LTS 版本的 Windows 安装包（.msi），
echo 安装时一路点“下一步”即可，安装完成后再次双击本文件。
start https://nodejs.org/zh-cn/download
pause
exit /b 1
