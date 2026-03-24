import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware.js'
import { db } from '../db.js'

const router = Router()
router.use(requireAuth)

/**
 * Kimi 接入协议说明（通过环境变量 KIMI_API_BASE_URL 配置）：
 *
 * 普通 Moonshot 控制台 Key → OpenAI chat/completions 协议：
 *   KIMI_API_BASE_URL=https://api.moonshot.cn/v1   （国内）
 *   KIMI_API_BASE_URL=https://api.moonshot.ai/v1   （国际）
 *
 * Kimi Coding Plan Key → Anthropic Messages 协议（完全不同的接口格式！）：
 *   KIMI_API_BASE_URL=https://api.kimi.com/coding/v1
 *   协议：POST /messages，x-api-key 认证，anthropic-version 头，Anthropic JSON 格式
 *
 * 不设置时默认用 moonshot.cn（OpenAI 协议）。
 */
const MOONSHOT_CN_BASE = 'https://api.moonshot.cn/v1'
const KIMI_CODING_BASE = 'https://api.kimi.com/coding/v1'

function getConfig(): { baseUrl: string; protocol: 'openai' | 'anthropic' } {
  const custom = process.env.KIMI_API_BASE_URL?.trim().replace(/\/$/, '')
  const baseUrl = custom ?? MOONSHOT_CN_BASE
  const protocol = baseUrl.includes('kimi.com/coding') ? 'anthropic' : 'openai'
  return { baseUrl, protocol }
}

/** 可用环境变量覆盖，默认 kimi-k2.5 */
const KIMI_MODEL = process.env.KIMI_MODEL ?? 'kimi-k2.5'

/** 获取当前登录用户的 Kimi API Key，未配置则抛出 403 */
function getUserKimiKey(req: AuthRequest): string {
  const userId = req.user!.userId
  const row = db
    .prepare('SELECT kimi_api_key FROM users WHERE id = ?')
    .get(userId) as { kimi_api_key: string | null } | undefined
  if (!row?.kimi_api_key) {
    const err = new Error('请先在「设置」中配置你的 Kimi API Key')
    ;(err as Error & { status?: number }).status = 403
    throw err
  }
  return row.kimi_api_key
}

const SYSTEM_PROMPT =
  '你是一个专业的网站导航助手。请严格按照用户要求的 JSON 格式返回内容，不要包含任何 Markdown 代码块或额外说明文字，只输出纯 JSON。'

/**
 * OpenAI chat/completions 协议（普通 Moonshot Key）
 */
async function callKimiOpenAI(systemPrompt: string, userPrompt: string, apiKey: string, baseUrl: string): Promise<string> {
  const model = KIMI_MODEL
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_completion_tokens: 4096,
  }
  if (model.startsWith('moonshot-v1')) body.temperature = 0.3

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })
  const rawBody = await res.text()
  if (!res.ok) {
    console.warn('[kimi:openai] failed', res.status, rawBody.slice(0, 500))
    const apiErr = new Error(`Kimi API 请求失败（${res.status}）：${rawBody}`)
    ;(apiErr as Error & { status?: number }).status = res.status >= 500 ? 502 : 400
    throw apiErr
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
  const model = KIMI_MODEL
  const body: Record<string, unknown> = {
    model,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    max_tokens: 4096,
  }

  const res = await fetch(`${baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })
  const rawBody = await res.text()
  if (!res.ok) {
    console.warn('[kimi:anthropic] failed', res.status, rawBody.slice(0, 500))
    const apiErr = new Error(`Kimi API 请求失败（${res.status}）：${rawBody}`)
    ;(apiErr as Error & { status?: number }).status = res.status >= 500 ? 502 : 400
    throw apiErr
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

function extractJson(raw: string): string {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (match) return match[1].trim()
  return raw.trim()
}

/** POST /ai/similar — 发现同类优质网站 */
router.post('/similar', async (req: AuthRequest, res, next) => {
  try {
    const apiKey = getUserKimiKey(req)
    const { name, url, description } = req.body as { name?: string; url?: string; description?: string }
    if (!name || !url) {
      res.status(400).json({ error: '缺少 name 或 url' })
      return
    }
    const prompt = `网站名称：${name}
网站地址：${url}
网站描述：${description ?? '无'}

请分析上述网站的类型和定位，然后推荐 5 个同类型的优质网站。
要求：
1. 推荐真实存在、可访问的知名网站
2. 每个网站给出一句话推荐理由
3. 严格按以下 JSON 数组格式返回，不要输出其他内容：
[
  { "name": "网站名", "url": "https://...", "reason": "推荐理由" }
]`
    const raw = await callKimi(prompt, apiKey)
    const result = JSON.parse(extractJson(raw))
    res.json(result)
  } catch (err) {
    const e = err as Error & { status?: number }
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

/** POST /ai/resources — 获取相关资料教程 */
router.post('/resources', async (req: AuthRequest, res, next) => {
  try {
    const apiKey = getUserKimiKey(req)
    const { name, url, description } = req.body as { name?: string; url?: string; description?: string }
    if (!name || !url) {
      res.status(400).json({ error: '缺少 name 或 url' })
      return
    }
    const prompt = `网站名称：${name}
网站地址：${url}
网站描述：${description ?? '无'}

请为这个网站提供以下内容：
1. 一段简短的工具/网站介绍（50 字以内）
2. 5 条关于该网站的优质使用教程、官方文档或相关文章链接（真实可访问）

严格按以下 JSON 格式返回，不要输出其他内容：
{
  "summary": "简介文字",
  "links": [
    { "title": "标题", "url": "https://..." }
  ]
}`
    const raw = await callKimi(prompt, apiKey)
    const result = JSON.parse(extractJson(raw))
    res.json(result)
  } catch (err) {
    const e = err as Error & { status?: number }
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

/** POST /ai/summary — 深度总结网站 */
router.post('/summary', async (req: AuthRequest, res, next) => {
  try {
    const apiKey = getUserKimiKey(req)
    const { name, url, description } = req.body as { name?: string; url?: string; description?: string }
    if (!name || !url) {
      res.status(400).json({ error: '缺少 name 或 url' })
      return
    }
    const prompt = `网站名称：${name}
网站地址：${url}
网站描述：${description ?? '无'}

请对上述网站做深度分析，严格按以下 JSON 格式返回，不要输出任何其他内容：
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
    const result = JSON.parse(extractJson(raw))
    res.json(result)
  } catch (err) {
    const e = err as Error & { status?: number }
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

export default router
