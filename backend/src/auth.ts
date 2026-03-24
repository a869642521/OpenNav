import { OAuth2Client } from 'google-auth-library'
import jwt from 'jsonwebtoken'
import { db } from './db.js'

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID)

export interface AuthUser {
  id: string
  email: string
  name: string
  avatar?: string
}

export interface JwtPayload {
  userId: string
  email: string
}

/** 验证 Google credential JWT，返回用户信息（存在则更新，否则创建） */
export async function verifyGoogleCredential(credential: string): Promise<AuthUser> {
  const ticket = await googleClient.verifyIdToken({
    idToken: credential,
    audience: process.env.GOOGLE_CLIENT_ID,
  })
  const payload = ticket.getPayload()
  if (!payload?.sub || !payload.email) {
    throw new Error('Google 凭证信息不完整')
  }

  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub) as AuthUser | undefined

  if (!existing) {
    db.prepare(
      'INSERT INTO users (id, email, name, avatar) VALUES (?, ?, ?, ?)'
    ).run(payload.sub, payload.email, payload.name ?? payload.email, payload.picture ?? null)
  } else {
    db.prepare(
      'UPDATE users SET name = ?, avatar = ? WHERE id = ?'
    ).run(payload.name ?? existing.name, payload.picture ?? existing.avatar, payload.sub)
  }

  return {
    id: payload.sub,
    email: payload.email,
    name: payload.name ?? payload.email,
    avatar: payload.picture,
  }
}

/** 签发 JWT */
export function signToken(user: AuthUser): string {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('未配置 JWT_SECRET')
  return jwt.sign({ userId: user.id, email: user.email } as JwtPayload, secret, {
    expiresIn: '7d',
  })
}

/** 验证 JWT，返回 payload */
export function verifyToken(token: string): JwtPayload {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('未配置 JWT_SECRET')
  return jwt.verify(token, secret) as JwtPayload
}
