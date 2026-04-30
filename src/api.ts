// ==================== API 客户端 ====================
// 封装对后端 REST API 的所有调用，统一附带 JWT。
// 扩展友好：新功能优先走本文件；API 根地址仅用 VITE_API_URL；鉴权用 Bearer。
// 若日后 Chrome 扩展等无法使用 localStorage，可将 getToken 抽成可注入实现，避免复制 fetch 逻辑。

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3001'

function getToken(): string | null {
  return localStorage.getItem('myNavToken')
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  let res: Response
  try {
    res = await fetch(`${BASE_URL}${path}`, { ...options, headers })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg === 'Failed to fetch' || msg.includes('NetworkError') || msg.includes('Load failed')) {
      throw new Error(
        `无法连接后端（${BASE_URL}）。请确认：1）已在 backend 目录执行 npm run dev；2）端口与 VITE_API_URL 一致；3）QQ 等登录回调需在 backend 的 FRONTEND_URL 与浏览器地址一致。`
      )
    }
    throw e
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

// ==================== 类型（与后端对应） ====================

export interface ApiSite {
  id: string
  favicon: string
  name: string
  url: string
  category: string
  tags: string[]
  notes: string
  description: string
  isFollowed: boolean
  isFavorite: boolean
  views: number
  likes: number
  createdAt: string
  lastOpenedAt?: string
  sortOrder: number
}

export interface ApiCategory {
  id: string
  name: string
  sort_order: number
}

export interface ApiUser {
  id: string
  email: string
  name: string
  avatar?: string
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

export interface LibraryLink {
  title: string
  url: string
  source: 'ai' | 'manual' | 'search'
  addedAt: string
  note?: string
  description?: string
  searchRank?: number
}

export interface SiteLearningLibrary {
  version: 1
  summary: string
  links: LibraryLink[]
}

export interface BraveSearchItem {
  title: string
  url: string
  description: string
}

export interface AiSummaryResult {
  overview: string
  architecture: string
  features: string[]
  visual: {
    style: string
    colors: string[]
    layout: string
    typography: string
    components: string[]
  }
  tech: string[]
  skills: string[]
}

// ==================== Auth ====================

export async function apiRegisterEmail(
  email: string,
  password: string,
  name?: string
): Promise<{ token: string; user: ApiUser }> {
  return request('/auth/email/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, name }),
  })
}

export async function apiLoginEmail(
  email: string,
  password: string
): Promise<{ token: string; user: ApiUser }> {
  return request('/auth/email/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export async function apiSendEmailOtp(email: string): Promise<{
  ok: boolean
  message?: string
  debugCode?: string
}> {
  return request('/auth/email/otp/send', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export async function apiVerifyEmailOtp(
  email: string,
  code: string
): Promise<{ token: string; user: ApiUser }> {
  return request('/auth/email/otp/verify', {
    method: 'POST',
    body: JSON.stringify({ email, code }),
  })
}

export async function apiExchangeAuthCode(code: string): Promise<{ token: string; user: ApiUser }> {
  return request('/auth/exchange', {
    method: 'POST',
    body: JSON.stringify({ code }),
  })
}

export async function apiGetMe(): Promise<{ user: ApiUser }> {
  return request('/auth/me')
}

// ==================== Sites ====================

export async function apiGetSites(): Promise<ApiSite[]> {
  return request('/sites')
}

export async function apiCreateSite(site: Partial<ApiSite>): Promise<ApiSite> {
  return request('/sites', { method: 'POST', body: JSON.stringify(site) })
}

export async function apiUpdateSite(id: string, patch: Partial<ApiSite>): Promise<ApiSite> {
  return request(`/sites/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

export async function apiDeleteSite(id: string): Promise<void> {
  return request(`/sites/${id}`, { method: 'DELETE' })
}

export async function apiReorderSites(orderedIds: string[]): Promise<void> {
  return request('/sites/reorder', { method: 'PATCH', body: JSON.stringify({ orderedIds }) })
}

// ==================== Categories ====================

export async function apiGetCategories(): Promise<ApiCategory[]> {
  return request('/categories')
}

export async function apiCreateCategory(name: string): Promise<ApiCategory> {
  return request('/categories', { method: 'POST', body: JSON.stringify({ name }) })
}

export async function apiDeleteCategory(id: string): Promise<void> {
  return request(`/categories/${id}`, { method: 'DELETE' })
}

// ==================== Settings ====================

export async function apiUpdateKimiKey(key: string): Promise<void> {
  return request('/settings/kimi-key', {
    method: 'PUT',
    body: JSON.stringify({ key }),
  })
}

export async function apiGetKimiKeyStatus(): Promise<{ configured: boolean }> {
  return request('/settings/kimi-key-status')
}

export async function apiUpdateBraveKey(key: string): Promise<void> {
  return request('/settings/brave-key', {
    method: 'PUT',
    body: JSON.stringify({ key }),
  })
}

export async function apiGetBraveKeyStatus(): Promise<{ configured: boolean }> {
  return request('/settings/brave-key-status')
}

// ==================== AI ====================

export async function apiAiSimilar(
  name: string,
  url: string,
  description: string,
  options?: { signal?: AbortSignal; lang?: string }
): Promise<AiSimilarSite[]> {
  return request('/ai/similar', {
    method: 'POST',
    body: JSON.stringify({ name, url, description, lang: options?.lang }),
    signal: options?.signal,
  })
}

export async function apiAiResources(
  name: string,
  url: string,
  description: string,
  options?: { signal?: AbortSignal; lang?: string }
): Promise<AiResourceResult> {
  return request('/ai/resources', {
    method: 'POST',
    body: JSON.stringify({ name, url, description, lang: options?.lang }),
    signal: options?.signal,
  })
}

export async function apiAiSummary(
  name: string,
  url: string,
  description: string,
  options?: { signal?: AbortSignal; lang?: string }
): Promise<AiSummaryResult> {
  return request('/ai/summary', {
    method: 'POST',
    body: JSON.stringify({ name, url, description, lang: options?.lang }),
    signal: options?.signal,
  })
}

export async function apiLibrarySearch(
  query: string,
  options?: { signal?: AbortSignal; lang?: 'zh' | 'en'; siteName?: string }
): Promise<BraveSearchItem[]> {
  return request('/ai/library-search', {
    method: 'POST',
    body: JSON.stringify({ query, lang: options?.lang, siteName: options?.siteName }),
    signal: options?.signal,
  })
}
