import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware.js'
import { db } from '../db.js'
import { assertKimiKeyHeaderSafe } from '../kimiKeyValidate.js'
import { validateBody, apiKeySchema } from '../validate.js'
import { encryptSecret } from '../crypto.js'

const router = Router()
router.use(requireAuth)

/** PUT /settings/kimi-key — 保存用户自己的 Kimi API Key（落库前 AES-256-GCM 加密） */
router.put('/kimi-key', validateBody(apiKeySchema), (req: AuthRequest, res) => {
  const { key } = req.body as { key?: string }
  const userId = req.user!.userId
  // 空字符串等价于清除
  const plain = key?.trim() || null
  if (plain) assertKimiKeyHeaderSafe(plain)
  const stored = plain ? encryptSecret(plain) : null
  db.prepare('UPDATE users SET kimi_api_key = ? WHERE id = ?').run(stored, userId)
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

/** PUT /settings/brave-key — 保存用户自己的 Brave Search API Key（落库前 AES-256-GCM 加密） */
router.put('/brave-key', validateBody(apiKeySchema), (req: AuthRequest, res) => {
  const { key } = req.body as { key?: string }
  const userId = req.user!.userId
  const plain = key?.trim() || null
  const stored = plain ? encryptSecret(plain) : null
  db.prepare('UPDATE users SET brave_api_key = ? WHERE id = ?').run(stored, userId)
  res.json({ ok: true })
})

/** GET /settings/brave-key-status — 查询 Brave Search Key 是否已配置（不返回 Key 本身） */
router.get('/brave-key-status', (req: AuthRequest, res) => {
  const userId = req.user!.userId
  const row = db
    .prepare('SELECT brave_api_key FROM users WHERE id = ?')
    .get(userId) as { brave_api_key: string | null } | undefined
  res.json({ configured: Boolean(row?.brave_api_key) })
})

export default router
