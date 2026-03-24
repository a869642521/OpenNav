import type { Request, Response, NextFunction } from 'express'
import { verifyToken, type JwtPayload } from './auth.js'
import { db } from './db.js'

export interface AuthRequest extends Request {
  user?: JwtPayload & { name: string; avatar?: string }
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
    // 从 DB 取最新用户信息（id 别名为 userId，与 JwtPayload 接口保持一致）
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
  console.error('[error]', err.message)
  res.status(500).json({ error: err.message ?? '服务器内部错误' })
}
