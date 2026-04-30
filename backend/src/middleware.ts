import type { Request, Response, NextFunction, RequestHandler } from 'express'
import expressRateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { verifyToken, type JwtPayload } from './auth.js'
import { db } from './db.js'

export interface AuthRequest extends Request {
  user?: JwtPayload & { name: string; avatar?: string }
}

type HttpError = Error & { status?: number; expose?: boolean }

interface RateLimitOptions {
  /** 业务命名空间，用于区分不同接口的配额 */
  key: string
  windowMs: number
  max: number
  message: string
  /** 自定义维度（例如基于 email/phone），可选；否则按 IP */
  keyGenerator?: (req: Request) => string
}

export function createHttpError(status: number, message: string, expose = true): HttpError {
  const err = new Error(message) as HttpError
  err.status = status
  err.expose = expose
  return err
}

/**
 * 基于 `express-rate-limit` 的限流封装。
 *
 * 相比原先的 in-memory Map 实现：
 * - 自动清理过期桶、自带 IPv6 安全的 key 处理
 * - 通过 standardHeaders 返回 `RateLimit-*` 标准响应头 + Retry-After
 * - 统一 JSON 响应结构（`{ error: ... }`），与其它接口保持一致
 *
 * 仍是进程内存存储；多实例部署时请换成 Redis 存储（同一套配置即可切换 store）。
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  return expressRateLimit({
    windowMs: options.windowMs,
    limit: options.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req: Request, res: Response) => {
      const base = options.keyGenerator
        ? options.keyGenerator(req)
        : ipKeyGenerator(req.ip ?? '')
      return `${options.key}:${base}`
    },
    handler: (_req, res) => {
      res.status(429).json({ error: options.message })
    },
  })
}

/** 从 Authorization: Bearer <token> 中提取并验证 JWT */
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: '未登录，请先认证' })
    return
  }
  const token = header.slice(7)
  try {
    const payload = verifyToken(token)
    const user = db.prepare('SELECT id AS userId, email, name, avatar FROM users WHERE id = ?').get(payload.userId) as
      | (JwtPayload & { name: string; avatar?: string })
      | undefined
    if (!user) {
      res.status(401).json({ error: '用户不存在' })
      return
    }
    req.user = user
    next()
  } catch {
    res.status(401).json({ error: 'Token 无效或已过期' })
  }
}

/** 统一错误处理 */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  const status = (err as HttpError).status ?? 500
  const expose = (err as HttpError).expose ?? status < 500
  const isProd = process.env.NODE_ENV === 'production'

  console.error('[error]', {
    status,
    message: err.message,
  })

  res.status(status).json({
    error: expose || !isProd ? err.message : '服务器内部错误',
  })
}
