import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware.js'
import { db } from '../db.js'

const router = Router()
router.use(requireAuth)

/** PUT /settings/kimi-key — 保存用户自己的 Kimi API Key */
router.put('/kimi-key', (req: AuthRequest, res) => {
  const { key } = req.body as { key?: string }
  const userId = req.user!.userId
  // 空字符串等价于清除
  const value = key?.trim() || null
  db.prepare('UPDATE users SET kimi_api_key = ? WHERE id = ?').run(value, userId)
  res.json({ ok: true })
})

/** GET /settings/kimi-key-status — 查询是否已配置（不返回 Key 本身） */
router.get('/kimi-key-status', (req: AuthRequest, res) => {
  const userId = req.user!.userId
  const row = db
    .prepare('SELECT kimi_api_key FROM users WHERE id = ?')
    .get(userId) as { kimi_api_key: string | null } | undefined
  res.json({ configured: Boolean(row?.kimi_api_key) })
})

export default router
