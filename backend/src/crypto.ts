/**
 * 对称加密工具：AES-256-GCM。
 *
 * 用途：加密用户存储的第三方 API Key（Kimi / Brave）等敏感字段。
 *
 * 存储格式（字符串）：
 *   enc:v1:<iv_b64u>:<authTag_b64u>:<cipher_b64u>
 *
 * 设计要点：
 * - 每次加密使用独立的随机 IV（12 字节），符合 GCM 最佳实践
 * - 带 authTag，防篡改
 * - 前缀 `enc:v1:` 用于版本演进与「是否已加密」判定
 * - `decryptSecret` 对未加密字符串（无前缀）直接原样返回，兼容历史明文，方便一次性迁移
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { config } from './config.js'

const PREFIX = 'enc:v1:'
const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const KEY_LEN = 32

/**
 * 将 `APP_ENCRYPTION_KEY` 解析为 32 字节 Key：
 * - 64 位 hex → 直接使用
 * - 44/43 位 base64（32 字节的标准/不含 padding base64）→ 解码使用
 * - 其它 → scrypt 派生（仅开发兜底）
 */
function deriveKey(raw: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex')
  try {
    const b = Buffer.from(raw, 'base64')
    if (b.length === KEY_LEN) return b
  } catch {
    /* ignore */
  }
  return scryptSync(raw, 'design-nav-v2-app-key-salt', KEY_LEN)
}

const KEY = deriveKey(config.APP_ENCRYPTION_KEY)

/** 判断字符串是否为本模块加密后的密文 */
export function isEncrypted(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.startsWith(PREFIX)
}

/** 加密任意 UTF-8 字符串为可落库的 ASCII 字符串 */
export function encryptSecret(plain: string): string {
  if (typeof plain !== 'string') throw new TypeError('encryptSecret expects string')
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, KEY, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return (
    PREFIX +
    [iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join(':')
  )
}

/**
 * 解密：
 * - null/undefined/空 → null
 * - 未加密（无 `enc:v1:` 前缀）→ 原样返回，方便迁移期读旧数据
 * - 加密内容但解密失败 → 记日志并返回 null（视为「不可用」，调用方按未配置处理）
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null
  if (!isEncrypted(stored)) return stored
  const parts = stored.split(':')
  // ['enc', 'v1', iv, tag, cipher]
  if (parts.length !== 5) {
    console.warn('[crypto] malformed ciphertext (parts!=5)')
    return null
  }
  try {
    const iv = Buffer.from(parts[2], 'base64url')
    const tag = Buffer.from(parts[3], 'base64url')
    const enc = Buffer.from(parts[4], 'base64url')
    const decipher = createDecipheriv(ALGO, KEY, iv)
    decipher.setAuthTag(tag)
    const dec = Buffer.concat([decipher.update(enc), decipher.final()])
    return dec.toString('utf8')
  } catch (e) {
    console.warn('[crypto] decrypt failed:', (e as Error).message)
    return null
  }
}
