import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware.js'
import { db } from '../db.js'
import { validateBody, categoryCreateSchema } from '../validate.js'

const router = Router()
router.use(requireAuth)

const BUILTIN_CATEGORIES = [
  { id: 'all', name: '全部', sort_order: -3 },
  { id: 'favorites', name: '收藏', sort_order: -2 },
  { id: 'ungrouped', name: '未分组', sort_order: -1 },
]

/** GET /categories — 获取当前用户分组（内置 + 自定义） */
router.get('/', (req: AuthRequest, res) => {
  const userId = req.user!.userId
  const custom = db
    .prepare('SELECT id, name, sort_order FROM categories WHERE user_id = ? ORDER BY sort_order ASC')
    .all(userId) as { id: string; name: string; sort_order: number }[]
  res.json([...BUILTIN_CATEGORIES, ...custom])
})

/** POST /categories — 新建分组（同名则复用已有，避免登录迁移等场景堆叠重复 Tab） */
router.post('/', validateBody(categoryCreateSchema), (req: AuthRequest, res) => {
  const userId = req.user!.userId
  const { name } = req.body as { name: string }
  const trimmed = name
  const existing = db
    .prepare(
      'SELECT id, name, sort_order FROM categories WHERE user_id = ? AND lower(trim(name)) = lower(?)'
    )
    .get(userId, trimmed) as { id: string; name: string; sort_order: number } | undefined
  if (existing) {
    res.status(200).json({ id: existing.id, name: existing.name, sort_order: existing.sort_order })
    return
  }
  const maxOrder = (db
    .prepare('SELECT MAX(sort_order) as m FROM categories WHERE user_id = ?')
    .get(userId) as { m: number | null }).m ?? 0
  const id = `cat_${Date.now()}`
  db.prepare('INSERT INTO categories (id, user_id, name, sort_order) VALUES (?, ?, ?, ?)').run(
    id, userId, trimmed, maxOrder + 1
  )
  res.status(201).json({ id, name: trimmed, sort_order: maxOrder + 1 })
})

/** DELETE /categories/:id — 删除分组，分组下站点归 ungrouped */
router.delete('/:id', (req: AuthRequest, res) => {
  const userId = req.user!.userId
  const { id } = req.params
  if (['all', 'favorites', 'ungrouped'].includes(id)) {
    res.status(400).json({ error: '内置分组不可删除' })
    return
  }
  const cat = db.prepare('SELECT id FROM categories WHERE id = ? AND user_id = ?').get(id, userId)
  if (!cat) {
    res.status(404).json({ error: '分组不存在' })
    return
  }
  db.transaction(() => {
    db.prepare("UPDATE sites SET category = 'ungrouped' WHERE category = ? AND user_id = ?").run(id, userId)
    db.prepare('DELETE FROM categories WHERE id = ? AND user_id = ?').run(id, userId)
  })()
  res.json({ ok: true })
})

export default router
