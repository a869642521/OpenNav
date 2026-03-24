import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware.js'
import { db } from '../db.js'

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

function rowToSite(row: SiteRow) {
  return {
    id: row.id,
    favicon: row.favicon,
    name: row.name,
    url: row.url,
    category: row.category,
    tags: JSON.parse(row.tags || '[]'),
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
router.post('/', (req: AuthRequest, res) => {
  const userId = req.user!.userId
  const body = req.body as {
    id?: string; favicon?: string; name?: string; url?: string;
    category?: string; tags?: string[]; notes?: string; description?: string;
    isFollowed?: boolean; isFavorite?: boolean; views?: number; likes?: number;
    createdAt?: string; lastOpenedAt?: string; sortOrder?: number;
  }
  if (!body.name?.trim() || !body.url?.trim()) {
    res.status(400).json({ error: '缺少必填字段 name 或 url' })
    return
  }
  const maxOrder = (db
    .prepare('SELECT MAX(sort_order) as m FROM sites WHERE user_id = ?')
    .get(userId) as { m: number | null }).m ?? 0
  const id = body.id ?? `site_${Date.now()}`
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO sites
      (id, user_id, favicon, name, url, category, tags, notes, description,
       is_followed, is_favorite, views, likes, created_at, last_opened_at, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, userId,
    body.favicon ?? '',
    body.name.trim(),
    body.url.trim(),
    body.category ?? 'ungrouped',
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
  const row = db.prepare('SELECT * FROM sites WHERE id = ?').get(id) as SiteRow
  res.status(201).json(rowToSite(row))
})

/** PATCH /sites/reorder — 批量更新顺序（需在 /:id 路由前注册） */
router.patch('/reorder', (req: AuthRequest, res) => {
  const userId = req.user!.userId
  const { orderedIds } = req.body as { orderedIds?: string[] }
  if (!Array.isArray(orderedIds)) {
    res.status(400).json({ error: '需要 orderedIds 数组' })
    return
  }
  const update = db.prepare('UPDATE sites SET sort_order = ? WHERE id = ? AND user_id = ?')
  db.transaction(() => {
    orderedIds.forEach((id, idx) => update.run(idx, id, userId))
  })()
  res.json({ ok: true })
})

/** PATCH /sites/:id — 更新站点字段 */
router.patch('/:id', (req: AuthRequest, res) => {
  const userId = req.user!.userId
  const { id } = req.params
  const row = db.prepare('SELECT * FROM sites WHERE id = ? AND user_id = ?').get(id, userId) as SiteRow | undefined
  if (!row) {
    res.status(404).json({ error: '站点不存在' })
    return
  }
  const body = req.body as Partial<{
    favicon: string; name: string; url: string; category: string;
    tags: string[]; notes: string; description: string;
    isFollowed: boolean; isFavorite: boolean; views: number; likes: number;
    lastOpenedAt: string | null;
  }>

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
    body.category ?? row.category,
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
  const updated = db.prepare('SELECT * FROM sites WHERE id = ?').get(id) as SiteRow
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
