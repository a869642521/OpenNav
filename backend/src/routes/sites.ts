import { randomUUID } from 'crypto'
import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware.js'
import { db } from '../db.js'
import {
  validateBody,
  siteCreateSchema,
  sitePatchSchema,
  siteReorderSchema,
} from '../validate.js'

const BUILTIN_CATEGORY_IDS = new Set(['all', 'favorites', 'ungrouped'])

/** 校验 category 要么是内置，要么属于当前用户；否则回落到 ungrouped */
function resolveUserCategory(userId: string, category: string | undefined | null): string {
  const c = (category ?? '').trim()
  if (!c || BUILTIN_CATEGORY_IDS.has(c)) return c || 'ungrouped'
  const owned = db
    .prepare('SELECT id FROM categories WHERE id = ? AND user_id = ?')
    .get(c, userId) as { id: string } | undefined
  return owned ? c : 'ungrouped'
}

const router = Router()
router.use(requireAuth)

interface SiteRow {
  id: string
  user_id: string
  favicon: string
  name: string
  url: string
  category: string
  tags: string
  notes: string
  description: string
  is_followed: number
  is_favorite: number
  views: number
  likes: number
  created_at: string
  last_opened_at: string | null
  sort_order: number
}

function parseTagsColumn(raw: string): string[] {
  try {
    const v = JSON.parse(raw || '[]')
    if (!Array.isArray(v)) return []
    return v.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

function rowToSite(row: SiteRow) {
  return {
    id: row.id,
    favicon: row.favicon,
    name: row.name,
    url: row.url,
    category: row.category,
    tags: parseTagsColumn(row.tags),
    notes: row.notes,
    description: row.description,
    isFollowed: Boolean(row.is_followed),
    isFavorite: Boolean(row.is_favorite),
    views: row.views,
    likes: row.likes,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at ?? undefined,
    sortOrder: row.sort_order,
  }
}

/** GET /sites — 获取当前用户所有站点 */
router.get('/', (req: AuthRequest, res) => {
  const userId = req.user!.userId
  const rows = db
    .prepare('SELECT * FROM sites WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC')
    .all(userId) as SiteRow[]
  res.json(rows.map(rowToSite))
})

/** POST /sites — 新增站点 */
router.post('/', validateBody(siteCreateSchema), (req: AuthRequest, res) => {
  const userId = req.user!.userId
  const body = req.body as import('zod').infer<typeof siteCreateSchema>
  const maxOrder = (db
    .prepare('SELECT MAX(sort_order) as m FROM sites WHERE user_id = ?')
    .get(userId) as { m: number | null }).m ?? 0
  const id = body.id?.trim() || randomUUID()
  const now = new Date().toISOString()
  const category = resolveUserCategory(userId, body.category)
  db.prepare(`
    INSERT INTO sites
      (id, user_id, favicon, name, url, category, tags, notes, description,
       is_followed, is_favorite, views, likes, created_at, last_opened_at, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, userId,
    body.favicon ?? '',
    body.name,
    body.url,
    category,
    JSON.stringify(body.tags ?? []),
    body.notes ?? '',
    body.description ?? '',
    body.isFollowed ? 1 : 0,
    body.isFavorite ? 1 : 0,
    body.views ?? 0,
    body.likes ?? 0,
    body.createdAt ?? now,
    body.lastOpenedAt ?? null,
    body.sortOrder ?? maxOrder + 1,
  )
  const row = db.prepare('SELECT * FROM sites WHERE id = ? AND user_id = ?').get(id, userId) as SiteRow
  res.status(201).json(rowToSite(row))
})

/** PATCH /sites/reorder — 批量更新顺序（需在 /:id 路由前注册） */
router.patch('/reorder', validateBody(siteReorderSchema), (req: AuthRequest, res) => {
  const userId = req.user!.userId
  const { orderedIds } = req.body as { orderedIds: string[] }
  const ownedIds = new Set(
    (db.prepare('SELECT id FROM sites WHERE user_id = ?').all(userId) as { id: string }[]).map((row) => row.id)
  )
  const invalidIds = orderedIds.filter((id) => !ownedIds.has(id))
  if (invalidIds.length > 0) {
    res.status(400).json({ error: 'orderedIds 包含不属于当前用户的站点', invalidIds })
    return
  }
  const update = db.prepare('UPDATE sites SET sort_order = ? WHERE id = ? AND user_id = ?')
  db.transaction(() => {
    orderedIds.forEach((id, idx) => update.run(idx, id, userId))
  })()
  res.json({ ok: true })
})

/** PATCH /sites/:id — 更新站点字段 */
router.patch('/:id', validateBody(sitePatchSchema), (req: AuthRequest, res) => {
  const userId = req.user!.userId
  const { id } = req.params
  const row = db.prepare('SELECT * FROM sites WHERE id = ? AND user_id = ?').get(id, userId) as SiteRow | undefined
  if (!row) {
    res.status(404).json({ error: '站点不存在' })
    return
  }
  const body = req.body as import('zod').infer<typeof sitePatchSchema>
  const category =
    body.category !== undefined ? resolveUserCategory(userId, body.category) : row.category

  db.prepare(`
    UPDATE sites SET
      favicon = ?, name = ?, url = ?, category = ?, tags = ?,
      notes = ?, description = ?, is_followed = ?, is_favorite = ?,
      views = ?, likes = ?, last_opened_at = ?
    WHERE id = ? AND user_id = ?
  `).run(
    body.favicon ?? row.favicon,
    body.name ?? row.name,
    body.url ?? row.url,
    category,
    body.tags !== undefined ? JSON.stringify(body.tags) : row.tags,
    body.notes ?? row.notes,
    body.description ?? row.description,
    body.isFollowed !== undefined ? (body.isFollowed ? 1 : 0) : row.is_followed,
    body.isFavorite !== undefined ? (body.isFavorite ? 1 : 0) : row.is_favorite,
    body.views ?? row.views,
    body.likes ?? row.likes,
    body.lastOpenedAt !== undefined ? body.lastOpenedAt : row.last_opened_at,
    id, userId,
  )
  const updated = db.prepare('SELECT * FROM sites WHERE id = ? AND user_id = ?').get(id, userId) as SiteRow
  res.json(rowToSite(updated))
})

/** DELETE /sites/:id — 删除站点 */
router.delete('/:id', (req: AuthRequest, res) => {
  const userId = req.user!.userId
  const { id } = req.params
  const result = db.prepare('DELETE FROM sites WHERE id = ? AND user_id = ?').run(id, userId)
  if (result.changes === 0) {
    res.status(404).json({ error: '站点不存在' })
    return
  }
  res.json({ ok: true })
})

export default router
