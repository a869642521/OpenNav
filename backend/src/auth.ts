import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { config } from './config.js'

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

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10)
}

export function verifyPassword(plain: string, hash: string | null | undefined): boolean {
  if (!hash) return false
  return bcrypt.compareSync(plain, hash)
}

/** 签发 JWT */
export function signToken(user: AuthUser): string {
  return jwt.sign({ userId: user.id, email: user.email } as JwtPayload, config.JWT_SECRET, {
    expiresIn: '7d',
  })
}

/** 验证 JWT，返回 payload */
export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, config.JWT_SECRET) as JwtPayload
}

export function rowToAuthUser(row: {
  id: string
  email: string
  name: string
  avatar: string | null
}): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatar: row.avatar ?? undefined,
  }
}
