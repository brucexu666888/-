#!/bin/bash
# 销售资料库 一键启动（macOS）：双击运行
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1 || ! node scripts/check-node.js; then
  echo ""
  echo "需要先安装 Node.js（22.13 或更高版本）。"
  echo "即将打开下载页面：请下载 LTS 版本的 macOS 安装包，安装完成后再次双击本文件。"
  open "https://nodejs.org/zh-cn/download"
  read -n 1 -s -r -p "按任意键关闭窗口…"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "首次运行，正在安装依赖（约 1 分钟）…"
  npm install --registry=https://registry.npmmirror.com || npm install || {
    echo "依赖安装失败，请检查网络后重试。"
    read -n 1 -s -r -p "按任意键关闭窗口…"
    exit 1
  }
fi

echo ""
echo "================================================"
echo "  销售资料库正在启动，浏览器会自动打开"
echo "  地址：http://localhost:3000"
echo "  默认管理员：admin   密码：admin123"
echo "  使用期间请不要关闭本窗口；关闭窗口即停止服务"
echo "================================================"
echo ""
(sleep 2 && open "http://localhost:3000") &
npm start
