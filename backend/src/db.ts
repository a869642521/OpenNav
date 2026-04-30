import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dbPath = process.env.DATABASE_URL ?? path.join(__dirname, '../../data/nav.db')
const dbDir = path.dirname(dbPath)

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true })
}

export const db = new Database(dbPath)

// 开启 WAL 模式，提升并发读性能
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// 建表迁移（幂等）
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    avatar TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    favicon TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'ungrouped',
    tags TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    is_followed INTEGER NOT NULL DEFAULT 0,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    views INTEGER NOT NULL DEFAULT 0,
    likes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_opened_at TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
`)

// 迁移：为 users 表补充 kimi_api_key 字段（幂等，若已存在则忽略）
try {
  db.exec(`ALTER TABLE users ADD COLUMN kimi_api_key TEXT`)
} catch {
  // 列已存在，忽略
}

try {
  db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`)
} catch {
  /* 已存在 */
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN phone TEXT`)
} catch {
  /* 已存在 */
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN qq_openid TEXT`)
} catch {
  /* 已存在 */
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN brave_api_key TEXT`)
} catch {
  /* 已存在 */
}

db.exec(`
  CREATE TABLE IF NOT EXISTS phone_otps (
    phone TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS email_otps (
    email TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS qq_oauth_states (
    state TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_exchanges (
    code TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ai_daily_usage (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feature TEXT NOT NULL,
    usage_date TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, feature, usage_date)
  );
`)

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL AND phone != '';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_qq_openid ON users(qq_openid) WHERE qq_openid IS NOT NULL AND qq_openid != '';

  -- 业务表常用查询索引
  CREATE INDEX IF NOT EXISTS idx_sites_user ON sites(user_id);
  CREATE INDEX IF NOT EXISTS idx_sites_user_sort ON sites(user_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_sites_user_category ON sites(user_id, category);
  CREATE INDEX IF NOT EXISTS idx_categories_user_sort ON categories(user_id, sort_order);

  -- 过期字段索引：加速清理 & 校验
  CREATE INDEX IF NOT EXISTS idx_email_otps_expires ON email_otps(expires_at);
  CREATE INDEX IF NOT EXISTS idx_phone_otps_expires ON phone_otps(expires_at);
  CREATE INDEX IF NOT EXISTS idx_qq_oauth_states_expires ON qq_oauth_states(expires_at);
  CREATE INDEX IF NOT EXISTS idx_auth_exchanges_expires ON auth_exchanges(expires_at);
  CREATE INDEX IF NOT EXISTS idx_ai_daily_usage_date ON ai_daily_usage(usage_date);
`)

/** 清理所有已过期的 OTP / OAuth state / 一次性换取码 */
export function cleanupExpired(): {
  email_otps: number
  phone_otps: number
  qq_states: number
  auth_exchanges: number
} {
  const now = Date.now()
  const a = db.prepare('DELETE FROM email_otps WHERE expires_at < ?').run(now).changes
  const b = db.prepare('DELETE FROM phone_otps WHERE expires_at < ?').run(now).changes
  const c = db.prepare('DELETE FROM qq_oauth_states WHERE expires_at < ?').run(now).changes
  const d = db.prepare('DELETE FROM auth_exchanges WHERE expires_at < ?').run(now).changes
  return { email_otps: a, phone_otps: b, qq_states: c, auth_exchanges: d }
}

/** 合并同一用户下同名自定义分组（保留 sort_order、id 较小者），并修正站点 category 引用 */
function mergeDuplicateCategories() {
  const userRows = db.prepare('SELECT DISTINCT user_id FROM categories').all() as { user_id: string }[]
  const listStmt = db.prepare(
    'SELECT id, name, sort_order FROM categories WHERE user_id = ? ORDER BY sort_order ASC, id ASC'
  )
  const reassignSites = db.prepare(
    'UPDATE sites SET category = ? WHERE user_id = ? AND category = ?'
  )
  const delCat = db.prepare('DELETE FROM categories WHERE id = ? AND user_id = ?')
  for (const { user_id } of userRows) {
    const rows = listStmt.all(user_id) as { id: string; name: string; sort_order: number }[]
    const byName = new Map<string, string[]>()
    for (const r of rows) {
      const key = r.name.trim().toLowerCase()
      if (!byName.has(key)) byName.set(key, [])
      byName.get(key)!.push(r.id)
    }
    for (const ids of byName.values()) {
      if (ids.length <= 1) continue
      const keeper = ids[0]
      for (let i = 1; i < ids.length; i++) {
        const drop = ids[i]
        reassignSites.run(keeper, user_id, drop)
        delCat.run(drop, user_id)
      }
    }
  }
}

mergeDuplicateCategories()

// 启动时清理一次过期数据，避免 OTP / state 表无限增长
try {
  const r = cleanupExpired()
  if (r.email_otps || r.phone_otps || r.qq_states || r.auth_exchanges) {
    console.log('[db] cleanupExpired on boot:', r)
  }
} catch (e) {
  console.warn('[db] cleanupExpired on boot failed', e)
}

console.log(`[db] Connected: ${dbPath}`)
