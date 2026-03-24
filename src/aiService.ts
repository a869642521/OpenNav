const KIMI_API_URL = 'https://api.moonshot.cn/v1/chat/completions'
const KIMI_MODEL = 'moonshot-v1-8k'

function getApiKey(): string {
  return (import.meta.env.VITE_KIMI_API_KEY as string) ?? ''
}

async function callKimi(prompt: string): Promise<string> {
  const apiKey = getApiKey()
  if (!apiKey) {
    throw new Error('未配置 VITE_KIMI_API_KEY，请在 .env 文件中填写 Kimi API Key')
  }

  const res = await fetch(KIMI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: KIMI_MODEL,
      messages: [
        {
          role: 'system',
          content:
            '你是一个专业的网站导航助手。请严格按照用户要求的 JSON 格式返回内容，不要包含任何 Markdown 代码块或额外说明文字，只输出纯 JSON。',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Kimi API 请求失败（${res.status}）：${err}`)
  }

  const data = await res.json()
  const content: string = data?.choices?.[0]?.message?.content ?? ''
  if (!content) throw new Error('Kimi 返回了空内容')
  return content
}

function extractJson(raw: string): string {
  // 去除 markdown 代码块包裹（如 ```json ... ```）
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (match) return match[1].trim()
  return raw.trim()
}

export interface AiSimilarSite {
  name: string
  url: string
  reason: string
}

export interface AiResourceResult {
  summary: string
  links: { title: string; url: string }[]
}

export async function findSimilarSites(
  siteName: string,
  siteUrl: string,
  siteDescription: string
): Promise<AiSimilarSite[]> {
  const prompt = `网站名称：${siteName}
网站地址：${siteUrl}
网站描述：${siteDescription || '无'}

请分析上述网站的类型和定位，然后推荐 5 个同类型的优质网站。
要求：
1. 推荐真实存在、可访问的知名网站
2. 每个网站给出一句话推荐理由
3. 严格按以下 JSON 数组格式返回，不要输出其他内容：
[
  { "name": "网站名", "url": "https://...", "reason": "推荐理由" },
  ...
]`

  const raw = await callKimi(prompt)
  try {
    const parsed = JSON.parse(extractJson(raw)) as AiSimilarSite[]
    if (!Array.isArray(parsed)) throw new Error('返回格式错误')
    return parsed.slice(0, 5).map(item => ({
      name: String(item.name ?? ''),
      url: String(item.url ?? ''),
      reason: String(item.reason ?? ''),
    }))
  } catch {
    throw new Error('AI 返回的数据格式无法解析，请重试')
  }
}

export async function findSiteResources(
  siteName: string,
  siteUrl: string,
  siteDescription: string
): Promise<AiResourceResult> {
  const prompt = `网站名称：${siteName}
网站地址：${siteUrl}
网站描述：${siteDescription || '无'}

请为这个网站提供以下内容：
1. 一段简短的工具/网站介绍（50 字以内）
2. 5 条关于该网站的优质使用教程、官方文档或相关文章链接（真实可访问）

严格按以下 JSON 格式返回，不要输出其他内容：
{
  "summary": "简介文字",
  "links": [
    { "title": "标题", "url": "https://..." },
    ...
  ]
}`

  const raw = await callKimi(prompt)
  try {
    const parsed = JSON.parse(extractJson(raw)) as AiResourceResult
    if (!parsed.summary || !Array.isArray(parsed.links)) throw new Error('返回格式错误')
    return {
      summary: String(parsed.summary ?? ''),
      links: parsed.links.slice(0, 5).map(l => ({
        title: String(l.title ?? ''),
        url: String(l.url ?? ''),
      })),
    }
  } catch {
    throw new Error('AI 返回的数据格式无法解析，请重试')
  }
}
