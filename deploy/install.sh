#!/bin/bash
# 销售资料库 · 服务器一键安装 / 升级脚本（Ubuntu 22.04 / 24.04，Debian 12）
#
# 用法（在解压后的项目目录中，以 root 身份运行）：
#   bash deploy/install.sh                      # 先用公网 IP 访问（http://公网IP）
#   bash deploy/install.sh sales.example.com    # 域名已备案并解析到本服务器后，启用 HTTPS
#
# 重复运行即为升级：代码更新，数据和配置保留。
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR=/opt/sales-library
DATA_DIR=/var/lib/sales-library
ENV_FILE=/etc/sales-library.env
SERVICE=sales-library
APP_USER=saleslib
NODE_MAJOR=22
NPM_REGISTRY=https://registry.npmmirror.com
NODE_MIRROR=https://npmmirror.com/mirrors/node
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

step() { echo -e "\n\033[1;34m==> $*\033[0m"; }
fail() { echo -e "\n\033[1;31m安装失败：$*\033[0m"; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "请用 root 用户运行（或在命令前加 sudo）"
command -v apt-get >/dev/null || fail "本脚本只支持 Ubuntu / Debian 系统，购买服务器时请选择 Ubuntu 22.04 或 24.04 镜像"
[ -f "$SRC_DIR/server/index.js" ] || fail "请在解压后的项目目录中运行：bash deploy/install.sh"
if [ -n "$DOMAIN" ] && ! [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  fail "域名格式不正确：$DOMAIN（只填域名，例如 sales.example.com，不要带 http://）"
fi

# ---------- 1. 系统软件 ----------
step "安装系统软件（nginx 等）"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx curl xz-utils ca-certificates rsync openssl
if [ -n "$DOMAIN" ]; then
  apt-get install -y certbot python3-certbot-nginx
fi

# ---------- 2. Node.js ----------
node_ok() {
  command -v node >/dev/null && node -e '
    const [a, b] = process.versions.node.split(".").map(Number);
    process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1);'
}
if node_ok; then
  step "Node.js 已安装：$(node -v)"
else
  step "安装 Node.js ${NODE_MAJOR}（国内镜像）"
  case "$(uname -m)" in
    x86_64) ARCH=x64 ;;
    aarch64) ARCH=arm64 ;;
    *) fail "不支持的 CPU 架构：$(uname -m)" ;;
  esac
  TMP=$(mktemp -d)
  BASE="$NODE_MIRROR/latest-v${NODE_MAJOR}.x"
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt" \
    || { BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"; curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"; } \
    || fail "无法下载 Node.js，请检查服务器网络"
  FILE=$(grep -o "node-v[0-9.]*-linux-${ARCH}\.tar\.xz" "$TMP/SHASUMS256.txt" | head -1)
  [ -n "$FILE" ] || fail "未找到 Node.js 安装包"
  curl -fSL --progress-bar "$BASE/$FILE" -o "$TMP/$FILE"
  (cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | sha256sum -c -) || fail "Node.js 安装包校验失败"
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf "$TMP/$FILE" -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  ln -sf /opt/node/bin/npm /usr/local/bin/npm
  ln -sf /opt/node/bin/npx /usr/local/bin/npx
  rm -rf "$TMP"
  hash -r
  node_ok || fail "Node.js 安装后版本仍不满足要求"
  echo "Node.js $(node -v) 安装完成"
fi
NODE_BIN="$(command -v node)"

# ---------- 3. 程序文件 ----------
step "复制程序到 $APP_DIR"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$DATA_DIR"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  rsync -a --delete \
    --exclude node_modules --exclude data --exclude .git --exclude miniprogram --exclude test \
    "$SRC_DIR"/ "$APP_DIR"/
fi
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund --registry="$NPM_REGISTRY" \
  || npm ci --omit=dev --no-audit --no-fund \
  || fail "依赖安装失败，请检查服务器网络后重新运行本脚本"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"

# ---------- 4. 配置文件（只在第一次安装时生成） ----------
FIRST_INSTALL=0
if [ ! -f "$ENV_FILE" ]; then
  FIRST_INSTALL=1
  ADMIN_PASSWORD=$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-12)
  cat > "$ENV_FILE" <<EOF
# 销售资料库 配置文件。修改后执行：systemctl restart $SERVICE
PORT=3000
DATA_DIR=$DATA_DIR
MAX_UPLOAD_MB=200
# 仅在第一次启动、数据库里还没有任何账号时使用
ADMIN_PASSWORD=$ADMIN_PASSWORD

# 微信小程序（可选）：填好后去掉行首的 # 并重启服务
#WX_APPID=
#WX_SECRET=
#WX_TEMPLATE_ID=
#WX_TEMPLATE_FIELDS={"thing1":"title","thing2":"brand","time3":"time","thing4":"action"}
EOF
  chmod 600 "$ENV_FILE"
fi

# ---------- 5. 系统服务（开机自启、崩溃自动重启） ----------
step "配置系统服务"
cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=Sales Library
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=NODE_ENV=production
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable $SERVICE >/dev/null 2>&1
systemctl restart $SERVICE

# ---------- 6. Nginx ----------
step "配置 Nginx"
SERVER_NAME="${DOMAIN:-_}"
# 部分阿里云镜像关闭了 IPv6，此时监听 [::]:80 会导致 nginx 无法启动
LISTEN_V6=""
[ -s /proc/net/if_inet6 ] && LISTEN_V6="listen [::]:80 default_server;"
NGINX_CONF=/etc/nginx/sites-available/$SERVICE
# 已申请过证书时保留 certbot 写入的 HTTPS 配置，只在首次或域名变化时重写
if [ -z "$DOMAIN" ] || ! grep -q "server_name $DOMAIN;" "$NGINX_CONF" 2>/dev/null || ! grep -q "ssl_certificate" "$NGINX_CONF"; then
  cat > "$NGINX_CONF" <<EOF
server {
    listen 80 default_server;
    $LISTEN_V6
    server_name $SERVER_NAME;

    client_max_body_size 210m;

    # 实时推送（Server-Sent Events）不能缓冲
    location /api/events {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_request_buffering off;
        proxy_read_timeout 10m;
        proxy_send_timeout 10m;
    }
}
EOF
fi
rm -f /etc/nginx/sites-enabled/default
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/$SERVICE
nginx -t
systemctl enable nginx >/dev/null 2>&1
systemctl reload nginx || systemctl restart nginx

# ---------- 7. HTTPS 证书 ----------
if [ -n "$DOMAIN" ]; then
  step "为 $DOMAIN 申请 HTTPS 证书"
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect \
    || fail "证书申请失败。请确认：① 域名已完成 ICP 备案；② 域名已解析到本服务器公网 IP；③ 安全组 / 防火墙已放行 80 和 443 端口。然后重新运行本脚本"
  systemctl reload nginx
fi

# ---------- 8. 检查 ----------
step "检查服务状态"
for _ in $(seq 1 20); do
  curl -fs http://127.0.0.1:3000/api/health >/dev/null && break
  sleep 1
done
curl -fs http://127.0.0.1:3000/api/health >/dev/null \
  || fail "服务没有正常启动，请运行 journalctl -u $SERVICE -n 50 查看原因"

PUBLIC_IP=$(curl -fs --max-time 3 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null \
  || curl -fs --max-time 5 https://ifconfig.me 2>/dev/null || echo "服务器公网IP")
if [ -n "$DOMAIN" ]; then URL="https://$DOMAIN"; else URL="http://$PUBLIC_IP"; fi

echo
echo "=============================================================="
echo "  安装完成！"
echo "  访问地址：$URL"
if [ "$FIRST_INSTALL" -eq 1 ]; then
  echo "  管理员账号：admin"
  echo "  管理员密码：$ADMIN_PASSWORD"
  echo "  （请立即记下这个密码，登录后可在右上角“改密码”中修改）"
else
  echo "  已升级到最新版本，原有数据和账号保持不变。"
fi
echo
echo "  常用命令："
echo "    查看运行状态：systemctl status $SERVICE"
echo "    查看日志：    journalctl -u $SERVICE -n 100"
echo "    重启服务：    systemctl restart $SERVICE"
echo "    修改配置：    nano $ENV_FILE"
echo "    数据位置：    $DATA_DIR（请开启云盘自动快照备份）"
echo "=============================================================="
