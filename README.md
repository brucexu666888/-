# 销售资料库（Sales Library）

销售员用自己的账号，随时查询**所负责品牌**的产品资料、价格表、培训文件、样本、手册等市场资料；
市场部管理员在管理后台更新资料后，所有相关销售员**立即**拿到最新版本。

## 功能

**销售员端**（手机 / 电脑浏览器均可，可“添加到主屏幕”当 App 使用）
- 只能看到分配给自己的品牌及其资料，其他品牌完全不可见
- 按品牌、分类（产品资料 / 价格表 / 培训文件 / 样本 / 手册 / 市场资料）筛选，关键字搜索
- 在线查看或下载，永远只能拿到**当前最新版本**
- “新” / “已更新” 标记，顶部提示未读数量，可一键“只看未读”
- 实时推送：市场部发布或更新资料时，页面即时弹出提醒并刷新列表（页面在后台时发送系统通知）

**管理员端（市场部）**
- 品牌管理：新建 / 编辑 / 删除品牌
- 资料管理：上传资料（带进度条）、修改信息、替换文件（自动生成新版本并记录版本说明）、查看和下载历史版本、删除
- 账号管理：新建销售员、分配负责品牌、重置密码、停用账号（立即强制下线）、设置其他管理员

## 快速开始

需要 Node.js 22.13 或更高版本（使用内置 SQLite，无需单独安装数据库）。

```bash
npm install
npm start            # 打开 http://localhost:3000
```

首次启动会自动创建管理员账号：`admin` / `admin123`（可用环境变量 `ADMIN_PASSWORD` 指定），**登录后请立即修改密码**。

使用流程：管理员登录 → 品牌管理中创建品牌 → 销售员管理中创建账号并勾选负责品牌 → 资料管理中上传资料 → 销售员登录即可查看。

### 配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务端口 |
| `DATA_DIR` | `./data` | 数据库和上传文件的存放目录（请定期备份） |
| `MAX_UPLOAD_MB` | `200` | 单个文件大小上限 |
| `ADMIN_PASSWORD` | `admin123` | 首次启动时默认管理员的密码 |

### Docker 部署

```bash
docker build -t sales-library .
docker run -d -p 3000:3000 -v /srv/sales-library:/data -e ADMIN_PASSWORD='改成强密码' sales-library
```

对外提供服务时请在前面加一层 HTTPS 反向代理（如 Nginx / Caddy）。使用 Nginx 时，
`/api/events` 需要关闭缓冲（`proxy_buffering off;`）以保证实时推送。

## 技术说明

- 后端：Node.js + Express 5 + 内置 `node:sqlite`，文件存储在本地磁盘 `DATA_DIR/uploads`
- 前端：原生 HTML/CSS/JS，无构建步骤，响应式布局适配手机
- 实时推送：Server-Sent Events（`GET /api/events`）
- 鉴权：scrypt 密码哈希 + 会话令牌（HttpOnly Cookie，也支持 `Authorization: Bearer`，便于将来接入原生 App）
- 权限：所有资料查询和下载接口都在服务端按“销售员-品牌”关系过滤

```
server/
  index.js     启动入口
  app.js       API 路由
  db.js        数据表结构
  auth.js      密码与会话
  events.js    实时推送
public/        前端页面
test/          接口测试（npm test）
```

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | 登录 |
| GET | `/api/materials?brandId=&category=&q=` | 资料列表（按权限过滤） |
| GET | `/api/materials/:id/file[?inline=1]` | 下载 / 在线查看最新版本 |
| POST / PUT / DELETE | `/api/materials[/:id]` | 发布 / 更新 / 删除资料（管理员，multipart） |
| GET | `/api/materials/:id/versions` | 历史版本（管理员） |
| GET / POST / PUT / DELETE | `/api/brands[/:id]` | 品牌 |
| GET / POST / PUT / DELETE | `/api/users[/:id]` | 账号与品牌分配（管理员） |
| GET | `/api/events` | 实时推送 |

## 后续可扩展

- 原生 App / 微信小程序 / 企业微信、钉钉登录（接口已支持 Bearer Token）
- 文件存储改为阿里云 OSS / S3 等对象存储
- 预览加水印（销售员姓名）、禁止下载等资料防泄漏措施
- 离线缓存常用资料
- 查看 / 下载统计报表
