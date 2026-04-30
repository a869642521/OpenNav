/**
 * 集中配置 + 启动时校验。
 *
 * 规则：
 * - 开发环境：缺失时用合理默认值 + 打印警告，保证本地「开箱可跑」
 * - 生产环境：关键安全/登录相关变量缺失直接退出，避免把错配置带上线
 */

const isProd = process.env.NODE_ENV === 'production'

function fatal(msg: string): never {
  console.error(`[config] ${msg}`)
  process.exit(1)
}

function warn(msg: string): void {
  console.warn(`[config] ${msg}`)
}

function required(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) fatal(`缺少必需环境变量 ${name}`)
  return v
}

function optional(name: string, fallback: string, prodRequire = false): string {
  const v = process.env[name]?.trim()
  if (v) return v
  if (prodRequire && isProd) fatal(`生产环境必须设置 ${name}`)
  if (!isProd) warn(`${name} 未设置，使用开发默认值：${fallback}`)
  return fallback
}

const JWT_SECRET = (() => {
  const v = process.env.JWT_SECRET?.trim()
  if (!v) {
    if (isProd) fatal('生产环境必须设置 JWT_SECRET（至少 32 字节随机值）')
    warn('JWT_SECRET 未设置，使用开发默认值（仅限本地）')
    return 'dev-only-insecure-secret-change-me'
  }
  if (isProd && v.length < 32) fatal('JWT_SECRET 长度至少 32 字节')
  return v
})()

/**
 * 用于加密用户第三方 API Key（Kimi / Brave）的主密钥。
 *
 * 接受两种格式（任选其一）：
 * - 64 位 hex（256 bit，推荐）：如 `openssl rand -hex 32`
 * - 44 位 base64（32 字节原值的标准 base64）
 *
 * 生产环境强制设置；开发环境缺失会用派生自固定短语的 key 临时兜底（警告提示）。
 *
 * 切勿在更换此值后保留数据库中原有密文——旧密文将无法解密。
 */
const APP_ENCRYPTION_KEY = (() => {
  const v = process.env.APP_ENCRYPTION_KEY?.trim()
  if (v) return v
  if (isProd) {
    fatal(
      '生产环境必须设置 APP_ENCRYPTION_KEY（32 字节，建议 `openssl rand -hex 32`），' +
        '用于加密用户保存的 Kimi / Brave API Key'
    )
  }
  warn('APP_ENCRYPTION_KEY 未设置，使用开发兜底派生（仅限本地，禁止上线）')
  return 'dev-only-insecure-app-encryption-key'
})()

const FRONTEND_URL = optional('FRONTEND_URL', 'http://localhost:5173,http://localhost:5180', true)
const BACKEND_PUBLIC_URL = optional('BACKEND_PUBLIC_URL', `http://localhost:${process.env.PORT ?? 3001}`, true)
const PORT = Number(process.env.PORT ?? 3001)

export const config = {
  isProd,
  PORT,
  JWT_SECRET,
  APP_ENCRYPTION_KEY,
  FRONTEND_URL,
  BACKEND_PUBLIC_URL,
  ALLOWED_ORIGINS: FRONTEND_URL.split(',').map((s) => s.trim()).filter(Boolean),
  JSON_LIMIT: process.env.JSON_BODY_LIMIT?.trim() || '256kb',
} as const

export function assertConfigOrExit(): void {
  if (isProd) {
    if (!process.env.FRONTEND_URL?.trim()) fatal('生产环境必须设置 FRONTEND_URL')
    if (!process.env.BACKEND_PUBLIC_URL?.trim()) fatal('生产环境必须设置 BACKEND_PUBLIC_URL')
  }
  void required
}
