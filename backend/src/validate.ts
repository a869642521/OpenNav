/**
 * 统一的请求体校验（基于 zod）。
 *
 * 设计：
 * - middleware 形式：validateBody(schema)，校验失败直接返回 400 + 具体字段
 * - 校验成功后，将 parsed 数据回写到 req.body，路由处理逻辑沿用原有解构即可
 * - 所有业务 schema 集中定义在本文件，避免散落到各路由
 */

import type { RequestHandler } from 'express'
import { z, type ZodTypeAny } from 'zod'

export function validateBody<T extends ZodTypeAny>(schema: T): RequestHandler {
  return (req, res, next) => {
    const r = schema.safeParse(req.body)
    if (!r.success) {
      const issue = r.error.issues[0]
      const path = issue?.path.join('.') || 'body'
      res.status(400).json({
        error: issue ? `${path}: ${issue.message}` : '请求参数不合法',
        issues: r.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      })
      return
    }
    req.body = r.data
    next()
  }
}

// ---------- 通用 ----------

const trimmedString = (max: number, msg = '不能为空') =>
  z.string().trim().min(1, msg).max(max)

const optTrimmedString = (max: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() : v),
    z.string().max(max).optional()
  )

const bool01 = z.union([z.boolean(), z.literal(0), z.literal(1)]).transform((v) => Boolean(v))

// ---------- 认证 ----------

const emailSchema = z
  .string({ error: '请输入邮箱' })
  .trim()
  .toLowerCase()
  .email('邮箱格式不正确')
  .max(200)
  .refine(
    (em) => !em.endsWith('@phone.user') && !em.endsWith('@qq.user'),
    '该邮箱后缀不可使用'
  )

const cnPhoneSchema = z
  .string({ error: '请输入手机号' })
  .transform((s) => s.replace(/\s+/g, ''))
  .refine((p) => /^1\d{10}$/.test(p), '请输入 11 位中国大陆手机号')

const otpCodeSchema = z
  .string({ error: '请输入验证码' })
  .trim()
  .regex(/^\d{6}$/, '验证码应为 6 位数字')

export const emailRegisterSchema = z.object({
  email: emailSchema,
  password: z.string().min(6, '密码至少 6 位').max(200),
  name: optTrimmedString(64),
})

export const emailLoginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, '请输入密码').max(200),
})

export const emailOtpSendSchema = z.object({
  email: emailSchema,
})

export const emailOtpVerifySchema = z.object({
  email: emailSchema,
  code: otpCodeSchema,
})

export const phoneSendSchema = z.object({
  phone: cnPhoneSchema,
})

export const phoneLoginSchema = z.object({
  phone: cnPhoneSchema,
  code: otpCodeSchema,
})

export const exchangeSchema = z.object({
  code: trimmedString(128, '缺少 auth_code'),
})

// ---------- Sites ----------

const tagsSchema = z
  .array(z.string())
  .transform((arr) => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const x of arr) {
      if (typeof x !== 'string') continue
      const t = x.trim()
      if (!t) continue
      const k = t.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      out.push(t)
    }
    return out
  })

export const siteCreateSchema = z.object({
  id: optTrimmedString(64),
  favicon: z.string().max(2048).optional(),
  name: trimmedString(200, '站点名不能为空'),
  url: trimmedString(2048, 'URL 不能为空'),
  category: optTrimmedString(64),
  tags: tagsSchema.optional(),
  notes: z.string().max(10_000).optional(),
  description: z.string().max(10_000).optional(),
  isFollowed: z.boolean().optional(),
  isFavorite: z.boolean().optional(),
  views: z.number().int().nonnegative().max(10_000_000).optional(),
  likes: z.number().int().nonnegative().max(10_000_000).optional(),
  createdAt: optTrimmedString(40),
  lastOpenedAt: z.union([z.string().max(40), z.null()]).optional(),
  sortOrder: z.number().int().optional(),
})

export const sitePatchSchema = siteCreateSchema
  .partial()
  .omit({ id: true, createdAt: true })
  .refine((obj) => Object.keys(obj).length > 0, '请求体不能为空')

export const siteReorderSchema = z.object({
  orderedIds: z
    .array(z.string().trim().min(1))
    .min(1, 'orderedIds 不能为空')
    .refine((ids) => new Set(ids).size === ids.length, 'orderedIds 存在重复'),
})

// ---------- Categories ----------

export const categoryCreateSchema = z.object({
  name: trimmedString(64, '分组名不能为空'),
})

// ---------- Settings ----------

/** key 允许空字符串表示清除 */
export const apiKeySchema = z.object({
  key: z.string().max(4096).optional(),
})

// ---------- AI ----------

// 前端目前只传 'zh' / 'en'；这里保守放宽，未来扩展不会挂
const aiLangSchema = z.string().max(16).optional()

export const aiSiteSchema = z.object({
  name: trimmedString(500, '缺少 name'),
  url: trimmedString(2048, '缺少 url'),
  description: z.string().max(10_000).optional(),
  lang: aiLangSchema,
})

export const aiLibrarySearchSchema = z.object({
  query: trimmedString(300, '缺少 query 参数'),
  lang: aiLangSchema,
  siteName: optTrimmedString(200),
})

// 避免未使用警告
export const __types = { bool01 }
