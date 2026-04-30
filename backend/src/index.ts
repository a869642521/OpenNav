import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { randomUUID } from 'crypto'
import { config, assertConfigOrExit } from './config.js'
import { db, cleanupExpired } from './db.js'
import { migrateEncryptApiKeys } from './migrateSecrets.js'
import authRouter from './routes/auth.js'
import sitesRouter from './routes/sites.js'
import categoriesRouter from './routes/categories.js'
import aiRouter from './routes/ai.js'
import settingsRouter from './routes/settings.js'
import { errorHandler } from './middleware.js'

assertConfigOrExit()

// 启动时把历史明文 API Key 升级为 AES-256-GCM 密文；已密文行跳过，幂等
try {
  const r = migrateEncryptApiKeys()
  if (r.migrated > 0) console.log('[migrate] encrypted api keys:', r)
} catch (e) {
  console.warn('[migrate] encryptApiKeys failed', e)
}

const app = express()

// 反向代理后面运行时需要信任 X-Forwarded-* 头（生产）
if (config.isProd) app.set('trust proxy', 1)

/**
 * 安全头：
 * - 对纯 API 场景关闭 CSP（避免影响 OAuth 跳转），其它默认开启
 * - crossOriginResourcePolicy 放到 cross-origin，避免浏览器端获取 favicon/图片被拦
 */
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
)

const allowedOrigins = [
  ...config.ALLOWED_ORIGINS,
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
].filter(Boolean) as string[]

/** Vite 端口被占用时会改用 5175+；开发环境放行 localhost / 127.0.0.1 任意端口，避免 CORS 导致 Failed to fetch */
const isDevLocalOrigin = (origin: string) =>
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) {
        cb(null, true)
        return
      }
      if (!config.isProd && isDevLocalOrigin(origin)) {
        cb(null, true)
        return
      }
      cb(null, false)
    },
    credentials: true,
  })
)

app.use(express.json({ limit: config.JSON_LIMIT }))

// Request-Id：便于跨日志追踪；若上游已注入，直接沿用
app.use((req, res, next) => {
  const incoming = req.header('x-request-id')?.trim()
  const id = incoming && incoming.length <= 128 ? incoming : randomUUID()
  ;(req as express.Request & { id?: string }).id = id
  res.setHeader('x-request-id', id)
  next()
})

// 请求日志：开发期 dev 输出；生产期 combined 格式
morgan.token('id', (req) => (req as express.Request & { id?: string }).id ?? '-')
app.use(
  morgan(
    config.isProd
      ? ':remote-addr - :id ":method :url" :status :res[content-length] - :response-time ms'
      : ':id :method :url :status :response-time ms'
  )
)

app.get('/', (_req, res) => res.json({ service: 'design-nav-backend', status: 'ok', docs: '/health' }))
app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    uptime: process.uptime(),
    env: config.isProd ? 'production' : 'development',
  })
)

app.use('/auth', authRouter)
app.use('/sites', sitesRouter)
app.use('/categories', categoriesRouter)
app.use('/ai', aiRouter)
app.use('/settings', settingsRouter)

app.use(errorHandler)

const server = app.listen(config.PORT, () => {
  console.log(`[server] Running on http://localhost:${config.PORT}`)
})

// 定时清理过期 OTP / OAuth state / 兑换码
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000
const cleanupTimer = setInterval(() => {
  try {
    const r = cleanupExpired()
    if (r.email_otps || r.phone_otps || r.qq_states || r.auth_exchanges) {
      console.log('[db] cleanupExpired tick:', r)
    }
  } catch (e) {
    console.warn('[db] cleanupExpired tick failed', e)
  }
}, CLEANUP_INTERVAL_MS)
cleanupTimer.unref?.()

// 优雅退出：停收新连接 → 等待在途请求 → 关闭数据库
function shutdown(signal: string) {
  console.log(`[server] ${signal} received, shutting down...`)
  clearInterval(cleanupTimer)
  const force = setTimeout(() => {
    console.warn('[server] forced exit after 10s')
    process.exit(1)
  }, 10_000)
  force.unref?.()
  server.close((err) => {
    if (err) console.warn('[server] close error', err)
    try {
      db.close()
    } catch (e) {
      console.warn('[server] db close error', e)
    }
    process.exit(err ? 1 : 0)
  })
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException', err)
})
