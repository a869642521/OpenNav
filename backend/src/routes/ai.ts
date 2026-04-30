import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware.js'
import { db } from '../db.js'
import { assertKimiKeyHeaderSafe } from '../kimiKeyValidate.js'
import { fetchWithTimeout, FetchTimeoutError } from '../httpClient.js'
import { validateBody, aiSiteSchema, aiLibrarySearchSchema } from '../validate.js'
import { decryptSecret } from '../crypto.js'

// 外部服务超时：Kimi 推理较慢，给足时间；Brave 搜索要快
const KIMI_TIMEOUT_MS = 60_000
const BRAVE_TIMEOUT_MS = 10_000

const router = Router()
router.use(requireAuth)

type AiQuotaFeature = 'summary' | 'similar'
type AiQuotaError = Error & {
  status?: number
  expose?: boolean
  quota?: { limit: number; used: number; remaining: number }
}

const AI_DAILY_LIMITS: Record<AiQuotaFeature, number> = {
  summary: 5,
  similar: 3,
}

function currentUsageDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function consumeDailyAiQuota(userId: string, feature: AiQuotaFeature): { limit: number; used: number; remaining: number } {
  const limit = AI_DAILY_LIMITS[feature]
  const usageDate = currentUsageDate()
  const row = db
    .prepare('SELECT count FROM ai_daily_usage WHERE user_id = ? AND feature = ? AND usage_date = ?')
    .get(userId, feature, usageDate) as { count: number } | undefined
  const used = row?.count ?? 0
  if (used >= limit) {
    const err = new Error(`今日 ${feature === 'summary' ? 'AI 总结' : '相似网站推荐'} 免费额度已用完（${limit} 次/天）`) as AiQuotaError
    err.status = 429
    err.expose = true
    err.quota = { limit, used, remaining: 0 }
    throw err
  }
  db.prepare(`
    INSERT INTO ai_daily_usage (user_id, feature, usage_date, count, updated_at)
    VALUES (?, ?, ?, 1, datetime('now'))
    ON CONFLICT(user_id, feature, usage_date)
    DO UPDATE SET count = count + 1, updated_at = datetime('now')
  `).run(userId, feature, usageDate)
  const nextUsed = used + 1
  return { limit, used: nextUsed, remaining: Math.max(0, limit - nextUsed) }
}

/**
 * Kimi 接入协议说明（通过环境变量 KIMI_API_BASE_URL 配置）：
 *
 * 普通 Moonshot 控制台 Key → OpenAI chat/completions 协议：
 *   KIMI_API_BASE_URL=https://api.moonshot.cn/v1   （国内）
 *   KIMI_API_BASE_URL=https://api.moonshot.ai/v1   （国际）
 *
 * Kimi Coding Plan Key → Anthropic Messages 协议（完全不同的接口格式！）：
 *   KIMI_API_BASE_URL=https://api.kimi.com/coding/v1
 *   或仅设 KIMI_USE_CODING_PLAN=1（与下面 KIMI_API_BASE_URL 二选一，未设 URL 时生效）
 *   协议：POST /messages，x-api-key 认证，anthropic-version 头，Anthropic JSON 格式
 *
 * 不设置 URL 且未开 Coding 开关时，默认 moonshot.cn（OpenAI 协议）。
 */
const MOONSHOT_CN_BASE = 'https://api.moonshot.cn/v1'
const KIMI_CODING_BASE = 'https://api.kimi.com/coding/v1'

function getConfig(): { baseUrl: string; protocol: 'openai' | 'anthropic' } {
  const custom = process.env.KIMI_API_BASE_URL?.trim().replace(/\/$/, '')
  if (custom) {
    const protocol = custom.includes('kimi.com/coding') ? 'anthropic' : 'openai'
    return { baseUrl: custom, protocol }
  }
  const codingFlag = process.env.KIMI_USE_CODING_PLAN?.trim().toLowerCase()
  const useCoding =
    codingFlag === '1' ||
    codingFlag === 'true' ||
    codingFlag === 'yes' ||
    process.env.KIMI_CODING_PLAN === '1'
  if (useCoding) {
    return { baseUrl: KIMI_CODING_BASE, protocol: 'anthropic' }
  }
  return { baseUrl: MOONSHOT_CN_BASE, protocol: 'openai' }
}

/** 未设置 KIMI_MODEL 时：OpenAI/Moonshot 用 moonshot-v1-8k，Anthropic/Coding 用 kimi-k2.5 */
function resolveKimiModel(protocol: 'openai' | 'anthropic'): string {
  const fromEnv = process.env.KIMI_MODEL?.trim()
  if (fromEnv) return fromEnv
  return protocol === 'anthropic' ? 'kimi-k2.5' : 'moonshot-v1-8k'
}

/** 获取 Kimi API Key：用户自带 Key 优先，未配置则回退到平台环境变量。 */
function getUserKimiKey(req: AuthRequest): string {
  const userId = req.user!.userId
  const row = db
    .prepare('SELECT kimi_api_key FROM users WHERE id = ?')
    .get(userId) as { kimi_api_key: string | null } | undefined
  const plain = decryptSecret(row?.kimi_api_key)?.trim() || process.env.KIMI_API_KEY?.trim() || ''
  if (!plain) {
    const err = new Error('请先在「设置」中配置你的 Kimi API Key，或联系站点管理员配置平台 KIMI_API_KEY')
    ;(err as Error & { status?: number }).status = 403
    throw err
  }
  assertKimiKeyHeaderSafe(plain)
  return plain
}

const SYSTEM_PROMPT =
  '你是一个专业的网站导航助手。请严格按照用户要求的 JSON 格式返回内容，不要包含任何 Markdown 代码块或额外说明文字，只输出纯 JSON。'

/** 从 Kimi OpenAI / Anthropic 风格 JSON 错误体中提取简短说明（截断，避免把整页 HTML 回给前端） */
function extractUpstreamHint(rawBody: string): string {
  const slice = rawBody.trim().slice(0, 1200)
  try {
    const j = JSON.parse(slice) as Record<string, unknown>
    const err = j.error
    if (err && typeof err === 'object' && err !== null) {
      const o = err as { message?: string; type?: string }
      if (o.message) return String(o.message).trim().slice(0, 320)
    }
    if (typeof err === 'string') return err.trim().slice(0, 320)
    if (typeof j.message === 'string') return j.message.trim().slice(0, 320)
  } catch {
    /* 非 JSON */
  }
  return slice.replace(/\s+/g, ' ').slice(0, 200)
}

function createUpstreamAiError(httpStatus: number, rawBody: string): Error & { status?: number; expose?: boolean } {
  const hint = extractUpstreamHint(rawBody)
  const err = new Error() as Error & { status?: number; expose?: boolean }
  err.expose = true

  if (httpStatus >= 500) {
    err.message = hint
      ? `AI 服务端异常（${httpStatus}）：${hint}。请稍后重试。`
      : 'AI 服务暂时不可用，请稍后重试'
    err.status = 502
    return err
  }

  if (httpStatus === 401) {
    err.message = hint
      ? `API Key 鉴权失败：${hint}。请确认 Key 未过期，且与接口一致（普通 Moonshot Key 用 api.moonshot.cn + OpenAI 协议；Kimi Coding Key 用 api.kimi.com/coding + Anthropic 协议）。`
      : 'API Key 无效或未授权。请检查 Key，并确认后端 KIMI_API_BASE_URL 与 Key 类型匹配。'
    err.status = 400
    return err
  }

  if (httpStatus === 404) {
    err.message = hint
      ? `请求地址不存在（404）：${hint}。请检查环境变量 KIMI_API_BASE_URL（例如普通 Key 用 https://api.moonshot.cn/v1，Coding Key 用 https://api.kimi.com/coding/v1）。`
      : '上游接口路径不存在（404）。请检查 KIMI_API_BASE_URL 是否与 Key 类型一致。'
    err.status = 400
    return err
  }

  if (httpStatus === 429) {
    err.message = hint
      ? `请求过于频繁或被限额：${hint}`
      : '上游限流（429），请稍后再试或检查账户额度。'
    err.status = 400
    return err
  }

  err.message = hint
    ? `AI 请求被拒绝（HTTP ${httpStatus}）：${hint}。常见原因：模型名 KIMI_MODEL 与当前接口不匹配（如 moonshot-v1-8k 与 kimi-k2.5 对应不同产品线）。`
    : `AI 请求失败（HTTP ${httpStatus}）。请检查后端 KIMI_MODEL、KIMI_API_BASE_URL 与 Key 类型是否一致。`
  err.status = 400
  return err
}

/**
 * OpenAI chat/completions 协议（普通 Moonshot Key）
 */
async function callKimiOpenAI(systemPrompt: string, userPrompt: string, apiKey: string, baseUrl: string): Promise<string> {
  const model = resolveKimiModel('openai')
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_completion_tokens: 4096,
  }
  if (model.startsWith('moonshot-v1')) body.temperature = 0.3

  const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    timeoutMs: KIMI_TIMEOUT_MS,
  })
  const rawBody = await res.text()
  if (!res.ok) {
    console.warn('[kimi:openai] failed', res.status, rawBody.slice(0, 500))
    throw createUpstreamAiError(res.status, rawBody)
  }
  const data = JSON.parse(rawBody) as {
    choices?: { message?: { content?: string; reasoning_content?: string } }[]
  }
  const msg = data?.choices?.[0]?.message
  const text = (msg?.content && String(msg.content).trim()) || (msg?.reasoning_content && String(msg.reasoning_content).trim()) || ''
  if (!text) throw new Error('Kimi 返回了空内容')
  return text
}

/**
 * Anthropic Messages 协议（Kimi Coding Plan Key）
 * 端点：POST {base}/messages
 * 认证：x-api-key，需要 anthropic-version 头
 * system 字段单独传，messages 不含 system role
 */
async function callKimiAnthropic(systemPrompt: string, userPrompt: string, apiKey: string, baseUrl: string): Promise<string> {
  const model = resolveKimiModel('anthropic')
  const body: Record<string, unknown> = {
    model,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    max_tokens: 4096,
  }

  const res = await fetchWithTimeout(`${baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    timeoutMs: KIMI_TIMEOUT_MS,
  })
  const rawBody = await res.text()
  if (!res.ok) {
    console.warn('[kimi:anthropic] failed', res.status, rawBody.slice(0, 500))
    throw createUpstreamAiError(res.status, rawBody)
  }
  // Anthropic 响应格式：{ content: [{ type: "text", text: "..." }] }
  const data = JSON.parse(rawBody) as {
    content?: { type: string; text?: string }[]
  }
  const text = data?.content?.find(b => b.type === 'text')?.text?.trim() ?? ''
  if (!text) throw new Error('Kimi 返回了空内容')
  return text
}

async function callKimi(userPrompt: string, apiKey: string): Promise<string> {
  const { baseUrl, protocol } = getConfig()
  console.log(`[kimi] using ${protocol} @ ${baseUrl}`)
  if (protocol === 'anthropic') {
    return callKimiAnthropic(SYSTEM_PROMPT, userPrompt, apiKey, baseUrl)
  }
  return callKimiOpenAI(SYSTEM_PROMPT, userPrompt, apiKey, baseUrl)
}

/**
 * 从 AI 返回的富文本中提取 JSON，并做多轮清洗：
 * 1) 去掉 BOM / 零宽字符
 * 2) 剥离 ```json ...``` 围栏
 * 3) 若夹在自然语言里，截取首个 `{…}` 或 `[…]` 片段
 * 4) 去掉常见的尾随逗号、非法控制字符
 */
function extractJson(raw: string): string {
  if (!raw) return ''
  let s = raw
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\u2060]/g, '')
    .trim()

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()

  if (!/^[\[{]/.test(s)) {
    const firstObj = s.indexOf('{')
    const firstArr = s.indexOf('[')
    const candidates = [firstObj, firstArr].filter((i) => i >= 0)
    if (candidates.length) {
      const start = Math.min(...candidates)
      const openChar = s[start]
      const closeChar = openChar === '{' ? '}' : ']'
      const end = s.lastIndexOf(closeChar)
      if (end > start) s = s.slice(start, end + 1)
    }
  }

  // 去除尾随逗号（对象或数组末尾的 ,}） /  ,] ）
  s = s.replace(/,\s*([}\]])/g, '$1')

  return s.trim()
}

/** 从 AI 文本安全解析 JSON；失败抛 SyntaxError，路由层统一 422 */
function parseAiJson<T = unknown>(raw: string): T {
  const text = extractJson(raw)
  try {
    return JSON.parse(text) as T
  } catch (e) {
    console.warn('[ai] JSON parse failed:', (e as Error).message, 'head=', text.slice(0, 160))
    throw e
  }
}

/** 同类推荐按主机名去重（同一站点多条落地页如豆包首页与 /chat 只保留先出现的一条） */
function similarHostnameDedupeKey(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return ''
  const t = rawUrl.trim()
  try {
    const u = new URL(t.startsWith('http://') || t.startsWith('https://') ? t : `https://${t}`)
    return u.hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return t
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]
      .replace(/\/+$/, '')
      .toLowerCase()
  }
}

function dedupeSimilarSitesByHostname(
  items: { name?: string; url?: string; reason?: string }[]
): { name?: string; url?: string; reason?: string }[] {
  const seen = new Set<string>()
  const out: { name?: string; url?: string; reason?: string }[] = []
  for (const it of items) {
    const k = similarHostnameDedupeKey(it.url)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(it)
  }
  return out
}

/** POST /ai/similar — 发现同类优质网站 */
router.post('/similar', validateBody(aiSiteSchema), async (req: AuthRequest, res, next) => {
  try {
    const apiKey = getUserKimiKey(req)
    const quota = consumeDailyAiQuota(req.user!.userId, 'similar')
    const { name, url, description, lang } = req.body as { name: string; url: string; description?: string; lang?: string }
    const isChinese = lang !== 'en'
    const langInstruction = isChinese
      ? `语言要求：
- name 字段：优先使用中文名称（如有官方中文名则用中文，如 "Figma" 等无中文名的保持原名）
- reason 字段：必须使用中文撰写
- 优先推荐有中文界面或面向中文用户的同类网站；若无合适中文站，则推荐国际知名网站但 reason 仍用中文`
      : `Language requirement:
- Use English for both "name" and "reason" fields
- Recommend internationally well-known websites`
    const prompt = `网站名称：${name}
网站地址：${url}
网站描述：${description ?? '无'}

请分析上述网站的类型和定位，然后推荐恰好 20 个同类型的优质网站（JSON 数组长度必须为 20，便于前端在排除已收藏后仍能展示 10 条新站）。
要求：
1. 推荐真实存在、可访问的知名网站；每个域名只出现一次（不要同一网站写多条不同路径）
2. 每个网站给出一句话推荐理由
3. ${langInstruction}
4. 严格按以下 JSON 数组格式返回，不要输出其他内容：
[
  { "name": "网站名", "url": "https://...", "reason": "推荐理由" }
]`
    const raw = await callKimi(prompt, apiKey)
    const parsed = parseAiJson(raw)
    if (!Array.isArray(parsed)) {
      res.status(422).json({ error: 'AI 返回格式错误：应为 JSON 数组' })
      return
    }
    const result = dedupeSimilarSitesByHostname(parsed).slice(0, 20)
    res.setHeader('X-AI-Quota-Limit', String(quota.limit))
    res.setHeader('X-AI-Quota-Remaining', String(quota.remaining))
    res.json(result)
  } catch (err) {
    if (err instanceof FetchTimeoutError) {
      res.status(504).json({ error: 'Kimi 接口请求超时，请稍后重试' })
      return
    }
    const e = err as AiQuotaError
    if (e.status === 403) {
      res.status(403).json({ error: e.message, needConfig: true })
      return
    }
    if (e.status === 400 || e.status === 502) {
      res.status(e.status).json({ error: e.message })
      return
    }
    if (e.status === 429) {
      res.status(429).json({ error: e.message, quota: e.quota })
      return
    }
    if (err instanceof SyntaxError) {
      res.status(422).json({ error: 'AI 返回内容无法解析为 JSON，请重试' })
      return
    }
    next(err)
  }
})

/** POST /ai/resources — 获取相关资料教程 */
router.post('/resources', validateBody(aiSiteSchema), async (req: AuthRequest, res, next) => {
  try {
    const apiKey = getUserKimiKey(req)
    const { name, url, description, lang } = req.body as { name: string; url: string; description?: string; lang?: string }
    const isChinese = lang !== 'en'
    const langInstruction = isChinese
      ? '语言要求：summary 和所有 title 字段必须使用中文；优先提供中文教程、中文文档或中文文章链接，若无中文资源则可提供英文链接但 title 仍翻译为中文。'
      : 'Language requirement: Write all "summary" and "title" fields in English; recommend English-language tutorials and documentation.'
    const prompt = `网站名称：${name}
网站地址：${url}
网站描述：${description ?? '无'}

请为这个网站提供以下内容：
1. 一段简短的工具/网站介绍（50 字以内）
2. 5 条关于该网站的优质使用教程、官方文档或相关文章链接（真实可访问）
3. ${langInstruction}

严格按以下 JSON 格式返回，不要输出其他内容：
{
  "summary": "简介文字",
  "links": [
    { "title": "标题", "url": "https://..." }
  ]
}`
    const raw = await callKimi(prompt, apiKey)
    const result = parseAiJson(raw)
    res.json(result)
  } catch (err) {
    if (err instanceof FetchTimeoutError) {
      res.status(504).json({ error: 'Kimi 接口请求超时，请稍后重试' })
      return
    }
    const e = err as AiQuotaError
    if (e.status === 403) {
      res.status(403).json({ error: e.message, needConfig: true })
      return
    }
    if (e.status === 400 || e.status === 502) {
      res.status(e.status).json({ error: e.message })
      return
    }
    if (err instanceof SyntaxError) {
      res.status(422).json({ error: 'AI 返回内容无法解析为 JSON，请重试' })
      return
    }
    next(err)
  }
})

/** 获取当前用户的 Brave Search API Key（DB 中为密文），未配置则抛 402 */
function getUserBraveKey(req: AuthRequest): string {
  const userId = req.user!.userId
  const row = db
    .prepare('SELECT brave_api_key FROM users WHERE id = ?')
    .get(userId) as { brave_api_key: string | null } | undefined
  // 优先使用用户自己存储的 Key（密文，需解密），回退到服务端环境变量（自部署场景）
  const decrypted = decryptSecret(row?.brave_api_key)?.trim()
  const key = decrypted || process.env.BRAVE_API_KEY?.trim() || ''
  if (!key) {
    const err = new Error('请先在「设置」中配置你的 Brave Search API Key') as Error & { status?: number }
    err.status = 402
    throw err
  }
  return key
}

/** 查询串是否含中日韩表意文字（用户用中文搜时应走中文搜索语言，避免 Brave 默认 en 全英文结果） */
function librarySearchQueryLooksChinese(q: string): boolean {
  return /[\u3400-\u9FFF\uF900-\uFAFF]/.test(q)
}

/**
 * Brave Web Search 默认 country=US、search_lang=en；显式指定中文区与语言后，中文查询才会以中文网页为主。
 * uiLang 来自前端界面语言；即使用户切成英文界面，只要搜索框里打了中文，仍按中文搜索。
 */
function braveLibrarySearchLocale(q: string, uiLang?: string) {
  const isEnUi = uiLang === 'en'
  const preferZh = !isEnUi || librarySearchQueryLooksChinese(q)
  if (preferZh) {
    return { country: 'CN', search_lang: 'zh-hans', ui_lang: 'zh-CN' as const }
  }
  return { country: 'US', search_lang: 'en', ui_lang: 'en-US' as const }
}

/** POST /ai/library-search — Brave Search API 代理，返回学习库所需的真实搜索结果 */
router.post('/library-search', validateBody(aiLibrarySearchSchema), async (req: AuthRequest, res, next) => {
  try {
    const braveKey = getUserBraveKey(req)
    const { query, lang, siteName } = req.body as {
      query: string
      lang?: string
      siteName?: string
    }
    const rawQ = query.trim().slice(0, 200)
    const siteNameClean = (siteName ?? '').trim().slice(0, 80)
    const isCjkQuery = /[\u3400-\u9FFF\uF900-\uFAFF]/.test(rawQ)
    const loc = braveLibrarySearchLocale(rawQ, lang)
    let finalQ: string
    if (loc.country === 'CN' && isCjkQuery) {
      const bias = /[\u3400-\u9FFF\uF900-\uFAFF]/.test(siteNameClean) ? '' : ' 中文'
      finalQ = siteNameClean
        ? `${rawQ} ${siteNameClean}${bias}`
        : `${rawQ}${bias}`
    } else {
      finalQ = siteNameClean ? `${siteNameClean} ${rawQ}` : rawQ
    }
    const q = finalQ.trim().slice(0, 300)
    const params = new URLSearchParams({
      q,
      count: '10',
      country: loc.country,
      search_lang: loc.search_lang,
      ui_lang: loc.ui_lang,
    })
    const searchUrl = `https://api.search.brave.com/res/v1/web/search?${params.toString()}`
    const resp = await fetchWithTimeout(searchUrl, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': braveKey,
      },
      timeoutMs: BRAVE_TIMEOUT_MS,
    })
    if (!resp.ok) {
      const text = await resp.text()
      console.warn('[brave-search] failed', resp.status, text.slice(0, 300))
      res.status(502).json({ error: `Brave Search 请求失败（HTTP ${resp.status}）：${text.slice(0, 200)}` })
      return
    }
    const data = await resp.json() as { web?: { results?: { title?: string; url?: string; description?: string }[] } }
    const results = (data.web?.results ?? [])
      .slice(0, 10)
      .map(r => ({ title: r.title ?? '', url: r.url ?? '', description: r.description ?? '' }))
      .filter(r => r.url)
    res.json(results)
  } catch (err) {
    if (err instanceof FetchTimeoutError) {
      res.status(504).json({ error: 'Brave Search 请求超时，请稍后重试' })
      return
    }
    const e = err as AiQuotaError
    if (e.status === 402) {
      res.status(402).json({ error: e.message, needConfig: true })
      return
    }
    next(err)
  }
})

/** POST /ai/summary — 深度总结网站 */
router.post('/summary', validateBody(aiSiteSchema), async (req: AuthRequest, res, next) => {
  try {
    const apiKey = getUserKimiKey(req)
    const quota = consumeDailyAiQuota(req.user!.userId, 'summary')
    const { name, url, description, lang } = req.body as { name: string; url: string; description?: string; lang?: string }
    const isChinese = lang !== 'en'
    const langInstruction = isChinese
      ? '语言要求：所有字段的文字内容（overview、architecture、features、visual 各字段、tech、skills）必须使用中文撰写。'
      : 'Language requirement: Write all text fields (overview, architecture, features, visual fields, tech, skills) in English.'
    const prompt = `网站名称：${name}
网站地址：${url}
网站描述：${description ?? '无'}

请对上述网站做深度分析。${langInstruction}
严格按以下 JSON 格式返回，不要输出任何其他内容：
{
  "overview": "产品概述与定位（100字以内）",
  "architecture": "产品架构说明，包括核心模块划分（100字以内）",
  "features": ["核心功能1", "核心功能2", "核心功能3", "核心功能4", "核心功能5"],
  "visual": {
    "style": "整体视觉风格描述（如：极简主义、Material Design、暗色科技风等）",
    "colors": ["主色描述或色值", "辅助色描述"],
    "layout": "布局方式描述（如：左侧导航+右侧内容、卡片式网格布局等）",
    "typography": "字体/排版特征描述",
    "components": ["典型UI组件1", "典型UI组件2", "典型UI组件3"]
  },
  "tech": ["推断使用的技术栈1", "技术栈2", "技术栈3"],
  "skills": ["围绕该网站类别的skill关键词1", "skill关键词2", "skill关键词3", "skill关键词4", "skill关键词5"]
}`
    const raw = await callKimi(prompt, apiKey)
    const result = parseAiJson(raw)
    res.setHeader('X-AI-Quota-Limit', String(quota.limit))
    res.setHeader('X-AI-Quota-Remaining', String(quota.remaining))
    res.json(result)
  } catch (err) {
    if (err instanceof FetchTimeoutError) {
      res.status(504).json({ error: 'Kimi 接口请求超时，请稍后重试' })
      return
    }
    const e = err as AiQuotaError
    if (e.status === 403) {
      res.status(403).json({ error: e.message, needConfig: true })
      return
    }
    if (e.status === 400 || e.status === 502) {
      res.status(e.status).json({ error: e.message })
      return
    }
    if (e.status === 429) {
      res.status(429).json({ error: e.message, quota: e.quota })
      return
    }
    if (err instanceof SyntaxError) {
      res.status(422).json({ error: 'AI 返回内容无法解析为 JSON，请重试' })
      return
    }
    next(err)
  }
})

export default router
