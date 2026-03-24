// ==================== API 客户端 ====================
// 封装对后端 REST API 的所有调用，统一附带 JWT

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

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers })
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

export async function apiGoogleLogin(credential: string): Promise<{ token: string; user: ApiUser }> {
  return request('/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential }),
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

// ==================== AI ====================

export async function apiAiSimilar(
  name: string, url: string, description: string
): Promise<AiSimilarSite[]> {
  return request('/ai/similar', {
    method: 'POST',
    body: JSON.stringify({ name, url, description }),
  })
}

export async function apiAiResources(
  name: string, url: string, description: string
): Promise<AiResourceResult> {
  return request('/ai/resources', {
    method: 'POST',
    body: JSON.stringify({ name, url, description }),
  })
}

export async function apiAiSummary(
  name: string, url: string, description: string
): Promise<AiSummaryResult> {
  return request('/ai/summary', {
    method: 'POST',
    body: JSON.stringify({ name, url, description }),
  })
}
