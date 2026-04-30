/**
 * 一次性迁移：将 DB 中历史明文 API Key 升级为密文。
 *
 * 触发时机：服务启动时调用一次（`index.ts` 中）。
 * 幂等：已是密文（`enc:v1:` 前缀）的行会被跳过，可反复启动。
 *
 * 风险提示：若 `APP_ENCRYPTION_KEY` 被替换，旧密文将无法解密，这类行会被记日志但不会被破坏。
 */

import { db } from './db.js'
import { encryptSecret, isEncrypted } from './crypto.js'

interface UserSecretRow {
  id: string
  kimi_api_key: string | null
  brave_api_key: string | null
}

export function migrateEncryptApiKeys(): { scanned: number; migrated: number } {
  const rows = db
    .prepare(
      `SELECT id, kimi_api_key, brave_api_key FROM users
       WHERE (kimi_api_key IS NOT NULL AND kimi_api_key != '')
          OR (brave_api_key IS NOT NULL AND brave_api_key != '')`
    )
    .all() as UserSecretRow[]

  if (rows.length === 0) return { scanned: 0, migrated: 0 }

  const updateKimi = db.prepare('UPDATE users SET kimi_api_key = ? WHERE id = ?')
  const updateBrave = db.prepare('UPDATE users SET brave_api_key = ? WHERE id = ?')

  let migrated = 0
  db.transaction(() => {
    for (const row of rows) {
      if (row.kimi_api_key && !isEncrypted(row.kimi_api_key)) {
        updateKimi.run(encryptSecret(row.kimi_api_key), row.id)
        migrated += 1
      }
      if (row.brave_api_key && !isEncrypted(row.brave_api_key)) {
        updateBrave.run(encryptSecret(row.brave_api_key), row.id)
        migrated += 1
      }
    }
  })()

  return { scanned: rows.length, migrated }
}
