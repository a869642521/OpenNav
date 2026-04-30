# 设计导航 Design Nav

个人网站导航/书签管理，支持 Google 登录、分组、AI 发现同类网站与资料教程。

---

## 一、首次配置（部署者必读）

拿到项目后，需要先完成环境变量配置才能正常使用。

### 1. 前端配置

在**项目根目录**创建 `.env` 文件（可复制 `.env.example`）：

```bash
cp .env.example .env
```

编辑 `.env`，填写：

| 变量 | 说明 | 获取方式 |
|------|------|----------|
| `VITE_GOOGLE_CLIENT_ID` | Google 登录客户端 ID | [Google Cloud Console](https://console.cloud.google.com/) → 凭据 → 创建 OAuth 2.0 客户端 ID（Web 应用） |
| `VITE_API_URL` | 后端 API 地址 | 本地开发填 `http://localhost:3001`；上线填你的后端域名，如 `https://api.example.com` |
| `VITE_KIMI_API_KEY` | Kimi API Key | 仅**不启动后端**时前端直连用；有后端时可不填，由后端代理 |

**Google Client ID 获取步骤**：

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)
2. 创建项目（或选择已有）
3. 左侧「API 和服务」→「凭据」→「创建凭据」→「OAuth 2.0 客户端 ID」
4. 应用类型选「Web 应用」
5. 「已获授权的 JavaScript 来源」添加：`http://localhost:5173`（开发）、你的线上域名（如 `https://xxx.vercel.app`）
6. 创建后复制「客户端 ID」到 `VITE_GOOGLE_CLIENT_ID`

---

### 2. 后端配置

进入 `backend` 目录，创建 `.env`：

```bash
cd backend
cp .env.example .env
```

编辑 `backend/.env`，填写：

| 变量 | 说明 | 示例 / 获取方式 |
|------|------|-----------------|
| `GOOGLE_CLIENT_ID` | 与前端相同 | 同上，粘贴同一客户端 ID |
| `JWT_SECRET` | JWT 签名密钥 | 随机字符串，本地可随意；生产用 `openssl rand -base64 32` 生成 |
| `KIMI_API_KEY` | Kimi API Key | [Moonshot 控制台](https://platform.moonshot.cn/console/api-keys) 创建 |
| `DATABASE_URL` | 数据库路径 | 本地默认 `./data/nav.db` |
| `PORT` | 端口 | 默认 `3001` |
| `FRONTEND_URL` | 前端地址（CORS） | 开发填 `http://localhost:5173`，上线填前端域名 |

**生产环境：登录方式**  
前端默认使用**邮箱验证码登录**：`POST /auth/email/otp/send` 发信、`POST /auth/email/otp/verify` 换 token；新用户在验证成功时自动建号。须配置 `SMTP_*`（见 `backend/.env.example`），或开发/联调时使用 `EMAIL_OTP_DEBUG=1`。  
仍支持密码方式：`POST /auth/email/register`、`POST /auth/email/login`。  
（可选）**手机验证码**登录对接 `POST /auth/phone/send` 等，并配置腾讯云短信变量。

---

### 3. 安装依赖并启动

```bash
# 根目录：安装前端依赖
npm install

# 启动后端（新终端）
cd backend
npm install
npm run dev

# 启动前端（新终端，回到根目录）
npm run dev
```

浏览器打开 `http://localhost:5173`（或终端提示的端口）。

---

## 二、普通用户如何使用

**不需要任何配置**。普通用户只需：

1. 打开网站
2. 点击右上角「登录」
3. 选择「使用 Google 登录」
4. 授权后自动完成注册，之后所有数据会保存到后端，多设备可同步

---

## 三、上线部署

### 前端（Vercel / Netlify 等）

1. 将项目根目录作为前端项目
2. 构建命令：`npm run build`
3. 输出目录：`dist`
4. 在平台环境变量中配置：`VITE_GOOGLE_CLIENT_ID`、`VITE_API_URL`（指向你的后端地址）

### 后端（Railway / Render 等）

1. 将 `backend` 作为项目根目录
2. 启动命令：`npm run dev` 或 `npm start`（需先 `npm run build`）
3. 在平台环境变量中配置所有 `backend/.env` 中的变量
4. `FRONTEND_URL` 填你前端的线上地址
5. 若用 PostgreSQL，将 `DATABASE_URL` 改为 PostgreSQL 连接串（需适配 `db.ts`）

---

## 四、安全提醒

- 不要将 `.env` 提交到 Git（建议加入 `.gitignore`）
- 生产环境必须使用 HTTPS
- 生产环境务必更换 `JWT_SECRET` 为随机强密钥
- Kimi API Key 只放在后端 `.env`，不要出现在前端

---

## 五、架构约定（扩展友好）

计划日后做 Chrome 扩展时，开发上请保持：**业务走 `src/api.ts` + Bearer JWT**、**API 地址用环境变量**、**第三方 Key 只走后端**、**UI 不假设只有全屏网页**。详细条目见项目内 Cursor 规则 **extension-friendly**（`.cursor/rules/extension-friendly.mdc`），协作与 AI 辅助时会自动参考。
