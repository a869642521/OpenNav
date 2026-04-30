import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  forwardRef,
  type ReactNode,
  type SyntheticEvent,
} from 'react'
import './App.css'
import {
  type AiSimilarSite,
  type SiteLearningLibrary,
  type LibraryLink,
  type BraveSearchItem,
  type AiSummaryResult,
  apiSendEmailOtp,
  apiVerifyEmailOtp,
  apiExchangeAuthCode,
  apiGetSites,
  apiCreateSite,
  apiUpdateSite,
  apiDeleteSite,
  apiReorderSites,
  apiGetCategories,
  apiCreateCategory,
  apiDeleteCategory,
  apiAiSimilar,
  apiAiResources,
  apiAiSummary,
  apiLibrarySearch,
  apiUpdateKimiKey,
  apiGetKimiKeyStatus,
  apiUpdateBraveKey,
  apiGetBraveKeyStatus,
  type ApiSite,
} from './api'

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3001'

/** 判断是否已配置后端（存有 token） */
const hasBackend = () => Boolean(localStorage.getItem('myNavToken'))

/** 与 buildSummaryMarkdown 首行一致，用于判断备注中是否已有 AI 总结块 */
function aiSummaryNotesMarker(siteName: string): string {
  return `# ${siteName} — AI 深度总结`
}

/** 与保存到备注的首行一致，用于判断是否已保存 AI 资料块 */
function aiResourceNotesMarker(siteName: string): string {
  return `【AI 资料】${siteName}`
}

const AI_LOADING_TAB_LABEL: Record<'similar' | 'resource' | 'summary', string> = {
  similar: '同类网站',
  resource: '学习库',
  summary: '产品总结',
}

/** 缓存或旧版接口可能缺少字段，避免 .map 抛错导致整页白屏 */
function normalizeAiSummaryForDisplay(raw: AiSummaryResult) {
  const vRaw = raw.visual
  const v =
    vRaw != null && typeof vRaw === 'object'
      ? (vRaw as Record<string, unknown>)
      : null
  const str = (x: unknown) => (typeof x === 'string' ? x : String(x ?? ''))
  return {
    overview: str(raw.overview),
    architecture: str(raw.architecture),
    features: Array.isArray(raw.features) ? raw.features.map(String) : [],
    tech: Array.isArray(raw.tech) ? raw.tech.map(String) : [],
    skills: Array.isArray(raw.skills) ? raw.skills.map(String) : [],
    visual: {
      style: v ? str(v.style) : '',
      typography: v ? str(v.typography) : '',
      layout: v ? str(v.layout) : '',
      colors: v && Array.isArray(v.colors) ? v.colors.map(String) : [],
      components: v && Array.isArray(v.components) ? v.components.map(String) : [],
    },
  }
}

// ==================== 类型定义 ====================
interface Site {
  id: string
  favicon: string
  name: string
  url: string
  category: string
  tags: string[]
  notes: string
  description?: string
  /** 网站关注状态：已关注 / 未关注 */
  isFollowed: boolean
  createdAt: string
  lastOpenedAt?: string
  isFavorite?: boolean
  views?: number
  likes?: number
  /** 列表顺序（与后端 sort_order 一致，导出/导入用于还原排序） */
  sortOrder?: number
  /** 正在从同类推荐等处写入导航，尚未完成元数据/同步；不入本地持久化 */
  pending?: boolean
}

interface Category {
  id: string
  name: string
}

interface User {
  id: string
  email: string
  name: string
  avatar?: string
}

/** 侧栏 AI 区当前标签：同类网站 / 资讯资料 / 产品总结（代码内仍为 more / summary） */
type AiPanelTab = 'more' | 'resource' | 'summary'

function aiLoadingKindToPanelTab(k: 'similar' | 'resource' | 'summary'): AiPanelTab {
  return k === 'similar' ? 'more' : k
}

const AI_TAB_ORDER: AiPanelTab[] = ['more', 'resource', 'summary']

function aiTabButtonId(t: AiPanelTab): string {
  if (t === 'more') return 'ai-tab-more'
  if (t === 'resource') return 'ai-tab-resource'
  return 'ai-tab-summary'
}

/** 「更多」同类卡片：加入导航按钮内图标（加号 / 加载旋转 / 已添加绿色勾） */
function AiSimilarNavAddIcons({ alreadyAdded, isAdding }: { alreadyAdded: boolean; isAdding: boolean }) {
  if (alreadyAdded) {
    return (
      <svg className="ai-similar-add-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M20 6L9 17l-5-5"/>
      </svg>
    )
  }
  if (isAdding) {
    return (
      <svg className="ai-similar-add-btn-icon ai-similar-add-btn-icon--spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
      </svg>
    )
  }
  return (
    <svg className="ai-similar-add-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14"/>
    </svg>
  )
}

/** 同类网站「刷新中」：进度条 + 骨架行（行数与当前列表项一致，高度与列表区域对齐） */
function AiSimilarRefreshOverlay({
  embedded,
  rowCount,
}: {
  embedded?: boolean
  /** 与当前展示的卡片条数一致，遮罩高度与列表统一 */
  rowCount: number
}) {
  const n = Math.min(Math.max(rowCount, 1), 10)
  return (
    <div
      className={`ai-similar-refresh-overlay${embedded ? ' ai-similar-refresh-overlay--embedded' : ''}`}
      aria-label="正在更新推荐"
      role="status"
    >
      <div className="ai-similar-refresh-bar" />
      <div className="ai-similar-refresh-rows">
        {Array.from({ length: n }, (_, i) => (
          <div key={i} className="ai-similar-refresh-row">
            <div
              className="ai-skeleton"
              style={{
                width: embedded ? 22 : 28,
                height: embedded ? 22 : 28,
                borderRadius: embedded ? 5 : 6,
                flexShrink: 0,
              }}
            />
            <div className="ai-skeleton-lines" style={{ flex: 1, minWidth: 0 }}>
              <div className="ai-skeleton ai-skeleton-line-long" />
              <div className="ai-skeleton ai-skeleton-line-short" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 同类网站：空闲为「搜索更多」内容，加载中同一按钮变为暂停并可取消请求 */
function AiSimilarSearchOrPauseButton({
  busy,
  userOk,
  kimiOk,
  aiLoading,
  onRun,
  onPause,
  className,
  idleContent,
  titleRun,
  titlePause,
  ariaRun,
  ariaPause,
}: {
  busy: boolean
  userOk: boolean
  kimiOk: boolean
  aiLoading: 'similar' | 'resource' | 'summary' | null
  onRun: () => void
  onPause: () => void
  className: string
  idleContent: ReactNode
  titleRun: string
  titlePause: string
  ariaRun: string
  ariaPause: string
}) {
  const blockedByOther = aiLoading !== null && aiLoading !== 'similar'
  const disabled = !userOk || !kimiOk || blockedByOther
  return (
    <button
      type="button"
      className={`${className}${busy ? ' is-similar-pause-mode' : ''}`}
      disabled={disabled}
      onClick={() => (busy ? onPause() : void onRun())}
      title={!userOk ? '请先登录' : !kimiOk ? '请在「设置」中配置 Kimi API Key' : busy ? titlePause : titleRun}
      aria-label={!userOk ? '请先登录' : !kimiOk ? '请在设置中配置 Kimi API Key' : busy ? ariaPause : ariaRun}
    >
      {busy ? (
        <>
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="ai-saved-search-more-btn-icon ai-similar-pause-icon">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
          <span className="ai-saved-search-more-btn-text">暂停</span>
        </>
      ) : (
        idleContent
      )}
    </button>
  )
}

/** 各站点 AI 深度总结缓存（刷新/切换页面后仍在「总结」标签恢复） */
const AI_SUMMARY_CACHE_KEY = 'myNavAiSummaries'

function readAiSummaryCache(): Record<string, AiSummaryResult> {
  try {
    const raw = localStorage.getItem(AI_SUMMARY_CACHE_KEY)
    if (!raw) return {}
    const p = JSON.parse(raw) as unknown
    if (!p || typeof p !== 'object') return {}
    return p as Record<string, AiSummaryResult>
  } catch {
    return {}
  }
}

function writeAiSummaryCache(map: Record<string, AiSummaryResult>) {
  try {
    localStorage.setItem(AI_SUMMARY_CACHE_KEY, JSON.stringify(map))
  } catch {
    /* ignore quota */
  }
}

/** 各站点 AI 资讯资料 / 学习库缓存（与总结一致，切换站点/刷新后可恢复） */
const AI_RESOURCE_CACHE_KEY = 'myNavAiResources'

/** 标准化 URL 用于学习库去重（去 www、去末尾斜线、小写） */
function normalizeLibraryUrl(url: string): string {
  try {
    const cleaned = url.trim().startsWith('http') ? url.trim() : 'https://' + url.trim()
    const u = new URL(cleaned)
    return (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '')).toLowerCase()
  } catch {
    return url.toLowerCase().trim()
  }
}

/** 仅主机名（去 www），用于同一站点多条 AI 链接合并（如豆包首页与 /chat） */
function hostnameForSiteDedupe(url: string): string {
  try {
    const cleaned = url.trim().startsWith('http') ? url.trim() : 'https://' + url.trim()
    return new URL(cleaned).hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 学习库：同一主机名下若存在 AI 链接，只保留一条（优先 manual > search > ai）。
 * 若该主机下全是手动/搜索链接，不合并（允许多条如 GitHub 不同仓库）。
 */
function dedupeLibraryLinksByHostname(links: LibraryLink[]): LibraryLink[] {
  const rank = (s: LibraryLink['source']) => (s === 'manual' ? 0 : s === 'search' ? 1 : 2)
  const byHost = new Map<string, LibraryLink[]>()
  for (const l of links) {
    const h = hostnameForSiteDedupe(l.url)
    if (!h) continue
    if (!byHost.has(h)) byHost.set(h, [])
    byHost.get(h)!.push(l)
  }
  const winnerByHost = new Map<string, LibraryLink>()
  for (const [h, arr] of byHost) {
    if (!arr.some((x) => x.source === 'ai')) continue
    winnerByHost.set(
      h,
      [...arr].sort((a, b) => rank(a.source) - rank(b.source))[0]
    )
  }
  const usedWinner = new Set<string>()
  const out: LibraryLink[] = []
  for (const l of links) {
    const h = hostnameForSiteDedupe(l.url)
    if (!h) {
      out.push(l)
      continue
    }
    const w = winnerByHost.get(h)
    if (w !== undefined) {
      if (usedWinner.has(h)) continue
      usedWinner.add(h)
      out.push(w)
    } else {
      out.push(l)
    }
  }
  return out
}

function readAiResourceCache(): Record<string, SiteLearningLibrary> {
  try {
    const raw = localStorage.getItem(AI_RESOURCE_CACHE_KEY)
    if (!raw) return {}
    const p = JSON.parse(raw) as unknown
    if (!p || typeof p !== 'object') return {}
    const map = p as Record<string, unknown>
    const fallbackDate = new Date().toISOString()
    const result: Record<string, SiteLearningLibrary> = {}
    for (const [siteId, value] of Object.entries(map)) {
      if (!value || typeof value !== 'object') continue
      const v = value as Record<string, unknown>
      if (v.version === 1) {
        const lib = v as unknown as SiteLearningLibrary
        const links = Array.isArray(lib.links) ? dedupeLibraryLinksByHostname(lib.links) : []
        result[siteId] = { ...lib, links }
      } else {
        // 迁移旧格式 AiResourceResult → SiteLearningLibrary
        const rawLinks = (Array.isArray(v.links) ? v.links : []) as { title?: string; url?: string }[]
        result[siteId] = {
          version: 1,
          summary: typeof v.summary === 'string' ? v.summary : '',
          links: dedupeLibraryLinksByHostname(
            rawLinks.map(l => ({
              title: l.title ?? '',
              url: l.url ?? '',
              source: 'ai' as const,
              addedAt: fallbackDate,
            }))
          ),
        }
      }
    }
    return result
  } catch {
    return {}
  }
}

function writeAiResourceCache(map: Record<string, SiteLearningLibrary>) {
  try {
    localStorage.setItem(AI_RESOURCE_CACHE_KEY, JSON.stringify(map))
  } catch {
    /* ignore quota */
  }
}

/** 各站点「更多」标签已保存的同类网站（刷新后可恢复） */
const AI_SIMILAR_CACHE_KEY = 'myNavAiSimilar'

function readAiSimilarCache(): Record<string, AiSimilarSite[]> {
  try {
    const raw = localStorage.getItem(AI_SIMILAR_CACHE_KEY)
    if (!raw) return {}
    const p = JSON.parse(raw) as unknown
    if (!p || typeof p !== 'object') return {}
    const map = p as Record<string, unknown>
    const out: Record<string, AiSimilarSite[]> = {}
    for (const [siteId, value] of Object.entries(map)) {
      if (!Array.isArray(value)) continue
      const seen = new Set<string>()
      const arr: AiSimilarSite[] = []
      for (const item of value) {
        if (!item || typeof item !== 'object') continue
        const s = item as AiSimilarSite
        const k = normalizeSimilarSiteUrlForDedupe(s.url)
        if (!k || seen.has(k)) continue
        seen.add(k)
        arr.push(s)
      }
      out[siteId] = arr
    }
    return out
  } catch {
    return {}
  }
}

function writeAiSimilarCache(map: Record<string, AiSimilarSite[]>) {
  try {
    localStorage.setItem(AI_SIMILAR_CACHE_KEY, JSON.stringify(map))
  } catch {
    /* ignore quota */
  }
}

/** 与 AI 同类条目的 url 字段对齐为可访问地址（补全协议） */
function resolveSimilarSiteUrl(raw: string): string {
  const t = String(raw ?? '').trim()
  if (!t) return ''
  return t.startsWith('http://') || t.startsWith('https://') ? t : `https://${t}`
}

/**
 * 同类网站去重键：仅注册级主机名（去 www），同一站点多条落地页（如 doubao.com/ 与 /chat）视为一条。
 * 导航里已收藏的任意路径命中该主机名时，整站不再作为「新推荐」出现。
 */
function normalizeSimilarSiteUrlForDedupe(raw: string): string {
  const t = String(raw ?? '').trim()
  if (!t) return ''
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

/** 排除导航中已有的 URL 后与候选列表内去重 */
function filterAiSimilarExcludeInNav(navSites: Site[], candidates: AiSimilarSite[]): AiSimilarSite[] {
  const inNav = new Set<string>()
  for (const s of navSites) {
    const k = normalizeSimilarSiteUrlForDedupe(s.url)
    if (k) inNav.add(k)
  }
  const out: AiSimilarSite[] = []
  const seen = new Set<string>()
  for (const c of candidates) {
    const k = normalizeSimilarSiteUrlForDedupe(c.url)
    if (!k || inNav.has(k) || seen.has(k)) continue
    seen.add(k)
    out.push(c)
  }
  return out
}

const BUILTIN_CATEGORIES: Category[] = [
  { id: 'all', name: '全部' },
  { id: 'favorites', name: '收藏' },
  { id: 'ungrouped', name: '未分组' },
]

const BUILTIN_CATEGORY_IDS = new Set(BUILTIN_CATEGORIES.map((c) => c.id))

/** 与 loadFromLocalStorage 一致的解析，供登录后迁移（不写入 React state） */
/** 规范站点标签：去空、去重（忽略大小写），支持数组或逗号/顿号分隔的字符串 */
function normalizeSiteTags(raw: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (s: string) => {
    const t = s.trim()
    if (!t) return
    const key = t.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(t)
  }
  if (Array.isArray(raw)) {
    for (const x of raw) {
      if (typeof x === 'string') push(x)
    }
    return out
  }
  if (typeof raw === 'string') {
    for (const part of raw.split(/[,，;；\n]+/)) push(part)
    return out
  }
  return out
}

/** 分组列表按 id 去重，保留首次出现顺序（防止 localStorage / 状态异常堆叠） */
function dedupeCategoriesById(cats: Category[]): Category[] {
  const seen = new Set<string>()
  const out: Category[] = []
  for (const c of cats) {
    if (!c?.id || seen.has(c.id)) continue
    seen.add(c.id)
    out.push(c)
  }
  return out
}

function parseLocalStorageBookmarksForSync(): { categories: Category[]; sites: Site[] } {
  const savedCats = localStorage.getItem('myNavCategories')
  let validCategories = BUILTIN_CATEGORIES
  if (savedCats) {
    try {
      const parsed = JSON.parse(savedCats) as Category[]
      validCategories = dedupeCategoriesById([
        ...BUILTIN_CATEGORIES,
        ...parsed.filter((c: Category) => c.id.startsWith('cat_')),
      ])
    } catch {
      /* ignore */
    }
  }
  const validIds = new Set(validCategories.map((c: Category) => c.id))
  const savedSites = localStorage.getItem('myNavSites')
  let sites: Site[] = []
  if (savedSites) {
    try {
      const parsed = JSON.parse(savedSites) as Record<string, unknown>[]
      sites = parsed.map((item) => {
        const status = item.status as string | undefined
        const isFollowed =
          typeof item.isFollowed === 'boolean'
            ? item.isFollowed
            : status === 'reading' || status === 'mastered'
        const viewsRaw = item.views
        const likesRaw = item.likes
        const next = {
          ...item,
          category: validIds.has(String(item.category)) ? String(item.category) : 'ungrouped',
          views: typeof viewsRaw === 'number' && Number.isFinite(viewsRaw) ? viewsRaw : 0,
          likes: typeof likesRaw === 'number' && Number.isFinite(likesRaw) ? likesRaw : 0,
          isFollowed,
        } as Record<string, unknown>
        delete next.status
        const site = next as unknown as Site
        site.tags = normalizeSiteTags((next as { tags?: unknown }).tags)
        return site
      })
    } catch {
      sites = []
    }
  }
  return { categories: validCategories, sites }
}

function normalizeImportedCustomCategories(cats: unknown): Category[] {
  if (!Array.isArray(cats)) return []
  const out: Category[] = []
  const seen = new Set<string>()
  for (const c of cats) {
    if (!c || typeof c !== 'object') continue
    const o = c as { id?: unknown; name?: unknown }
    const id = typeof o.id === 'string' ? o.id : ''
    const name = typeof o.name === 'string' ? o.name.trim() : ''
    if (!id.startsWith('cat_') || !name || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name })
  }
  return out
}

function normalizeImportedSites(items: unknown, validCatIds: Set<string>): Site[] {
  if (!Array.isArray(items)) return []
  const out: Site[] = []
  items.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return
    const s = raw as Record<string, unknown>
    const url = String(s.url ?? '').trim()
    if (!url) return
    const name = String(s.name ?? '').trim() || url
    const catRaw = typeof s.category === 'string' ? s.category : 'ungrouped'
    const category = validCatIds.has(catRaw) ? catRaw : 'ungrouped'
    const tags = normalizeSiteTags(s.tags)
    const id =
      typeof s.id === 'string' && s.id.trim()
        ? s.id.trim()
        : `site_import_${Date.now()}_${i}`
    const sortOrder =
      typeof s.sortOrder === 'number' && Number.isFinite(s.sortOrder) ? s.sortOrder : out.length
    out.push({
      id,
      favicon: typeof s.favicon === 'string' ? s.favicon : '',
      name,
      url,
      category,
      tags,
      notes: typeof s.notes === 'string' ? s.notes : '',
      description: typeof s.description === 'string' ? s.description : '',
      isFollowed:
        typeof s.isFollowed === 'boolean'
          ? s.isFollowed
          : s.isFollowed === 1 || s.isFollowed === '1' || s.isFollowed === 'true',
      isFavorite:
        typeof s.isFavorite === 'boolean'
          ? s.isFavorite
          : s.isFavorite === 1 || s.isFavorite === '1' || s.isFavorite === 'true',
      createdAt: typeof s.createdAt === 'string' ? s.createdAt : new Date().toISOString(),
      lastOpenedAt: typeof s.lastOpenedAt === 'string' ? s.lastOpenedAt : undefined,
      views: typeof s.views === 'number' && Number.isFinite(s.views) ? s.views : 0,
      likes: typeof s.likes === 'number' && Number.isFinite(s.likes) ? s.likes : 0,
      sortOrder,
    })
  })
  out.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
  return out
}

// ==================== 工具函数 ====================
/**
 * `<a download="...">` 在 Firefox 等环境按 ByteString 处理，码点 &gt; 255（中文、全角「。」等）会抛错。
 * 仅保留 ASCII 文件名；全非 ASCII 时用 fallback。
 */
function latin1SafeDownloadBasename(raw: string, fallback: string): string {
  const noFs = raw.replace(/[/\\:*?"<>|]/g, '_').trim()
  const ascii = noFs
    .replace(/[^\x20-\x7E]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
  const base = (ascii || fallback).slice(0, 120)
  return base || fallback
}

/** Kimi Key 必须为 ASCII；含中文/全角「。」等会导致请求头 ByteString 报错（点 AI 时触发） */
function isKimiApiKeyAsciiOnly(key: string): boolean {
  for (let i = 0; i < key.length; i++) {
    if (key.charCodeAt(i) > 127) return false
  }
  return true
}

const isValidUrl = (str: string): boolean => {
  const s = str.trim()
  if (!s || !s.includes('.')) return false
  try {
    const url = s.startsWith('http://') || s.startsWith('https://') ? s : 'https://' + s
    const parsed = new URL(url)
    return parsed.hostname.includes('.')
  } catch {
    return false
  }
}

/** Microlink 返回的 logo 常托管在第三方域，浏览器里易裂图；仅在与站点同域（含子域）时才采用 */
function pickFaviconFromMicrolink(pageHostname: string, micLogoUrl: string | undefined, googleFaviconUrl: string): string {
  const raw = typeof micLogoUrl === 'string' ? micLogoUrl.trim() : ''
  if (!raw || !/^https?:\/\//i.test(raw)) return googleFaviconUrl
  try {
    const logoHost = new URL(raw).hostname.toLowerCase().replace(/^www\./i, '')
    const pageHost = pageHostname.toLowerCase().replace(/^www\./i, '')
    const sameSite =
      logoHost === pageHost ||
      logoHost.endsWith('.' + pageHost) ||
      pageHost.endsWith('.' + logoHost)
    return sameSite ? raw : googleFaviconUrl
  } catch {
    return googleFaviconUrl
  }
}

// 通过 Microlink API 获取网站元数据（标题、简介、图标）
const fetchSiteInfo = async (url: string): Promise<{ name: string; favicon: string; description: string } | null> => {
  try {
    const res = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}`)
    const data = await res.json()
    const payload = data?.data
    const domain = new URL(url).hostname
    const googleFav = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`
    const fallbackName = domain.replace(/^www\./, '').split('.')[0]
    const name = payload?.title?.trim() || (fallbackName.charAt(0).toUpperCase() + fallbackName.slice(1))
    const favicon = pickFaviconFromMicrolink(domain, payload?.logo?.url, googleFav)
    const description = typeof payload?.description === 'string' ? payload.description.trim() : ''
    return { name, favicon, description }
  } catch {
    try {
      const urlObj = new URL(url)
      const domain = urlObj.hostname
      let name = domain.replace(/^www\./, '').split('.')[0]
      name = name.charAt(0).toUpperCase() + name.slice(1)
      const favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`
      return { name, favicon, description: '' }
    } catch {
      return null
    }
  }
}

/** 路径段常见英文 slug → 中文（深链收藏时拼在标题后，便于同站多入口区分） */
const DEEP_LINK_SEGMENT_ZH: Record<string, string> = {
  chat: '对话',
  'create-image': 'AI创作',
  create_image: 'AI创作',
  create: '创作',
  image: '图像',
  write: '写作',
  docs: '文档',
  document: '文档',
  help: '帮助',
  settings: '设置',
  login: '登录',
  pricing: '定价',
  download: '下载',
  product: '产品',
  features: '功能',
}

function isOpaquePathSegment(seg: string): boolean {
  const s = decodeURIComponent(seg).trim()
  if (s.length < 4) return false
  if (/^[a-f0-9-]{24,}$/i.test(s)) return true
  if (/^\d{12,}$/.test(s)) return true
  return false
}

/**
 * 从 URL 路径取短标签（仅深链；根路径返回空）。zh 时优先查表，否则对拉丁 slug 做简单格式化。
 */
function getDeepLinkDisplaySuffix(url: string, lang: 'zh' | 'en'): string {
  try {
    const u = new URL(url.startsWith('http://') || url.startsWith('https://') ? url : `https://${url}`)
    const parts = u.pathname.split('/').map((p) => p.trim()).filter(Boolean)
    if (parts.length === 0) return ''
    let segs = [...parts]
    while (segs.length > 0 && isOpaquePathSegment(segs[segs.length - 1]!)) {
      segs.pop()
    }
    if (segs.length === 0) return ''
    const raw = decodeURIComponent(segs[segs.length - 1]!)
    const keyNorm = raw.toLowerCase().replace(/_/g, '-')
    if (lang === 'zh') {
      const mapped = DEEP_LINK_SEGMENT_ZH[keyNorm] ?? DEEP_LINK_SEGMENT_ZH[raw.toLowerCase()]
      if (mapped) return mapped
    }
    const human = raw.replace(/[-_]+/g, ' ').trim()
    if (!human) return ''
    if (lang === 'en') {
      return human.replace(/\b[a-z]/g, (c) => c.toUpperCase())
    }
    if (/[\u4e00-\u9fff]/.test(human)) return human
    return human.replace(/\b[a-z]/g, (c) => c.toUpperCase())
  } catch {
    return ''
  }
}

/** 在抓取到的站点名后追加路径提示，避免同站多条深链标题雷同 */
function augmentSiteNameWithDeepLink(baseName: string, url: string, lang: 'zh' | 'en'): string {
  const bn = baseName.trim()
  const suffix = getDeepLinkDisplaySuffix(url, lang)
  if (!suffix || !bn) return bn || baseName
  const sl = suffix.toLowerCase()
  const low = bn.toLowerCase()
  if (low === sl) return bn
  if (low.endsWith(sl)) return bn
  if (low.includes(` ${sl}`) || low.includes(`·${sl}`) || low.includes(`-${sl}`)) return bn
  const tokens = low.split(/[\s·\-–—,.，。/]+/).filter(Boolean)
  if (tokens.some((t) => t === sl)) return bn
  return `${bn} ${suffix}`
}

const SITE_FAVICON_BROKEN_PLACEHOLDER =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect fill="#e8eaed" width="64" height="64" rx="14"/><circle cx="32" cy="28" r="10" fill="none" stroke="#bdc1c6" stroke-width="2.5"/><path fill="#bdc1c6" d="M20 46c3-6 8-9 12-9s9 3 12 9" stroke="#bdc1c6" stroke-width="2" stroke-linecap="round"/></svg>'
  )

/** favicon 裂图时：Google s2 → DuckDuckGo ico → 占位（侧栏原无 onError，Microlink 外链常失效） */
function onSiteFaviconImgError(e: SyntheticEvent<HTMLImageElement>, siteUrl: string) {
  const el = e.currentTarget
  let googleIco = ''
  let ddg = ''
  try {
    const u = new URL(siteUrl.startsWith('http://') || siteUrl.startsWith('https://') ? siteUrl : `https://${siteUrl}`)
    const host = u.hostname
    googleIco = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`
    ddg = `https://icons.duckduckgo.com/ip3/${host}.ico`
  } catch {
    el.onerror = null
    el.src = SITE_FAVICON_BROKEN_PLACEHOLDER
    return
  }

  let phase = el.dataset.faviconFb ?? '0'
  if (phase === '0') {
    el.dataset.faviconFb = '1'
    if (el.src !== googleIco) {
      el.src = googleIco
      return
    }
    phase = '1'
  }
  if (phase === '1') {
    el.dataset.faviconFb = '2'
    if (el.src !== ddg) {
      el.src = ddg
      return
    }
  }
  el.onerror = null
  el.removeAttribute('data-favicon-fb')
  el.src = SITE_FAVICON_BROKEN_PLACEHOLDER
}

type PanelCategorySelectProps = {
  options: Category[]
  value: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (catId: string) => void
}

const PanelCategorySelect = forwardRef<HTMLDivElement, PanelCategorySelectProps>(
  function PanelCategorySelect({ options, value, open, onOpenChange, onChange }, ref) {
    const current = options.find(c => c.id === value)
    const display = current?.name ?? '未分组'

    return (
      <div
        ref={ref}
        className={`panel-select-wrap panel-category-dropdown${open ? ' is-open' : ''}`}
      >
        <button
          type="button"
          className="panel-select-trigger"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-labelledby="panel-category-label"
          onClick={() => onOpenChange(!open)}
        >
          <span className="panel-select-value">{display}</span>
        </button>
        {open && (
          <div className="panel-select-listbox" role="listbox" aria-labelledby="panel-category-label">
            <div className="panel-select-listbox-scroll">
              {options.map(c => (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={value === c.id}
                  className={`panel-select-option${value === c.id ? ' is-selected' : ''}`}
                  onClick={() => {
                    onChange(c.id)
                    onOpenChange(false)
                  }}
                >
                  {c.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }
)

function App() {
  const [sites, setSites] = useState<Site[]>([])
  const [categories, setCategories] = useState<Category[]>(() => {
    const saved = localStorage.getItem('myNavCategories')
    if (!saved) return BUILTIN_CATEGORIES
    const parsed = JSON.parse(saved) as Category[]
    const custom = parsed.filter((c: Category) => c.id.startsWith('cat_'))
    return dedupeCategoriesById([...BUILTIN_CATEGORIES, ...custom])
  })
  const [currentCategory, setCurrentCategory] = useState('all')
  
  // 用户认证状态
  const [user, setUser] = useState<User | null>(null)
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false)
  const [loginEmail, setLoginEmail] = useState('')
  const [loginTab, setLoginTab] = useState<'email' | 'qq'>('email')
  const [emailOtpStep, setEmailOtpStep] = useState<1 | 2>(1)
  const [loginOtpCode, setLoginOtpCode] = useState('')
  const [emailOtpCooldown, setEmailOtpCooldown] = useState(0)
  const [isLoginLoading, setIsLoginLoading] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [isDataMenuOpen, setIsDataMenuOpen] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const dataMenuRef = useRef<HTMLDivElement>(null)
  const importFileInputRef = useRef<HTMLInputElement>(null)
  
  // 快捷输入栏状态（双模式）
  const [quickInput, setQuickInput] = useState('')
  const [isQuickInputFocused, setIsQuickInputFocused] = useState(false)
  const [isAdding, setIsAdding] = useState(false)
  
  // 右侧面板状态
  const [selectedSite, setSelectedSite] = useState<Site | null>(null)
  const [isPanelOpen, setIsPanelOpen] = useState(false)
  const [confirmDeleteSite, setConfirmDeleteSite] = useState<Site | null>(null)
  /** 总结区点 ×：先弹出确认，再清除本地缓存总结 */
  const [confirmDismissAiSummary, setConfirmDismissAiSummary] = useState(false)
  /** 重新生成：若当前总结未写入备注，询问是否先保存 */
  const [confirmRegenerateSummary, setConfirmRegenerateSummary] = useState(false)
  /** 资讯资料：重新获取时若未保存到备注则询问 */
  const [confirmRegenerateResource, setConfirmRegenerateResource] = useState(false)
  /** 学习库：点击删除时确认 */
  const [confirmDismissAiResources, setConfirmDismissAiResources] = useState(false)
  const [editNotes, setEditNotes] = useState('')

  // 新建分组
  const [showAddCategory, setShowAddCategory] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [isPanelCategoryOpen, setIsPanelCategoryOpen] = useState(false)
  const panelCategoryRef = useRef<HTMLDivElement>(null)

  // AI 智能助手状态（按站点隔离，支持后台并行请求）
  /** 每个站点当前进行中的 AI 任务类型；派生出 aiLoading = 当前选中站点的值 */
  const [aiLoadingBySiteId, setAiLoadingBySiteId] = useState<Record<string, 'similar' | 'resource' | 'summary'>>({})
  const [aiResourcesBySiteId, setAiResourcesBySiteId] = useState<Record<string, SiteLearningLibrary>>(readAiResourceCache)
  /** 当前会话：哪些站点的资讯资料已保存到备注 */
  const [resourceNotesSavedIds, setResourceNotesSavedIds] = useState<Set<string>>(() => new Set())
  // 学习库 UI 状态
  const [showAddLinkForm, setShowAddLinkForm] = useState(false)
  const [newLinkTitle, setNewLinkTitle] = useState('')
  const [newLinkUrl, setNewLinkUrl] = useState('')
  const [newLinkNote, setNewLinkNote] = useState('')
  const [showBraveSearch, setShowBraveSearch] = useState(false)
  const [braveSearchQuery, setBraveSearchQuery] = useState('')
  const [braveSearchResults, setBraveSearchResults] = useState<BraveSearchItem[]>([])
  const [isBraveSearchLoading, setIsBraveSearchLoading] = useState(false)
  const braveSearchAbortRef = useRef<AbortController | null>(null)
  const aiResourceAbortMap = useRef<Map<string, AbortController>>(new Map())
  const aiResourceGenMap = useRef<Map<string, number>>(new Map())
  const [aiPanelTab, setAiPanelTab] = useState<AiPanelTab>('more')
  const [aiSummaryBySiteId, setAiSummaryBySiteId] = useState<Record<string, AiSummaryResult>>(readAiSummaryCache)
  /** 当前会话内：哪些站点的总结已保存到备注（打开面板时按备注中的 Markdown 标题同步） */
  const [summaryNotesSavedIds, setSummaryNotesSavedIds] = useState<Set<string>>(() => new Set())
  const aiSummaryAbortMap = useRef<Map<string, AbortController>>(new Map())
  const aiSummaryGenMap = useRef<Map<string, number>>(new Map())
  const aiSimilarAbortMap = useRef<Map<string, AbortController>>(new Map())
  const aiSimilarGenMap = useRef<Map<string, number>>(new Map())
  /** 「更多」标签：各站点已保存的同类网站列表 */
  const [aiSimilarBySiteId, setAiSimilarBySiteId] = useState<Record<string, AiSimilarSite[]>>(readAiSimilarCache)
  /** 正在单独添加到导航的网站 URL（防止重复点击） */
  const [addingSingleSiteUrl, setAddingSingleSiteUrl] = useState<string | null>(null)

  // ---- per-site AI loading 派生常量 ----
  /** 当前选中站点的 AI 任务类型（null = 无任务） */
  const aiLoading: 'similar' | 'resource' | 'summary' | null =
    selectedSite ? (aiLoadingBySiteId[selectedSite.id] ?? null) : null
  /** 任意站点存在 AI 任务（用于 Wake Lock） */
  const anyAiLoading = Object.keys(aiLoadingBySiteId).length > 0
  /** 当前选中站点的同类推荐（从持久化缓存派生，null = 未搜索过） */
  const aiSimilarSites: AiSimilarSite[] | null =
    selectedSite ? (aiSimilarBySiteId[selectedSite.id] ?? null) : null
  /** 当前选中站点的学习库（从持久化缓存派生） */
  const aiResources: SiteLearningLibrary | null =
    selectedSite ? (aiResourcesBySiteId[selectedSite.id] ?? null) : null
  /** 当前选中站点的 AI 总结（从持久化缓存派生） */
  const aiSummary: AiSummaryResult | null =
    selectedSite ? (aiSummaryBySiteId[selectedSite.id] ?? null) : null
  const aiSummaryDisplay = useMemo(
    () => (aiSummary ? normalizeAiSummaryForDisplay(aiSummary) : null),
    [aiSummary]
  )

  // ---- per-site loading 辅助 ----
  const setAiLoadingForSite = useCallback((siteId: string, type: 'similar' | 'resource' | 'summary') => {
    setAiLoadingBySiteId(prev => ({ ...prev, [siteId]: type }))
  }, [])

  const clearAiLoadingForSite = useCallback((siteId: string) => {
    setAiLoadingBySiteId(prev => {
      if (!prev[siteId]) return prev
      const next = { ...prev }
      delete next[siteId]
      return next
    })
  }, [])

  // ---- 持久化 / 缓存 helper ----
  const persistAiSummaryForSite = useCallback((siteId: string, summary: AiSummaryResult) => {
    setAiSummaryBySiteId((prev) => {
      const next = { ...prev, [siteId]: summary }
      writeAiSummaryCache(next)
      return next
    })
  }, [])

  const removeAiSummaryFromCache = useCallback((siteId: string) => {
    setAiSummaryBySiteId((prev) => {
      if (!prev[siteId]) return prev
      const next = { ...prev }
      delete next[siteId]
      writeAiSummaryCache(next)
      return next
    })
  }, [])

  const persistAiSimilarForSite = useCallback((siteId: string, items: AiSimilarSite[]) => {
    setAiSimilarBySiteId((prev) => {
      const next = { ...prev, [siteId]: items }
      writeAiSimilarCache(next)
      return next
    })
  }, [])

  const removeAiSimilarFromCache = useCallback((siteId: string) => {
    setAiSimilarBySiteId((prev) => {
      if (!prev[siteId]) return prev
      const next = { ...prev }
      delete next[siteId]
      writeAiSimilarCache(next)
      return next
    })
  }, [])

  /** 「×」dismiss 按钮：中止当前站点的同类搜索并清除缓存 */
  const clearAiSimilarOnly = useCallback(() => {
    if (!selectedSite) return
    const siteId = selectedSite.id
    aiSimilarAbortMap.current.get(siteId)?.abort()
    aiSimilarAbortMap.current.delete(siteId)
    aiSimilarGenMap.current.set(siteId, (aiSimilarGenMap.current.get(siteId) ?? 0) + 1)
    clearAiLoadingForSite(siteId)
    removeAiSimilarFromCache(siteId)
  }, [selectedSite, clearAiLoadingForSite, removeAiSimilarFromCache])

  const persistAiResourceForSite = useCallback((siteId: string, data: SiteLearningLibrary) => {
    setAiResourcesBySiteId((prev) => {
      const next = { ...prev, [siteId]: data }
      writeAiResourceCache(next)
      return next
    })
  }, [])

  const removeAiResourceFromCache = useCallback((siteId: string) => {
    setAiResourcesBySiteId((prev) => {
      if (!prev[siteId]) return prev
      const next = { ...prev }
      delete next[siteId]
      writeAiResourceCache(next)
      return next
    })
  }, [])

  /** 用户点 ×：从当前站点缓存移除 AI 总结 */
  const dismissAiSummary = useCallback(() => {
    if (selectedSite) {
      removeAiSummaryFromCache(selectedSite.id)
      setSummaryNotesSavedIds((prev) => {
        const next = new Set(prev)
        next.delete(selectedSite.id)
        return next
      })
    }
  }, [selectedSite, removeAiSummaryFromCache])

  const handleDeleteConfirm = () => {
    if (!confirmDeleteSite) return
    removeAiSummaryFromCache(confirmDeleteSite.id)
    removeAiResourceFromCache(confirmDeleteSite.id)
    if (hasBackend()) apiDeleteSite(confirmDeleteSite.id).catch(() => {})
    saveSites(sites.filter(s => s.id !== confirmDeleteSite.id))
    setConfirmDeleteSite(null)
    if (selectedSite?.id === confirmDeleteSite.id) closePanel()
  }

  /** 后台标签页会节流定时器与任务调度，易导致 AI 请求「像停住」；轻量心跳 + Wake Lock，并在回到前台时重新申请锁 */
  useEffect(() => {
    if (!anyAiLoading) return
    let sentinel: WakeLockSentinel | null = null
    const syncWakeLock = async () => {
      try {
        if (!('wakeLock' in navigator)) return
        await sentinel?.release?.().catch(() => {})
        sentinel = null
        if (document.visibilityState !== 'visible') return
        sentinel = await navigator.wakeLock.request('screen')
      } catch {
        sentinel = null
      }
    }
    void syncWakeLock()
    const onVisibility = () => {
      void syncWakeLock()
    }
    document.addEventListener('visibilitychange', onVisibility)
    const hb = window.setInterval(() => undefined, 15000)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearInterval(hb)
      void sentinel?.release?.().catch(() => {})
    }
  }, [anyAiLoading])

  // 语言设置：zh = 中文，en = 英文
  const [lang, setLang] = useState<'zh' | 'en'>(() => {
    const saved = localStorage.getItem('myNavLang')
    return saved === 'en' ? 'en' : 'zh'
  })
  const toggleLang = () => {
    setLang(prev => {
      const next = prev === 'zh' ? 'en' : 'zh'
      localStorage.setItem('myNavLang', next)
      return next
    })
  }

  // API Key 配置状态
  const [kimiKeyConfigured, setKimiKeyConfigured] = useState(false)
  const [braveKeyConfigured, setBraveKeyConfigured] = useState(false)
  const [isApiSettingsOpen, setIsApiSettingsOpen] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [apiKeySaving, setApiKeySaving] = useState(false)
  const [braveKeyInput, setBraveKeyInput] = useState('')
  const [braveKeySaving, setBraveKeySaving] = useState(false)

  // Toast 通知
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' | 'warn' } | null>(null)
  const showToast = useCallback((msg: string, type: 'success' | 'error' | 'warn' = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }, [])

  // 拖拽状态：当前拖动的卡片、悬停的卡片（排序目标）、悬停的分组（快速分组）
  const [dragSiteId, setDragSiteId] = useState<string | null>(null)
  const [dropTargetSiteId, setDropTargetSiteId] = useState<string | null>(null)
  const [dragOverCategoryId, setDragOverCategoryId] = useState<string | null>(null)
  /** 「更多」已保存同类网站列表内拖拽排序 */
  const [dragSavedSimilarUrl, setDragSavedSimilarUrl] = useState<string | null>(null)
  const [dropTargetSavedSimilarUrl, setDropTargetSavedSimilarUrl] = useState<string | null>(null)
  const isDraggingRef = useRef(false)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !isPanelOpen || isLoginModalOpen) return
      if (confirmDismissAiSummary) {
        setConfirmDismissAiSummary(false)
        return
      }
      if (confirmRegenerateSummary) {
        setConfirmRegenerateSummary(false)
        return
      }
      if (confirmRegenerateResource) {
        setConfirmRegenerateResource(false)
        return
      }
      if (confirmDismissAiResources) {
        setConfirmDismissAiResources(false)
        return
      }
      if (confirmDeleteSite) return
      if (isPanelCategoryOpen) {
        e.preventDefault()
        setIsPanelCategoryOpen(false)
        return
      }
      closePanel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isPanelOpen, confirmDeleteSite, confirmDismissAiSummary, confirmRegenerateSummary, confirmRegenerateResource, confirmDismissAiResources, isLoginModalOpen, isPanelCategoryOpen])

  // 侧栏分组自定义下拉：点击外部关闭
  useEffect(() => {
    if (!isPanelCategoryOpen) return
    const handler = (e: MouseEvent) => {
      if (panelCategoryRef.current && !panelCategoryRef.current.contains(e.target as Node)) {
        setIsPanelCategoryOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isPanelCategoryOpen])

  useEffect(() => {
    if (!isDataMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (dataMenuRef.current && !dataMenuRef.current.contains(e.target as Node)) {
        setIsDataMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isDataMenuOpen])

  useEffect(() => {
    setIsPanelCategoryOpen(false)
  }, [selectedSite?.id, isPanelOpen])

  useEffect(() => {
    setDragSavedSimilarUrl(null)
    setDropTargetSavedSimilarUrl(null)
  }, [selectedSite?.id])

  const mapRemoteSite = useCallback((s: ApiSite): Site => ({
    id: s.id,
    favicon: s.favicon,
    name: s.name,
    url: s.url,
    category: s.category,
    tags: normalizeSiteTags(s.tags),
    notes: s.notes,
    description: s.description,
    isFollowed: s.isFollowed,
    isFavorite: s.isFavorite,
    views: s.views,
    likes: s.likes,
    createdAt: s.createdAt,
    lastOpenedAt: s.lastOpenedAt,
    sortOrder: s.sortOrder,
  }), [])

  const loadFromLocalStorage = useCallback(() => {
    const savedCats = localStorage.getItem('myNavCategories')
    let validCategories = BUILTIN_CATEGORIES
    if (savedCats) {
      const parsed = JSON.parse(savedCats) as Category[]
      validCategories = dedupeCategoriesById([
        ...BUILTIN_CATEGORIES,
        ...parsed.filter((c: Category) => c.id.startsWith('cat_')),
      ])
    }
    const validIds = new Set(validCategories.map((c: Category) => c.id))
    const savedSites = localStorage.getItem('myNavSites')
    const savedUser = localStorage.getItem('myNavUser')
    if (savedSites) {
      const parsed = JSON.parse(savedSites) as Record<string, unknown>[]
      const migrated = parsed.map((item) => {
        const status = item.status as string | undefined
        const isFollowed =
          typeof item.isFollowed === 'boolean'
            ? item.isFollowed
            : status === 'reading' || status === 'mastered'
        const next = {
          ...item,
          category: validIds.has(String(item.category)) ? item.category : 'ungrouped',
          views: (item.views as number) || Math.floor(Math.random() * 5000) + 100,
          likes: (item.likes as number) || Math.floor(Math.random() * 500) + 10,
          isFollowed,
        } as Record<string, unknown>
        delete next.status
        const site = next as unknown as Site
        site.tags = normalizeSiteTags((next as { tags?: unknown }).tags)
        return site
      })
      setSites(migrated)
    }
    setCategories(validCategories)
    if (savedUser) setUser(JSON.parse(savedUser))
  }, [])

  const syncRemoteState = useCallback(async () => {
    const [remoteSites, remoteCats, keyStatus, braveStatus] = await Promise.all([
      apiGetSites(),
      apiGetCategories(),
      apiGetKimiKeyStatus().catch(() => ({ configured: false })),
      apiGetBraveKeyStatus().catch(() => ({ configured: false })),
    ])
    setSites(remoteSites.map(mapRemoteSite))
    const custom = remoteCats.filter((c) => c.id.startsWith('cat_'))
    setCategories(
      dedupeCategoriesById([
        ...BUILTIN_CATEGORIES,
        ...custom.map((c) => ({ id: c.id, name: c.name })),
      ])
    )
    setKimiKeyConfigured(keyStatus.configured)
    setBraveKeyConfigured(braveStatus.configured)
  }, [mapRemoteSite])

  const persistSitesToLocal = useCallback((list: Site[]) => {
    localStorage.setItem('myNavSites', JSON.stringify(list.filter((s) => !s.pending)))
  }, [])

  // 保存站点：本地 + API（有 token 时）
  const saveSites = useCallback((newSites: Site[]) => {
    setSites(newSites)
    persistSitesToLocal(newSites)
  }, [persistSitesToLocal])

  /** 仅在用户实际打开站点链接时更新打开次数与最后打开时间 */
  const recordSiteLinkVisit = useCallback((siteId: string) => {
    const now = new Date().toISOString()
    setSites((prev) => {
      const updated = prev.map((s) =>
        s.id === siteId ? { ...s, views: (s.views || 0) + 1, lastOpenedAt: now } : s
      )
      persistSitesToLocal(updated)
      const row = updated.find((s) => s.id === siteId)
      if (row && hasBackend()) {
        apiUpdateSite(siteId, { views: row.views, lastOpenedAt: now }).catch(() => {})
      }
      return updated
    })
    setSelectedSite((prev) =>
      prev?.id === siteId ? { ...prev, views: (prev.views || 0) + 1, lastOpenedAt: now } : prev
    )
  }, [persistSitesToLocal])

  const saveCategories = useCallback((newCats: Category[]) => {
    const next = dedupeCategoriesById(newCats)
    setCategories(next)
    localStorage.setItem('myNavCategories', JSON.stringify(next))
  }, [])

  /** 云端为空时，将本地快照推送到账号（与导入云端分支类似，但不删除远端） */
  const pushLocalBookmarksToEmptyRemote = useCallback(
    async (snapshot: { categories: Category[]; sites: Site[] }) => {
      const customCats = snapshot.categories.filter((c) => c.id.startsWith('cat_'))
      const catIdMap = new Map<string, string>()
      for (const c of customCats) {
        const created = await apiCreateCategory(c.name)
        catIdMap.set(c.id, created.id)
      }
      const mergedCategories: Category[] = [
        ...BUILTIN_CATEGORIES,
        ...customCats.map((c) => ({ id: catIdMap.get(c.id)!, name: c.name })),
      ]
      const mapCat = (cat: string) => {
        if (BUILTIN_CATEGORY_IDS.has(cat)) return cat
        return catIdMap.get(cat) ?? 'ungrouped'
      }
      const newSiteId = () =>
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `site_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`

      // 按 URL 去重，防止本地已有重复条目时被放大
      const seenUrls = new Set<string>()
      const ordered = snapshot.sites.filter((s) => {
        const url = String(s.url ?? '').trim()
        if (!url || seenUrls.has(url)) return false
        seenUrls.add(url)
        return true
      })
      const createdSites: Site[] = []
      for (let i = 0; i < ordered.length; i++) {
        const s = ordered[i]
        const category = mapCat(s.category)
        const created = await apiCreateSite({
          id: newSiteId(),
          favicon: s.favicon ?? '',
          name: s.name,
          url: String(s.url).trim(),
          category,
          tags: normalizeSiteTags(s.tags),
          notes: typeof s.notes === 'string' ? s.notes : '',
          description: typeof s.description === 'string' ? s.description : '',
          isFollowed: Boolean(s.isFollowed),
          isFavorite: Boolean(s.isFavorite),
          views: typeof s.views === 'number' && Number.isFinite(s.views) ? s.views : 0,
          likes: typeof s.likes === 'number' && Number.isFinite(s.likes) ? s.likes : 0,
          createdAt: s.createdAt,
          lastOpenedAt: s.lastOpenedAt,
          sortOrder: i,
        })
        createdSites.push(mapRemoteSite(created))
      }
      saveCategories(mergedCategories)
      saveSites(createdSites)
      await apiReorderSites(createdSites.map((x) => x.id))
    },
    [mapRemoteSite, saveCategories, saveSites]
  )

  /** 写入 token/user 后：空云端则上传本地书签；否则拉云端；新登录且双端有数据时提示 */
  const runPostAuthSync = useCallback(
    async (opts: { token?: string; user?: User }): Promise<{ migrated: boolean; migratedCount: number }> => {
      if (opts.token) localStorage.setItem('myNavToken', opts.token)
      if (opts.user) {
        localStorage.setItem('myNavUser', JSON.stringify(opts.user))
        setUser(opts.user)
      }
      const freshLogin = Boolean(opts.token ?? opts.user)
      const snapshot = parseLocalStorageBookmarksForSync()
      const localSites = snapshot.sites.filter((s) => String(s.url ?? '').trim())
      let remoteSites: ApiSite[] = []
      try {
        remoteSites = await apiGetSites()
      } catch {
        try {
          await syncRemoteState()
        } catch {
          localStorage.removeItem('myNavToken')
          localStorage.removeItem('myNavUser')
          loadFromLocalStorage()
        }
        return { migrated: false, migratedCount: 0 }
      }

      // 只在真正的登录动作时迁移（freshLogin），页面刷新不触发，防止重复推送
      if (freshLogin && remoteSites.length === 0 && localSites.length > 0) {
        await pushLocalBookmarksToEmptyRemote(snapshot)
        await syncRemoteState()
        return { migrated: true, migratedCount: localSites.length }
      }

      if (freshLogin && remoteSites.length > 0 && localSites.length > 0) {
        showToast(
          '已加载云端数据。本地书签未自动合并；若需保留本地，请先用头部菜单「导出数据」备份，再按需导入。',
          'warn'
        )
      }
      await syncRemoteState()
      return { migrated: false, migratedCount: 0 }
    },
    [loadFromLocalStorage, pushLocalBookmarksToEmptyRemote, showToast, syncRemoteState]
  )

  useEffect(() => {
    let cancelled = false

    const bootstrap = async () => {
      const params = new URLSearchParams(window.location.search)
      const loginErr = params.get('login_error')
      const authCode = params.get('auth_code')

      if (loginErr || authCode) {
        params.delete('login_error')
        params.delete('auth_code')
        const q = params.toString()
        window.history.replaceState({}, '', window.location.pathname + (q ? `?${q}` : '') + window.location.hash)
      }

      if (loginErr) {
        const messages: Record<string, string> = {
          qq_missing: 'QQ 授权未完成',
          qq_state: 'QQ 登录已过期，请重试',
          qq_token: 'QQ 换取令牌失败',
          qq_openid: 'QQ 用户信息获取失败',
        }
        setLoginTab('qq')
        setIsLoginModalOpen(true)
        showToast(messages[loginErr] ?? '登录失败', 'error')
      }

      if (authCode) {
        try {
          const { token, user: exchangedUser } = await apiExchangeAuthCode(authCode)
          const nextUser: User = {
            id: exchangedUser.id,
            email: exchangedUser.email,
            name: exchangedUser.name,
            avatar: exchangedUser.avatar,
          }
          if (cancelled) return
          const r = await runPostAuthSync({ token, user: nextUser })
          if (cancelled) return
          if (r.migrated) {
            showToast(`QQ 登录成功，已同步 ${r.migratedCount} 条本地书签`, 'success')
          } else {
            showToast('QQ 登录成功', 'success')
          }
          return
        } catch {
          localStorage.removeItem('myNavToken')
          localStorage.removeItem('myNavUser')
          if (!cancelled) showToast('QQ 登录已失效，请重试', 'error')
        }
      }

      if (hasBackend()) {
        const savedUser = localStorage.getItem('myNavUser')
        if (savedUser) setUser(JSON.parse(savedUser))
        try {
          await runPostAuthSync({})
        } catch {
          localStorage.removeItem('myNavToken')
          localStorage.removeItem('myNavUser')
          if (!cancelled) loadFromLocalStorage()
        }
      } else if (!cancelled) {
        loadFromLocalStorage()
      }
    }

    void bootstrap()
    return () => {
      cancelled = true
    }
  }, [loadFromLocalStorage, runPostAuthSync, showToast])

  // 筛选网站
  const filteredSites = sites.filter(site => {
    if (currentCategory === 'all') {
      // 全部：不按分类筛
    } else if (currentCategory === 'favorites') {
      if (!site.isFavorite) return false
    } else if (site.category !== currentCategory) {
      return false
    }
    if (quickInput) {
      const term = quickInput.toLowerCase()
      if (isValidUrl(quickInput)) return true
      const tagStr = (site.tags ?? []).join(' ').toLowerCase()
      const desc = (site.description ?? '').toLowerCase()
      return site.name.toLowerCase().includes(term) ||
             site.url.toLowerCase().includes(term) ||
             site.notes.toLowerCase().includes(term) ||
             tagStr.includes(term) ||
             desc.includes(term)
    }
    return true
  })

  // 获取各分类数量
  const getCategoryCount = (catId: string) => {
    if (catId === 'all') return sites.length
    if (catId === 'favorites') return sites.filter(s => s.isFavorite).length
    return sites.filter(s => s.category === catId).length
  }

  // 快捷输入处理（双模式）
  const handleQuickInputSubmit = async () => {
    if (!quickInput.trim()) return
    
    const input = quickInput.trim()
    
    // 模式1：如果是URL，添加网站
    if (isValidUrl(input)) {
      let url = input
      if (!url.startsWith('http')) {
        url = 'https://' + url
      }
      const normalized = url.replace(/\/$/, '')
      const exists = sites.some(s => s.url.replace(/\/$/, '') === normalized)
      if (exists) {
        showToast('该网站已收藏过了', 'warn')
        return
      }

      setIsAdding(true)
      const info = await fetchSiteInfo(url)
      if (info) {
        const targetCategory =
          currentCategory === 'ungrouped' || currentCategory.startsWith('cat_')
            ? currentCategory
            : 'ungrouped'
        const siteData = {
          id: 'site_' + Date.now(),
          favicon: info.favicon,
          name: augmentSiteNameWithDeepLink(info.name, url, lang),
          url: url,
          category: targetCategory,
          tags: [] as string[],
          notes: '',
          description: info.description,
          isFollowed: false,
          isFavorite: false,
          createdAt: new Date().toISOString(),
          views: 0,
          likes: 0,
        }
        if (hasBackend()) {
          try {
            const created = await apiCreateSite(siteData)
            saveSites([...sites, { ...siteData, id: created.id }])
          } catch {
            saveSites([...sites, siteData])
          }
        } else {
          saveSites([...sites, siteData])
        }
        setQuickInput('')
        showToast('添加成功！', 'success')
      }
      setIsAdding(false)
    }
    // 模式2：如果是搜索词，执行搜索（已通过filteredSites实现）
  }

  const handleQuickInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleQuickInputSubmit()
    }
  }

  const resetLoginState = () => {
    setIsLoginModalOpen(false)
    setLoginEmail('')
    setEmailOtpStep(1)
    setLoginOtpCode('')
    setEmailOtpCooldown(0)
  }

  const resetEmailOtpFlow = () => {
    setEmailOtpStep(1)
    setLoginOtpCode('')
    setEmailOtpCooldown(0)
  }

  useEffect(() => {
    if (emailOtpCooldown <= 0) return
    const t = window.setInterval(() => setEmailOtpCooldown((s) => Math.max(0, s - 1)), 1000)
    return () => window.clearInterval(t)
  }, [emailOtpCooldown])

  const pullRemoteAfterLogin = useCallback(
    async (token: string, userObj: User) => runPostAuthSync({ token, user: userObj }),
    [runPostAuthSync]
  )

  const handleSendEmailOtp = async (e?: React.FormEvent) => {
    e?.preventDefault()
    const em = loginEmail.trim()
    if (!em || !em.includes('@')) {
      showToast('请输入有效邮箱', 'warn')
      return
    }
    setIsLoginLoading(true)
    try {
      const res = await apiSendEmailOtp(em)
      if (res.debugCode) {
        showToast(`开发模式验证码：${res.debugCode}`, 'warn')
      } else {
        showToast(res.message ?? '验证码已发送', 'success')
      }
      setEmailOtpStep(2)
      setEmailOtpCooldown(60)
    } catch (err) {
      showToast((err as Error).message, 'error')
    } finally {
      setIsLoginLoading(false)
    }
  }

  const handleVerifyEmailOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    const em = loginEmail.trim()
    const c = loginOtpCode.trim()
    if (!em || !/^\d{6}$/.test(c)) {
      showToast('请输入 6 位验证码', 'warn')
      return
    }
    setIsLoginLoading(true)
    try {
      const { token, user } = await apiVerifyEmailOtp(em, c)
      const nextUser: User = { id: user.id, email: user.email, name: user.name, avatar: user.avatar }
      const r = await pullRemoteAfterLogin(token, nextUser)
      if (r.migrated) {
        showToast(`登录成功，已同步 ${r.migratedCount} 条本地书签`, 'success')
      } else {
        showToast('登录成功', 'success')
      }
      resetLoginState()
    } catch (err) {
      showToast((err as Error).message, 'error')
    } finally {
      setIsLoginLoading(false)
    }
  }

  const handleQQLogin = () => {
    window.location.href = `${API_BASE}/auth/qq/start`
  }

  const handleLogout = () => {
    setUser(null)
    setKimiKeyConfigured(false)
    localStorage.removeItem('myNavUser')
    localStorage.removeItem('myNavToken')
    setShowUserMenu(false)
  }

  const handleSaveApiKey = async () => {
    const trimmed = apiKeyInput.trim()
    if (!trimmed) {
      showToast('请输入 API Key', 'warn')
      return
    }
    if (!isKimiApiKeyAsciiOnly(trimmed)) {
      showToast(
        'API Key 只能包含英文与常见符号，不能含中文或全角标点。请从 Kimi/Moonshot 控制台整段复制。',
        'error'
      )
      return
    }
    setApiKeySaving(true)
    try {
      await apiUpdateKimiKey(trimmed)
      setKimiKeyConfigured(true)
      setIsApiSettingsOpen(false)
      setApiKeyInput('')
      showToast('API Key 已保存', 'success')
    } catch (e) {
      showToast(`保存失败：${(e as Error).message}`, 'error')
    } finally {
      setApiKeySaving(false)
    }
  }

  const handleClearApiKey = async () => {
    setApiKeySaving(true)
    try {
      await apiUpdateKimiKey('')
      setKimiKeyConfigured(false)
      setApiKeyInput('')
      showToast('API Key 已清除', 'success')
    } catch (e) {
      showToast(`清除失败：${(e as Error).message}`, 'error')
    } finally {
      setApiKeySaving(false)
    }
  }

  const handleSaveBraveKey = async () => {
    const trimmed = braveKeyInput.trim()
    if (!trimmed) {
      showToast('请输入 Brave Search API Key', 'warn')
      return
    }
    setBraveKeySaving(true)
    try {
      await apiUpdateBraveKey(trimmed)
      setBraveKeyConfigured(true)
      setBraveKeyInput('')
      showToast('Brave Search API Key 已保存', 'success')
    } catch (e) {
      showToast(`保存失败：${(e as Error).message}`, 'error')
    } finally {
      setBraveKeySaving(false)
    }
  }

  const handleClearBraveKey = async () => {
    setBraveKeySaving(true)
    try {
      await apiUpdateBraveKey('')
      setBraveKeyConfigured(false)
      setBraveKeyInput('')
      showToast('Brave Search API Key 已清除', 'success')
    } catch (e) {
      showToast(`清除失败：${(e as Error).message}`, 'error')
    } finally {
      setBraveKeySaving(false)
    }
  }

  const exportNavData = useCallback(() => {
    const sitesPayload = sites.filter((s) => !s.pending).map((s, index) => ({
      id: s.id,
      favicon: s.favicon,
      name: s.name,
      url: s.url,
      category: s.category,
      tags: s.tags,
      notes: s.notes,
      description: s.description ?? '',
      isFollowed: s.isFollowed,
      isFavorite: Boolean(s.isFavorite),
      createdAt: s.createdAt,
      lastOpenedAt: s.lastOpenedAt,
      views: s.views ?? 0,
      likes: s.likes ?? 0,
      sortOrder: typeof s.sortOrder === 'number' ? s.sortOrder : index,
    }))
    const data = {
      format: 'opennav-backup',
      version: 2,
      about:
        '含自定义分组、全部网站及其备注、简介、标签、关注/收藏、浏览次数与排序等；导入可完整还原。',
      categories,
      sites: sitesPayload,
      exportedAt: new Date().toISOString(),
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `opennav-bookmarks-${new Date().toISOString().split('T')[0]}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [categories, sites])

  const handleExportNavData = () => {
    exportNavData()
    setIsDataMenuOpen(false)
    showToast('已导出：分组、网站与备注等完整数据', 'success')
  }

  // 打开右侧详情面板 (Manus风格)
  // AI 请求按站点隔离，不干扰其他站点的后台任务；切换站点只需更新 UI 状态
  const openSitePanel = (site: Site) => {
    setAiPanelTab('more')
    setSelectedSite(site)
    setEditNotes(site.notes)
    setSummaryNotesSavedIds((prev) => {
      const next = new Set(prev)
      const marker = aiSummaryNotesMarker(site.name)
      if ((site.notes ?? '').includes(marker)) next.add(site.id)
      else next.delete(site.id)
      return next
    })
    setResourceNotesSavedIds((prev) => {
      const next = new Set(prev)
      const marker = aiResourceNotesMarker(site.name)
      if ((site.notes ?? '').includes(marker)) next.add(site.id)
      else next.delete(site.id)
      return next
    })
    // 重置学习库 UI 状态
    setShowAddLinkForm(false)
    setNewLinkTitle('')
    setNewLinkUrl('')
    setNewLinkNote('')
    setShowBraveSearch(false)
    setBraveSearchQuery('')
    setBraveSearchResults([])
    setIsPanelOpen(true)
  }

  // 关闭右侧面板（不取消后台 AI 任务，关闭后 selectedSite=null，aiLoading 自动派生为 null）
  const closePanel = useCallback(() => {
    setIsPanelCategoryOpen(false)
    setIsPanelOpen(false)
    setTimeout(() => setSelectedSite(null), 300)
  }, [])

  const runImportFromParsed = useCallback(
    async (parsed: { categories?: unknown; sites?: unknown }) => {
      const customCats = normalizeImportedCustomCategories(parsed.categories)
      const nextCategoryList = [...BUILTIN_CATEGORIES, ...customCats]
      const validCatIds = new Set(nextCategoryList.map((c) => c.id))
      const normalizedSites = normalizeImportedSites(parsed.sites, validCatIds)
      if (normalizedSites.length === 0) {
        showToast('文件中没有有效的网站条目', 'warn')
        return
      }

      if (hasBackend()) {
        const ok = window.confirm(
          '已登录：导入将清空云端现有书签与自定义分组，并用文件内容替换。确定继续？'
        )
        if (!ok) return
        setIsImporting(true)
        try {
          const [remoteSites, remoteCats] = await Promise.all([apiGetSites(), apiGetCategories()])
          for (const s of remoteSites) {
            await apiDeleteSite(s.id)
          }
          for (const c of remoteCats) {
            if (c.id.startsWith('cat_')) await apiDeleteCategory(c.id)
          }
          const catIdMap = new Map<string, string>()
          for (const c of customCats) {
            const created = await apiCreateCategory(c.name)
            catIdMap.set(c.id, created.id)
          }
          const mergedCategories: Category[] = [
            ...BUILTIN_CATEGORIES,
            ...customCats.map((c) => ({ id: catIdMap.get(c.id)!, name: c.name })),
          ]
          const mapCat = (cat: string) => {
            if (BUILTIN_CATEGORY_IDS.has(cat)) return cat
            return catIdMap.get(cat) ?? 'ungrouped'
          }
          const newSiteId = () =>
            typeof crypto !== 'undefined' && 'randomUUID' in crypto
              ? crypto.randomUUID()
              : `site_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`

          const createdSites: Site[] = []
          for (let i = 0; i < normalizedSites.length; i++) {
            const s = normalizedSites[i]
            const category = mapCat(s.category)
            // 不使用文件里的 id，避免与库内残留或文件内重复 id 触发 UNIQUE
            const created = await apiCreateSite({
              id: newSiteId(),
              favicon: s.favicon,
              name: s.name,
              url: s.url,
              category,
              tags: s.tags,
              notes: s.notes,
              description: s.description ?? '',
              isFollowed: s.isFollowed,
              isFavorite: Boolean(s.isFavorite),
              views: s.views ?? 0,
              likes: s.likes ?? 0,
              createdAt: s.createdAt,
              lastOpenedAt: s.lastOpenedAt,
              sortOrder: i,
            })
            createdSites.push(mapRemoteSite(created))
          }
          saveCategories(mergedCategories)
          saveSites(createdSites)
          await apiReorderSites(createdSites.map((x) => x.id))
          closePanel()
          setCurrentCategory('all')
          showToast(`已导入 ${createdSites.length} 个网站（含备注、标签等）`, 'success')
        } catch (e) {
          showToast(`导入失败：${(e as Error).message}`, 'error')
          try {
            await syncRemoteState()
          } catch {
            loadFromLocalStorage()
          }
        } finally {
          setIsImporting(false)
        }
        return
      }

      saveCategories(nextCategoryList)
      saveSites(normalizedSites)
      closePanel()
      setCurrentCategory('all')
      showToast(`已导入 ${normalizedSites.length} 个网站（含备注、标签等）`, 'success')
    },
    [closePanel, loadFromLocalStorage, mapRemoteSite, saveCategories, saveSites, setCurrentCategory, showToast, syncRemoteState]
  )

  const handleImportFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setIsDataMenuOpen(false)
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as { categories?: unknown; sites?: unknown }
      await runImportFromParsed(parsed)
    } catch {
      showToast('无法解析 JSON，请确认导出格式', 'error')
    }
  }

  /** 侧栏打开时：点击主内容区空白关闭；卡片/按钮等交互仅切换内容或不关闭 */
  const handleMainDismissPanel = (e: React.MouseEvent) => {
    if (!isPanelOpen) return
    const el = e.target as HTMLElement
    if (el.closest('.site-card')) return
    if (el.closest('button')) return
    if (el.closest('input, textarea, select')) return
    if (el.closest('.panel-category-dropdown')) return
    if (el.closest('a[href]')) return
    closePanel()
  }

  /** Hero / 顶栏：仅点到容器自身空白时关闭（避免误点标题、搜索区） */
  const handleShellDismissPanel = (e: React.MouseEvent) => {
    if (!isPanelOpen) return
    if (e.target === e.currentTarget) closePanel()
  }

  const focusAiTabButton = useCallback((tab: AiPanelTab) => {
    requestAnimationFrame(() => {
      document.getElementById(aiTabButtonId(tab))?.focus()
    })
  }, [])

  const handleAiPanelTabKeyDown = useCallback(
    (e: React.KeyboardEvent, current: AiPanelTab) => {
      const i = AI_TAB_ORDER.indexOf(current)
      if (i < 0) return
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        const next = AI_TAB_ORDER[(i + 1) % AI_TAB_ORDER.length]
        setAiPanelTab(next)
        focusAiTabButton(next)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        const next = AI_TAB_ORDER[(i - 1 + AI_TAB_ORDER.length) % AI_TAB_ORDER.length]
        setAiPanelTab(next)
        focusAiTabButton(next)
      } else if (e.key === 'Home') {
        e.preventDefault()
        setAiPanelTab('more')
        focusAiTabButton('more')
      } else if (e.key === 'End') {
        e.preventDefault()
        setAiPanelTab('summary')
        focusAiTabButton('summary')
      }
    },
    [focusAiTabButton]
  )

  const toggleFavorite = () => {
    if (!selectedSite) return
    const next = !selectedSite.isFavorite
    const updated = sites.map(s => s.id === selectedSite.id ? { ...s, isFavorite: next } : s)
    saveSites(updated)
    setSelectedSite({ ...selectedSite, isFavorite: next })
    if (hasBackend()) apiUpdateSite(selectedSite.id, { isFavorite: next }).catch(() => {})
  }

  // ==================== AI 智能助手 ====================
  /** 暂停当前站点的同类搜索（不清除缓存，只取消进行中的请求） */
  const cancelAiSimilarRequest = useCallback(() => {
    if (!selectedSite) return
    aiSimilarAbortMap.current.get(selectedSite.id)?.abort()
  }, [selectedSite])

  const handleAiSimilar = async () => {
    if (!selectedSite) return
    const siteId = selectedSite.id
    const siteName = selectedSite.name
    const siteUrl = selectedSite.url
    const siteDesc = selectedSite.description ?? ''

    // 中止该站点上一次同类搜索（若有），递增 gen 使旧 Promise 回调失效
    aiSimilarAbortMap.current.get(siteId)?.abort()
    const ac = new AbortController()
    aiSimilarAbortMap.current.set(siteId, ac)
    const gen = (aiSimilarGenMap.current.get(siteId) ?? 0) + 1
    aiSimilarGenMap.current.set(siteId, gen)

    setAiLoadingForSite(siteId, 'similar')
    try {
      const results = await apiAiSimilar(siteName, siteUrl, siteDesc, { signal: ac.signal, lang })
      if (aiSimilarGenMap.current.get(siteId) !== gen) return
      const pool = results.slice(0, 20)
      const filtered = filterAiSimilarExcludeInNav(sites, pool).slice(0, 10)
      if (pool.length > 0 && filtered.length === 0) {
        showToast('本次推荐均已收录于导航', 'warn')
      }
      // 无论结果是否为空均写入缓存（空数组 = 已搜索但均已收录）
      persistAiSimilarForSite(siteId, filtered)
    } catch (e) {
      const err = e as Error
      if (err.name === 'AbortError') return
      if (aiSimilarGenMap.current.get(siteId) === gen) {
        showToast(err.message, 'error')
      }
    } finally {
      if (aiSimilarGenMap.current.get(siteId) === gen) {
        clearAiLoadingForSite(siteId)
        aiSimilarAbortMap.current.delete(siteId)
      }
    }
  }

  const buildResourcesMarkdown = (siteName: string, lib: SiteLearningLibrary): string => {
    const lines: string[] = []
    lines.push(aiResourceNotesMarker(siteName))
    if (lib.summary) {
      lines.push('')
      lines.push(lib.summary)
    }
    const aiLinks = lib.links.filter(l => l.source === 'ai')
    if (aiLinks.length > 0) {
      lines.push('')
      lines.push('## AI 推荐资料')
      aiLinks.forEach((l, i) => {
        lines.push(`${i + 1}. [${l.title}](${l.url})`)
      })
    }
    const manualLinks = lib.links.filter(l => l.source !== 'ai')
    if (manualLinks.length > 0) {
      lines.push('')
      lines.push('## 手动添加')
      manualLinks.forEach((l, i) => {
        const noteStr = l.note ? `（${l.note}）` : ''
        const srcLabel = l.source === 'search' ? ' [搜索]' : ''
        lines.push(`${i + 1}. [${l.title}](${l.url})${srcLabel}${noteStr}`)
      })
    }
    return lines.join('\n')
  }

  const cancelAiResourceRequest = useCallback(() => {
    if (!selectedSite) return
    aiResourceAbortMap.current.get(selectedSite.id)?.abort()
  }, [selectedSite])

  const handleAiResource = async () => {
    if (!selectedSite) return
    const siteId = selectedSite.id
    const siteName = selectedSite.name
    const siteUrl = selectedSite.url
    const siteDesc = selectedSite.description ?? ''
    const siteNotes = selectedSite.notes ?? ''
    const cachedResource = aiResourcesBySiteId[siteId] ?? null

    aiResourceAbortMap.current.get(siteId)?.abort()
    const ac = new AbortController()
    aiResourceAbortMap.current.set(siteId, ac)
    const gen = (aiResourceGenMap.current.get(siteId) ?? 0) + 1
    aiResourceGenMap.current.set(siteId, gen)

    setResourceNotesSavedIds((prev) => {
      const next = new Set(prev)
      next.delete(siteId)
      return next
    })
    setAiLoadingForSite(siteId, 'resource')
    try {
      const result = await apiAiResources(siteName, siteUrl, siteDesc, { signal: ac.signal, lang })
      if (aiResourceGenMap.current.get(siteId) !== gen) return
      const now = new Date().toISOString()
      // 保留用户手动/搜索添加的链接，仅替换 AI 推荐部分
      const existingNonAiLinks = (cachedResource?.links ?? []).filter(l => l.source !== 'ai')
      const existingNonAiUrls = new Set(existingNonAiLinks.map(l => normalizeLibraryUrl(l.url)))
      const newAiLinks: LibraryLink[] = result.links
        .filter(l => l.url && !existingNonAiUrls.has(normalizeLibraryUrl(l.url)))
        .map((l, i) => ({ title: l.title, url: l.url, source: 'ai' as const, addedAt: now, searchRank: i }))
      const merged: SiteLearningLibrary = {
        version: 1,
        summary: result.summary,
        links: dedupeLibraryLinksByHostname([...newAiLinks, ...existingNonAiLinks]),
      }
      persistAiResourceForSite(siteId, merged)
    } catch (e) {
      const err = e as Error
      if (err.name === 'AbortError') {
        if (aiResourceGenMap.current.get(siteId) === gen) {
          // 取消后恢复「已保存」标记（数据仍在缓存中，无需重置 aiResources）
          const marker = aiResourceNotesMarker(siteName)
          if (cachedResource && siteNotes.includes(marker)) {
            setResourceNotesSavedIds((prev) => new Set(prev).add(siteId))
          }
        }
        return
      }
      if (aiResourceGenMap.current.get(siteId) === gen) {
        showToast(err.message, 'error')
      }
    } finally {
      if (aiResourceGenMap.current.get(siteId) === gen) {
        clearAiLoadingForSite(siteId)
        aiResourceAbortMap.current.delete(siteId)
      }
    }
  }

  const handleRegenerateResourceClick = () => {
    if (!selectedSite || aiLoading !== null) return
    if (!resourceNotesSavedIds.has(selectedSite.id)) {
      setConfirmRegenerateResource(true)
      return
    }
    void handleAiResource()
  }

  /** 单独添加某个 AI 发现 / 已保存的同类网站到导航 */
  const handleAddSingleAiSite = async (aiSite: AiSimilarSite) => {
    if (!selectedSite || addingSingleSiteUrl) return
    const belongSiteId = selectedSite.id   // 捕获，防止切站后操作错站点
    const urlResolved = resolveSimilarSiteUrl(aiSite.url)
    if (!urlResolved) {
      showToast('网址无效', 'warn')
      return
    }
    const normalized = urlResolved.replace(/\/$/, '')
    if (sites.some((s) => s.url.replace(/\/$/, '') === normalized)) {
      showToast('该网站已收藏过了', 'warn')
      return
    }

    let hostname = ''
    try {
      hostname = new URL(urlResolved).hostname
    } catch {
      showToast('网址无效', 'warn')
      return
    }

    const tempId = `pending_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    const reasonTrim = (aiSite.reason ?? '').trim()
    const provisional: Site = {
      id: tempId,
      pending: true,
      favicon: `https://www.google.com/s2/favicons?domain=${hostname}&sz=128`,
      name: aiSite.name,
      url: urlResolved,
      category: selectedSite.category,
      tags: [],
      notes: '',
      // 卡片与侧栏展示 description；须与列表中的 reason 一致，避免抓取到的英文 meta 覆盖中文说明
      description: reasonTrim,
      isFollowed: false,
      isFavorite: false,
      createdAt: new Date().toISOString(),
      views: 0,
      likes: 0,
    }

    setAddingSingleSiteUrl(aiSite.url)
    setSites((prev) => {
      const next = [provisional, ...prev]
      persistSitesToLocal(next)
      return next
    })

    try {
      const info = await fetchSiteInfo(urlResolved).catch(() => null)
      const siteName = lang === 'zh' ? aiSite.name : (info?.name ?? aiSite.name)
      const fetchedDesc = (info?.description ?? '').trim()
      const siteData = {
        id: 'site_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        favicon: info?.favicon ?? provisional.favicon,
        name: augmentSiteNameWithDeepLink(siteName, urlResolved, lang),
        url: urlResolved,
        category: selectedSite.category,
        tags: [] as string[],
        notes: '',
        description: reasonTrim || fetchedDesc,
        isFollowed: false,
        isFavorite: false,
        createdAt: new Date().toISOString(),
        views: 0,
        likes: 0,
      }
      let finalSite: Site = { ...siteData }
      if (hasBackend()) {
        try {
          const created = await apiCreateSite(siteData)
          finalSite = { ...siteData, id: created.id }
        } catch {
          finalSite = siteData
        }
      }
      setSites((prev) => {
        const next = [finalSite, ...prev.filter((s) => s.id !== tempId)]
        persistSitesToLocal(next)
        return next
      })
      setSelectedSite((prev) => (prev?.id === tempId ? finalSite : prev))
      showToast('已添加到导航', 'success')
      const k = normalizeSimilarSiteUrlForDedupe(aiSite.url)
      setAiSimilarBySiteId((prev) => {
        const current = prev[belongSiteId]
        if (!current) return prev
        const filtered = current.filter((s) => normalizeSimilarSiteUrlForDedupe(s.url) !== k)
        const next =
          filtered.length > 0
            ? { ...prev, [belongSiteId]: filtered }
            : (() => {
                const n = { ...prev }
                delete n[belongSiteId]
                return n
              })()
        writeAiSimilarCache(next)
        return next
      })
    } catch (err) {
      setSites((prev) => {
        const next = prev.filter((s) => s.id !== tempId)
        persistSitesToLocal(next)
        return next
      })
      setSelectedSite((prev) => (prev?.id === tempId ? null : prev))
      showToast((err as Error)?.message || '添加失败', 'error')
    } finally {
      setAddingSingleSiteUrl(null)
    }
  }

  /** 从「更多」标签的已保存列表中移除某一条 */
  const handleRemoveSimilarFromMore = (url: string) => {
    if (!selectedSite) return
    const existing = aiSimilarBySiteId[selectedSite.id] ?? []
    const filtered = existing.filter(s => s.url !== url)
    if (filtered.length === 0) {
      removeAiSimilarFromCache(selectedSite.id)
    } else {
      persistAiSimilarForSite(selectedSite.id, filtered)
    }
  }

  const handleSaveResourcesToNotes = () => {
    if (!aiResources || !selectedSite) return
    const md = buildResourcesMarkdown(selectedSite.name, aiResources)
    const appended = editNotes ? editNotes + '\n\n' + md : md
    setEditNotes(appended)
    const updated = sites.map(s => s.id === selectedSite.id ? { ...s, notes: appended } : s)
    saveSites(updated)
    setSelectedSite({ ...selectedSite, notes: appended })
    if (hasBackend()) apiUpdateSite(selectedSite.id, { notes: appended }).catch(() => {})
    setResourceNotesSavedIds((prev) => new Set(prev).add(selectedSite.id))
  }

  const handleAddLibraryLink = () => {
    if (!selectedSite) return
    const rawUrl = newLinkUrl.trim()
    if (!rawUrl) { showToast('请输入网址', 'warn'); return }
    const url = rawUrl.startsWith('http') ? rawUrl : 'https://' + rawUrl
    const existing = aiResources ?? { version: 1 as const, summary: '', links: [] }
    if (existing.links.some(l => normalizeLibraryUrl(l.url) === normalizeLibraryUrl(url))) {
      showToast('该链接已在学习库中', 'warn')
      return
    }
    const newLink: LibraryLink = {
      title: newLinkTitle.trim() || url,
      url,
      source: 'manual',
      addedAt: new Date().toISOString(),
      note: newLinkNote.trim() || undefined,
    }
    const updated: SiteLearningLibrary = { ...existing, links: [...existing.links, newLink] }
    persistAiResourceForSite(selectedSite.id, updated)
    setNewLinkTitle('')
    setNewLinkUrl('')
    setNewLinkNote('')
    setShowAddLinkForm(false)
  }

  const handleDeleteLibraryLink = (url: string) => {
    if (!selectedSite || !aiResources) return
    const updated: SiteLearningLibrary = {
      ...aiResources,
      links: aiResources.links.filter(l => l.url !== url),
    }
    persistAiResourceForSite(selectedSite.id, updated)
  }

  const handleDownloadLibraryMarkdown = () => {
    if (!selectedSite || !aiResources) return
    const md = buildResourcesMarkdown(selectedSite.name, aiResources)
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const dlUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = dlUrl
    a.download = `${latin1SafeDownloadBasename(selectedSite.name, 'site')}_library.md`
    a.click()
    URL.revokeObjectURL(dlUrl)
    showToast('学习库 Markdown 已下载', 'success')
  }

  const handleBraveSearch = async () => {
    if (!braveSearchQuery.trim() || !selectedSite) return
    braveSearchAbortRef.current?.abort()
    const ac = new AbortController()
    braveSearchAbortRef.current = ac
    setIsBraveSearchLoading(true)
    setBraveSearchResults([])
    try {
      const results = await apiLibrarySearch(braveSearchQuery.trim(), {
        signal: ac.signal,
        lang,
        siteName: selectedSite.name,
      })
      setBraveSearchResults(results)
    } catch (e) {
      const err = e as Error
      if (err.name !== 'AbortError') showToast(err.message, 'error')
    } finally {
      setIsBraveSearchLoading(false)
      braveSearchAbortRef.current = null
    }
  }

  const handleAddBraveResultToLibrary = (item: BraveSearchItem) => {
    if (!selectedSite) return
    const existing = aiResources ?? { version: 1 as const, summary: '', links: [] }
    if (existing.links.some(l => normalizeLibraryUrl(l.url) === normalizeLibraryUrl(item.url))) {
      showToast('已在学习库中', 'warn')
      return
    }
    const newLink: LibraryLink = {
      title: item.title,
      url: item.url,
      source: 'search',
      addedAt: new Date().toISOString(),
      description: item.description || undefined,
    }
    const updated: SiteLearningLibrary = { ...existing, links: [...existing.links, newLink] }
    persistAiResourceForSite(selectedSite.id, updated)
    setBraveSearchResults(prev => prev.filter(r => r.url !== item.url))
    showToast('已加入学习库', 'success')
  }

  const cancelAiSummaryRequest = useCallback(() => {
    if (!selectedSite) return
    aiSummaryAbortMap.current.get(selectedSite.id)?.abort()
  }, [selectedSite])

  const handleAiSummary = async () => {
    if (!selectedSite) return
    const siteId = selectedSite.id
    const siteName = selectedSite.name
    const siteUrl = selectedSite.url
    const siteDesc = selectedSite.description ?? ''
    const siteNotes = selectedSite.notes ?? ''
    const cachedSummary = aiSummaryBySiteId[siteId] ?? null

    aiSummaryAbortMap.current.get(siteId)?.abort()
    const ac = new AbortController()
    aiSummaryAbortMap.current.set(siteId, ac)
    const gen = (aiSummaryGenMap.current.get(siteId) ?? 0) + 1
    aiSummaryGenMap.current.set(siteId, gen)

    setSummaryNotesSavedIds((prev) => {
      const next = new Set(prev)
      next.delete(siteId)
      return next
    })
    setAiLoadingForSite(siteId, 'summary')
    try {
      const result = await apiAiSummary(siteName, siteUrl, siteDesc, { signal: ac.signal, lang })
      if (aiSummaryGenMap.current.get(siteId) !== gen) return
      persistAiSummaryForSite(siteId, result)
    } catch (e) {
      const err = e as Error
      if (err.name === 'AbortError') {
        if (aiSummaryGenMap.current.get(siteId) === gen) {
          // 取消后恢复「已保存」标记（数据仍在缓存中，无需重置 aiSummary）
          const marker = aiSummaryNotesMarker(siteName)
          if (cachedSummary && siteNotes.includes(marker)) {
            setSummaryNotesSavedIds((prev) => new Set(prev).add(siteId))
          }
        }
        return
      }
      if (aiSummaryGenMap.current.get(siteId) === gen) {
        showToast(err.message, 'error')
      }
    } finally {
      if (aiSummaryGenMap.current.get(siteId) === gen) {
        clearAiLoadingForSite(siteId)
        aiSummaryAbortMap.current.delete(siteId)
      }
    }
  }

  const buildSummaryMarkdown = (s: AiSummaryResult, siteName: string): string => {
    const lines: string[] = []
    lines.push(aiSummaryNotesMarker(siteName))
    lines.push('')
    lines.push('## 产品概述')
    lines.push(s.overview)
    lines.push('')
    lines.push('## 产品架构')
    lines.push(s.architecture)
    lines.push('')
    lines.push('## 核心功能')
    s.features.forEach(f => lines.push(`- ${f}`))
    lines.push('')
    lines.push('## 技术栈')
    s.tech.forEach(t => lines.push(`- ${t}`))
    lines.push('')
    lines.push('## Skills 关键词')
    lines.push(s.skills.join('、'))
    lines.push('')
    lines.push('## 视觉解析报告')
    lines.push(`**风格**：${s.visual.style}`)
    lines.push(`**布局**：${s.visual.layout}`)
    lines.push(`**字体/排版**：${s.visual.typography}`)
    lines.push(`**主要色彩**：${s.visual.colors.join('、')}`)
    lines.push(`**典型组件**：${s.visual.components.join('、')}`)
    return lines.join('\n')
  }

  /** 生成可放入 Cursor 等环境的站点 Skill（Markdown）：含完整产品报告 + 视觉风格 token */
  const buildSiteSkillMarkdown = (site: Site, s: AiSummaryResult): string => {
    const fmName = `${site.name} 站点上下文`
    const fmDesc = `基于 OpenNav 深度总结的「${site.name}」产品报告与视觉风格，供 AI 在相关工作流中使用。`
    const header = `---\nname: ${JSON.stringify(fmName)}\ndescription: ${JSON.stringify(fmDesc)}\n---\n\n`
    const meta = [
      `# ${site.name} — 站点 Skill`,
      '',
      `> 站点地址：${site.url}`,
      ...(site.description ? [`> 简介：${site.description}`] : []),
      '',
    ].join('\n')
    const product = [
      '## 产品报告',
      '',
      '### 产品概述',
      '',
      s.overview,
      '',
      '### 产品架构',
      '',
      s.architecture,
      '',
      '### 核心功能',
      '',
      ...s.features.map((f) => `- ${f}`),
      '',
      '### 技术栈',
      '',
      ...s.tech.map((t) => `- ${t}`),
      '',
      '### Skills 关键词',
      '',
      s.skills.join('、'),
      '',
    ].join('\n')
    const visual = [
      '## 视觉风格',
      '',
      '### 风格与气质',
      '',
      s.visual.style,
      '',
      '### 字体与排版',
      '',
      s.visual.typography,
      '',
      '### 色彩',
      '',
      s.visual.colors.join('、'),
      '',
      '### 布局几何',
      '',
      s.visual.layout,
      '',
      '### 典型 UI 组件',
      '',
      s.visual.components.join('、'),
      '',
      '## 使用说明',
      '',
      '可将本文件作为 Cursor **Skill**（或项目规则 / 上下文）引用，使助手在分析、复刻或讨论该站点时与上述结论保持一致。',
      '',
    ].join('\n')
    return header + meta + '\n' + product + visual
  }

  const handleGenerateSiteSkill = () => {
    if (!aiSummary || !selectedSite) return
    const md = buildSiteSkillMarkdown(selectedSite, aiSummary)
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${latin1SafeDownloadBasename(selectedSite.name, 'site')}_site_skill.md`
    a.click()
    URL.revokeObjectURL(url)
    showToast('Skill 文件已下载', 'success')
  }

  const handleCopySummary = async () => {
    if (!aiSummary || !selectedSite) return
    const text = buildSummaryMarkdown(aiSummary, selectedSite.name)
    try {
      await navigator.clipboard.writeText(text)
      showToast('产品总结已复制到剪贴板', 'success')
    } catch {
      showToast('复制失败，请检查浏览器权限或手动复制', 'error')
    }
  }

  const handleSaveSummaryToNotes = () => {
    if (!aiSummary || !selectedSite) return
    const md = buildSummaryMarkdown(aiSummary, selectedSite.name)
    const appended = editNotes ? editNotes + '\n\n' + md : md
    setEditNotes(appended)
    const updated = sites.map(s => s.id === selectedSite.id ? { ...s, notes: appended } : s)
    saveSites(updated)
    setSelectedSite({ ...selectedSite, notes: appended })
    if (hasBackend()) apiUpdateSite(selectedSite.id, { notes: appended }).catch(() => {})
    setSummaryNotesSavedIds((prev) => new Set(prev).add(selectedSite.id))
  }

  /** 头部「重新生成」：未保存到备注时先询问 */
  const handleRegenerateSummaryClick = () => {
    if (!selectedSite || aiLoading !== null) return
    if (!summaryNotesSavedIds.has(selectedSite.id)) {
      setConfirmRegenerateSummary(true)
      return
    }
    void handleAiSummary()
  }

  const handleAddCategory = async () => {
    const name = newCategoryName.trim()
    if (!name) return
    if (hasBackend()) {
      try {
        const cat = await apiCreateCategory(name)
        saveCategories([...categories, { id: cat.id, name: cat.name }])
      } catch {
        const id = 'cat_' + Date.now()
        saveCategories([...categories, { id, name }])
      }
    } else {
      const id = 'cat_' + Date.now()
      saveCategories([...categories, { id, name }])
    }
    setNewCategoryName('')
    setShowAddCategory(false)
  }

  const handleDeleteCategory = (catId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const catName = categories.find(c => c.id === catId)?.name || '该分组'
    if (!confirm(`确定要删除分组「${catName}」吗？该分组下的链接将移入「未分组」。`)) return
    if (hasBackend()) apiDeleteCategory(catId).catch(() => {})
    const updatedSites = sites.map(s => s.category === catId ? { ...s, category: 'ungrouped' } : s)
    saveSites(updatedSites)
    saveCategories(categories.filter(c => c.id !== catId))
    if (currentCategory === catId) setCurrentCategory('all')
  }

  const handleCategoryChange = (catId: string) => {
    if (!selectedSite) return
    const updated = sites.map(s => s.id === selectedSite.id ? { ...s, category: catId } : s)
    saveSites(updated)
    setSelectedSite({ ...selectedSite, category: catId })
    if (hasBackend()) apiUpdateSite(selectedSite.id, { category: catId }).catch(() => {})
  }

  const panelCategoryOptions = useMemo(
    () => categories.filter(c => c.id === 'ungrouped' || c.id.startsWith('cat_')),
    [categories]
  )

  /** 学习库链接：按添加时间倒序（切换站点/编辑库后自动刷新） */
  const libraryOrderedLinks = useMemo(() => {
    if (!aiResources) return []
    return [...aiResources.links].sort((a, b) => b.addedAt.localeCompare(a.addedAt))
  }, [aiResources])

  /** 「更多」已保存同类网站：拖拽调整顺序 */
  const handleReorderSavedSimilar = useCallback((draggedUrl: string, dropTargetUrl: string) => {
    if (!selectedSite || draggedUrl === dropTargetUrl) return
    setAiSimilarBySiteId((prev) => {
      const list = prev[selectedSite.id] ?? []
      const fromIdx = list.findIndex((s) => s.url === draggedUrl)
      const toIdx = list.findIndex((s) => s.url === dropTargetUrl)
      if (fromIdx === -1 || toIdx === -1) return prev
      const arr = [...list]
      const [item] = arr.splice(fromIdx, 1)
      const newToIdx = toIdx > fromIdx ? toIdx - 1 : toIdx
      arr.splice(newToIdx, 0, item)
      const next = { ...prev, [selectedSite.id]: arr }
      writeAiSimilarCache(next)
      return next
    })
    showToast('顺序已更新', 'success')
  }, [selectedSite, showToast])

  // 拖拽：改变卡片顺序
  const handleReorder = (draggedId: string, dropTargetId: string) => {
    if (draggedId === dropTargetId) return
    const fromIdx = sites.findIndex(s => s.id === draggedId)
    const toIdx = sites.findIndex(s => s.id === dropTargetId)
    if (fromIdx === -1 || toIdx === -1) return
    const arr = [...sites]
    const [item] = arr.splice(fromIdx, 1)
    const newToIdx = toIdx > fromIdx ? toIdx - 1 : toIdx
    arr.splice(newToIdx, 0, item)
    saveSites(arr)
    if (hasBackend()) apiReorderSites(arr.map(s => s.id)).catch(() => {})
    showToast('顺序已更新', 'success')
  }

  // 拖拽：拖到分组标签快速分组
  const handleDropToCategory = (siteId: string, catId: string) => {
    const site = sites.find(s => s.id === siteId)
    if (!site || site.category === catId) return
    const updated = sites.map(s => s.id === siteId ? { ...s, category: catId } : s)
    saveSites(updated)
    if (hasBackend()) apiUpdateSite(siteId, { category: catId }).catch(() => {})
    if (selectedSite?.id === siteId) setSelectedSite({ ...selectedSite, category: catId })
    showToast(`已移入「${getCategoryName(catId)}」`, 'success')
  }

  // 分组是否可作为拖放目标（虚拟分组不可）
  const isCategoryDroppable = (catId: string) =>
    catId === 'ungrouped' || catId.startsWith('cat_')

  // 获取域名
  /** 面板 / 卡片 URL 展示：包含路径（去掉 www 和末尾 /），无协议 */
  const getDisplayUrl = (url: string) => {
    try {
      const u = new URL(url)
      const host = u.hostname.replace(/^www\./, '')
      const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')
      const query = u.search || ''
      return host + path + query
    } catch {
      return url
    }
  }

  // 获取分类名称
  const getCategoryName = (id: string) => {
    return categories.find(c => c.id === id)?.name || id
  }

  const copyLink = () => {
    if (!selectedSite) return
    navigator.clipboard.writeText(selectedSite.url).then(() => showToast('链接已复制', 'success'))
  }

  const formatLastOpened = (iso: string | undefined): string => {
    if (!iso) return '从未'
    const diff = Date.now() - new Date(iso).getTime()
    const min = Math.floor(diff / 60000)
    const hour = Math.floor(diff / 3600000)
    const day = Math.floor(diff / 86400000)
    if (min < 1) return '刚刚'
    if (min < 60) return `${min} 分钟前`
    if (hour < 24) return `${hour} 小时前`
    if (day < 30) return `${day} 天前`
    return new Date(iso).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
  }

  const savedSimilarForMoreTab = selectedSite ? (aiSimilarBySiteId[selectedSite.id] ?? []) : []
  const hasSavedSimilarForMoreTab = savedSimilarForMoreTab.length > 0

  return (
    <div className={`app ${isPanelOpen ? 'panel-open' : ''}`}>
      {/* 顶部导航 */}
      <header className="header" onClick={handleShellDismissPanel}>
        <div className="logo">
          <div className="logo-mark">◈</div>
          <span className="logo-text">OpenNav</span>
        </div>
        <div className="header-actions">
          <input
            ref={importFileInputRef}
            type="file"
            accept="application/json,.json"
            className="import-file-input"
            aria-hidden
            tabIndex={-1}
            onChange={handleImportFileChange}
          />
          <div className="data-menu-container" ref={dataMenuRef}>
            <button
              type="button"
              className="header-icon-btn"
              title="导入 / 导出（含分组、网站、备注、简介、标签、收藏等）"
              aria-label="导入或导出完整书签数据"
              aria-expanded={isDataMenuOpen}
              aria-haspopup="menu"
              disabled={isImporting}
              onClick={() => {
                setIsDataMenuOpen((v) => !v)
                setShowUserMenu(false)
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3"/>
              </svg>
            </button>
            {isDataMenuOpen && (
              <div className="user-dropdown data-menu-dropdown" role="menu">
                <button
                  type="button"
                  className="dropdown-item dropdown-item--stacked"
                  role="menuitem"
                  disabled={isImporting}
                  title="含自定义分组、全部网站及其备注、简介、标签、关注与收藏等"
                  onClick={() => {
                    setIsDataMenuOpen(false)
                    importFileInputRef.current?.click()
                  }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
                  </svg>
                  <span className="dropdown-item-with-sub">
                    <span className="dropdown-item-main">导入数据</span>
                    <span className="dropdown-item-sub">分组、网站、备注与标签等</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="dropdown-item dropdown-item--stacked"
                  role="menuitem"
                  disabled={isImporting}
                  title="导出当前全部分组与网站（含已填备注、简介、标签、收藏与浏览数据）"
                  onClick={handleExportNavData}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                  </svg>
                  <span className="dropdown-item-with-sub">
                    <span className="dropdown-item-main">导出数据</span>
                    <span className="dropdown-item-sub">同上，完整备份 JSON</span>
                  </span>
                </button>
              </div>
            )}
          </div>
          {/* 语言切换按钮 */}
          <button
            className="header-lang-btn"
            title={lang === 'zh' ? '切换为英文 / Switch to English' : '切换为中文 / 切换到中文'}
            onClick={toggleLang}
            aria-label={lang === 'zh' ? 'Switch to English' : '切换为中文'}
          >
            <span className={`lang-opt${lang === 'zh' ? ' active' : ''}`}>中</span>
            <span className="lang-sep">/</span>
            <span className={`lang-opt${lang === 'en' ? ' active' : ''}`}>EN</span>
          </button>

          {/* 主题切换按钮 */}
          <button className="header-icon-btn" title="切换主题">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="5"/>
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
            </svg>
          </button>
          
          {/* 用户区域 */}
          {user ? (
            <div className="user-menu-container">
              <button
                className="user-avatar-btn"
                onClick={() => {
                  setShowUserMenu((v) => !v)
                  setIsDataMenuOpen(false)
                }}
              >
                <div className="user-avatar">
                  {user.avatar ? (
                    <img src={user.avatar} alt={user.name} />
                  ) : (
                    <span>{user.name.charAt(0).toUpperCase()}</span>
                  )}
                </div>
                <span className="user-name">{user.name}</span>
                <svg className="dropdown-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 9l6 6 6-6"/>
                </svg>
              </button>
              
              {showUserMenu && (
                <div className="user-dropdown">
                  <div
                    className="dropdown-item dropdown-item-api"
                    onClick={() => { setIsApiSettingsOpen(true); setShowUserMenu(false) }}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="3"/>
                      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
                    </svg>
                    <span className="dropdown-item-text">API 设置</span>
                    {kimiKeyConfigured
                      ? <span className="api-key-badge configured">已配置</span>
                      : <span className="api-key-badge">未配置</span>
                    }
                  </div>
                  <div className="dropdown-divider"></div>
                  <div className="dropdown-item danger" onClick={handleLogout}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>
                    </svg>
                    退出登录
                  </div>
                </div>
              )}
            </div>
          ) : (
            <button className="btn-login" onClick={() => setIsLoginModalOpen(true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z"/>
              </svg>
              登录
            </button>
          )}
        </div>
      </header>

      {/* Hero 区域 */}
      <div className="hero" onClick={handleShellDismissPanel}>
        <div className="hero-content">
          <h1 className="hero-title">
            <span className="hero-title-greeting">
              Hi，{user ? user.name : ''}
            </span>
            <span className="hero-title-sub">有什么可以帮你的？</span>
          </h1>
          
          {/* 双模式快捷输入栏 */}
          <div className={`hero-search ${isQuickInputFocused ? 'focused' : ''}`}>
            <div className="search-box">
              <span className="search-icon">
                {isAdding ? (
                  <span className="loading-spinner">◌</span>
                ) : isValidUrl(quickInput) ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8"/>
                    <path d="M21 21l-4.35-4.35"/>
                  </svg>
                )}
              </span>
              
              <input
                type="text"
                className="search-input"
                placeholder="粘贴链接快速添加，或输入关键词搜索..."
                value={quickInput}
                onChange={(e) => setQuickInput(e.target.value)}
                onFocus={() => setIsQuickInputFocused(true)}
                onBlur={() => setIsQuickInputFocused(false)}
                onKeyDown={handleQuickInputKeyDown}
              />
              
              {quickInput && (
                <button className="search-clear" onClick={() => setQuickInput('')}>✕</button>
              )}
              
              <button 
                className={`search-submit ${isValidUrl(quickInput) ? 'search-submit-add' : ''}`}
                onClick={handleQuickInputSubmit}
                disabled={isAdding || !quickInput.trim()}
                title={isValidUrl(quickInput) ? '快速添加网站' : '搜索'}
              >
                {isValidUrl(quickInput) ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M12 5v14M5 12h14"/>
                  </svg>
                ) : (
                  '搜索'
                )}
              </button>
            </div>
            
            {/* 输入提示 */}
            <div className="search-hint">
              {isValidUrl(quickInput) ? (
                <span className="hint-url">按回车或点击添加按钮快速收藏该网站</span>
              ) : quickInput ? (
                <span className="hint-search">在 {sites.length} 个网站中搜索 "{quickInput}"</span>
              ) : (
                <span className="hint-default">支持粘贴链接自动识别，或搜索网站名称、备注</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 主内容区 */}
      <div className="main-container" onClick={handleMainDismissPanel}>
        <div className="content-wrapper">
          {/* 分类标签 */}
          <div className="category-tabs">
            {categories.map(cat => {
              const count = getCategoryCount(cat.id)
              const isBuiltin = ['all', 'favorites', 'ungrouped'].includes(cat.id)
              const droppable = isCategoryDroppable(cat.id)
              const dragOver = dragOverCategoryId === cat.id
              const tabClass = `category-tab ${currentCategory === cat.id ? 'active' : ''} ${dragOver ? 'drag-over' : ''}`
              const dropHandlers = droppable ? {
                onDragOver: (e: React.DragEvent) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  setDragOverCategoryId(cat.id)
                },
                onDragLeave: () => setDragOverCategoryId(null),
                onDrop: (e: React.DragEvent) => {
                  e.preventDefault()
                  setDragOverCategoryId(null)
                  const siteId = e.dataTransfer.getData('text/plain')
                  if (siteId?.startsWith('site_')) handleDropToCategory(siteId, cat.id)
                }
              } : {}
              if (isBuiltin) {
                return (
                  <button
                    key={cat.id}
                    className={tabClass}
                    onClick={() => setCurrentCategory(cat.id)}
                    {...dropHandlers}
                  >
                    {cat.name}
                    {count > 0 && <span className="tab-count">{count}</span>}
                  </button>
                )
              }
              return (
                <div key={cat.id} className="category-tab-wrap">
                  <button
                    className={tabClass}
                    onClick={() => setCurrentCategory(cat.id)}
                    {...dropHandlers}
                  >
                    {cat.name}
                    {count > 0 && <span className="tab-count">{count}</span>}
                  </button>
                  <button
                    type="button"
                    className="category-tab-delete"
                    onClick={(e) => handleDeleteCategory(cat.id, e)}
                    title="删除分组"
                  >
                    ×
                  </button>
                </div>
              )
            })}
            {showAddCategory ? (
              <div className="category-add-input-wrap">
                <input
                  className="category-add-input"
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddCategory()
                    if (e.key === 'Escape') {
                      setShowAddCategory(false)
                      setNewCategoryName('')
                    }
                  }}
                  placeholder="分组名称"
                  autoFocus
                />
                <button type="button" className="category-add-confirm" onClick={handleAddCategory}>
                  确认
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="category-add-btn"
                onClick={() => setShowAddCategory(true)}
              >
                + 新建分组
              </button>
            )}
          </div>

          {/* 网站卡片网格 */}
          <div className="sites-grid">
            {filteredSites.length > 0 ? (
              filteredSites.map(site => (
                <div
                  key={site.id}
                  className={`site-card${site.pending ? ' site-card--pending' : ''} ${selectedSite?.id === site.id ? 'selected' : ''} ${dragSiteId === site.id ? 'dragging' : ''} ${dropTargetSiteId === site.id ? 'drop-target' : ''}`}
                  draggable={!site.pending}
                  aria-busy={site.pending || undefined}
                  onClick={() => {
                    if (isDraggingRef.current) return
                    openSitePanel(site)
                  }}
                  onDragStart={(e) => {
                    if (site.pending) return
                    isDraggingRef.current = true
                    setDragSiteId(site.id)
                    e.dataTransfer.setData('text/plain', site.id)
                    e.dataTransfer.effectAllowed = 'move'
                    // 拖拽预览：仅中间 favicon 小方块，非整张卡片
                    const size = 56
                    const wrap = document.createElement('div')
                    wrap.style.cssText = `
                      position:absolute;top:-9999px;left:0;
                      width:${size}px;height:${size}px;
                      border-radius:12px;background:#000;
                      display:flex;align-items:center;justify-content:center;
                      pointer-events:none;opacity:0.92;
                      box-shadow:0 8px 24px rgba(0,0,0,0.35);
                    `
                    const img = document.createElement('img')
                    img.alt = ''
                    img.src = site.favicon
                    img.style.cssText = 'width:40px;height:40px;object-fit:contain;border-radius:8px;'
                    img.onerror = () => {
                      const fb = (() => {
                        try {
                          const h = new URL(
                            site.url.startsWith('http://') || site.url.startsWith('https://')
                              ? site.url
                              : `https://${site.url}`
                          ).hostname
                          return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h)}&sz=128`
                        } catch {
                          return site.favicon
                        }
                      })()
                      if (img.src !== fb) img.src = fb
                      else img.onerror = null
                    }
                    wrap.appendChild(img)
                    document.body.appendChild(wrap)
                    const cx = size / 2
                    e.dataTransfer.setDragImage(wrap, cx, cx)
                    requestAnimationFrame(() => wrap.remove())
                  }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    if (dragSiteId !== site.id) setDropTargetSiteId(site.id)
                  }}
                  onDragLeave={() => {
                    if (dropTargetSiteId === site.id) setDropTargetSiteId(null)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDropTargetSiteId(null)
                    const draggedId = e.dataTransfer.getData('text/plain')
                    if (draggedId && draggedId !== site.id) handleReorder(draggedId, site.id)
                  }}
                  onDragEnd={() => {
                    isDraggingRef.current = false
                    setDragSiteId(null)
                    setDropTargetSiteId(null)
                    setDragOverCategoryId(null)
                  }}
                >
                  {site.pending && (
                    <div className="site-card-pending-overlay" role="status" aria-label="正在添加">
                      <span className="site-card-pending-spinner" aria-hidden />
                    </div>
                  )}
                  <div className="site-icon-area">
                    {/* 模糊背景层 */}
                    <img
                      src={site.favicon}
                      alt=""
                      className="site-favicon-bg"
                      onError={(e) => onSiteFaviconImgError(e, site.url)}
                    />
                    {/* 居中清晰图标层 */}
                    <img 
                      src={site.favicon} 
                      alt="" 
                      className="site-favicon"
                      onError={(e) => onSiteFaviconImgError(e, site.url)}
                    />
                  </div>
                  
                  <div className="site-info">
                    <h3 className="site-name">{site.name}</h3>
                    <p
                      className="site-domain"
                      title={site.pending ? undefined : site.url}
                    >
                      {site.pending ? '正在添加…' : getDisplayUrl(site.url)}
                    </p>
                    {site.tags && site.tags.length > 0 && (
                      <div className="site-tags" aria-label="标签">
                        {site.tags.slice(0, 4).map((t) => (
                          <span key={t} className="site-tag">
                            {t}
                          </span>
                        ))}
                        {site.tags.length > 4 && (
                          <span className="site-tag site-tag-more">+{site.tags.length - 4}</span>
                        )}
                      </div>
                    )}
                    {site.description && (
                      <p className="site-description">{site.description}</p>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-state">
                <div className="empty-icon">◈</div>
                <p className="empty-title">
                  {quickInput ? '没有找到匹配的网站' : '还没有网站'}
                </p>
                <p className="empty-subtitle">
                  {quickInput 
                    ? '尝试其他关键词，或粘贴链接添加新网站' 
                    : '在上方输入框粘贴链接，开始收藏你的第一个网站'}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 右侧详情面板：非模态，点左侧空白关闭，点卡片仅切换内容 */}
      {selectedSite && (
        <div
          className={`side-panel ${isPanelOpen ? 'open' : ''}`}
          role="dialog"
          aria-modal="false"
          aria-labelledby="panel-site-name"
        >
          {/* 面板头部 */}
          <div className="panel-header">
            <button type="button" className="panel-close" onClick={closePanel} aria-label="关闭">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
            <div className="panel-actions">
              <button
                type="button"
                className={`panel-action-btn panel-action-btn-icon-only ${selectedSite.isFavorite ? 'panel-action-favorite active' : 'panel-action-favorite'}`}
                onClick={toggleFavorite}
                title={selectedSite.isFavorite ? '取消收藏' : '收藏'}
                aria-label={selectedSite.isFavorite ? '取消收藏' : '收藏'}
              >
                <svg viewBox="0 0 24 24" fill={selectedSite.isFavorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"/>
                </svg>
              </button>
              <button
                type="button"
                className="panel-action-btn panel-action-btn-icon-only"
                onClick={copyLink}
                title="复制链接"
                aria-label="复制链接"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                </svg>
              </button>
              <a
                href={selectedSite.url}
                target="_blank"
                rel="noopener noreferrer"
                className="panel-action-btn primary"
                onClick={() => recordSiteLinkVisit(selectedSite.id)}
                onAuxClick={(e) => {
                  if (e.button === 1) recordSiteLinkVisit(selectedSite.id)
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
                </svg>
                访问
              </a>
              <button type="button" className="panel-action-btn panel-action-delete" onClick={() => setConfirmDeleteSite(selectedSite)} title="删除">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                </svg>
              </button>
            </div>
          </div>

            {/* 面板内容：上方可滚动，统计固定在底部 */}
            <div className="panel-content">
              <div className="panel-scroll-block">
              <div className="panel-site-header">
                <img
                  src={selectedSite.favicon}
                  alt=""
                  className="panel-favicon"
                  onError={(e) => onSiteFaviconImgError(e, selectedSite.url)}
                />
                <div className="panel-site-info">
                  <h2 id="panel-site-name" className="panel-site-name">{selectedSite.name}</h2>
                  <p className="panel-site-url" title={selectedSite.url}>{getDisplayUrl(selectedSite.url)}</p>
                </div>
              </div>

              {selectedSite.description ? (
                <p className="panel-description">{selectedSite.description}</p>
              ) : (
                <p className="panel-description muted">暂无描述</p>
              )}

              {/* 分类（可编辑）：自定义下拉，避免系统原生列表错位与样式不可控 */}
              <div className="panel-section panel-section-category">
                <label className="panel-label" id="panel-category-label">
                  分组
                </label>
                <PanelCategorySelect
                  ref={panelCategoryRef}
                  options={panelCategoryOptions}
                  value={selectedSite.category}
                  open={isPanelCategoryOpen}
                  onOpenChange={setIsPanelCategoryOpen}
                  onChange={handleCategoryChange}
                />
              </div>

              {/* AI：同类网站 / 资讯资料 / 产品总结 — 同一组标签页切换 */}
              <div className="panel-section panel-section-ai">
                <div className="panel-label" id="panel-ai-label">
                  智能助手
                </div>
                <div className="ai-feature-card">
                  <div
                    className="ai-tab-bar"
                    role="tablist"
                    aria-labelledby="panel-ai-label"
                  >
                    <button
                      type="button"
                      role="tab"
                      id="ai-tab-more"
                      tabIndex={aiPanelTab === 'more' ? 0 : -1}
                      aria-selected={aiPanelTab === 'more'}
                      aria-controls="ai-panel-more"
                      className={`ai-tab${aiPanelTab === 'more' ? ' is-active' : ''}`}
                      onClick={() => { setAiPanelTab('more'); focusAiTabButton('more') }}
                      onKeyDown={(e) => handleAiPanelTabKeyDown(e, 'more')}
                    >
                      同类网站
                    </button>
                    <button
                      type="button"
                      role="tab"
                      id="ai-tab-resource"
                      tabIndex={aiPanelTab === 'resource' ? 0 : -1}
                      aria-selected={aiPanelTab === 'resource'}
                      aria-controls="ai-panel-resource"
                      className={`ai-tab${aiPanelTab === 'resource' ? ' is-active' : ''}`}
                      onClick={() => { setAiPanelTab('resource'); focusAiTabButton('resource') }}
                      onKeyDown={(e) => handleAiPanelTabKeyDown(e, 'resource')}
                    >
                      学习库
                    </button>
                    <button
                      type="button"
                      role="tab"
                      id="ai-tab-summary"
                      tabIndex={aiPanelTab === 'summary' ? 0 : -1}
                      aria-selected={aiPanelTab === 'summary'}
                      aria-controls="ai-panel-summary"
                      className={`ai-tab${aiPanelTab === 'summary' ? ' is-active' : ''}`}
                      onClick={() => { setAiPanelTab('summary'); focusAiTabButton('summary') }}
                      onKeyDown={(e) => handleAiPanelTabKeyDown(e, 'summary')}
                    >
                      产品总结
                    </button>
                  </div>
                  {user && !kimiKeyConfigured && (
                    <p className="ai-feature-hint">请前往头像 → API 设置中配置 Kimi Key</p>
                  )}

                  {aiPanelTab === 'more' && (
                    <div
                      id="ai-panel-more"
                      role="tabpanel"
                      aria-labelledby="ai-tab-more"
                      className="ai-tab-panel ai-tab-panel--more"
                    >
                      {/* 已保存的同类网站列表 */}
                      {selectedSite && hasSavedSimilarForMoreTab && (
                        <div className="ai-saved-similar-section">
                          <div className="ai-saved-similar-header">
                            <span className="ai-result-title ai-result-title--text-only">
                              已保存的同类网站
                            </span>
                            <AiSimilarSearchOrPauseButton
                              busy={aiLoading === 'similar'}
                              userOk={!!user}
                              kimiOk={kimiKeyConfigured}
                              aiLoading={aiLoading}
                              onRun={handleAiSimilar}
                              onPause={cancelAiSimilarRequest}
                              className="ai-saved-search-more-btn"
                              titleRun="用 AI 搜索更多同类网站"
                              titlePause="暂停搜索"
                              ariaRun="搜索更多网站"
                              ariaPause="暂停搜索"
                              idleContent={
                                <>
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="ai-saved-search-more-btn-icon">
                                    <circle cx="11" cy="11" r="8"/>
                                    <path d="M21 21l-4.3-4.3"/>
                                  </svg>
                                  <span className="ai-saved-search-more-btn-text">搜索更多网站</span>
                                </>
                              }
                            />
                          </div>
                          <div className="ai-saved-similar-body">
                            <div
                              className={`ai-saved-similar-list-host${aiLoading === 'similar' && aiSimilarSites !== null ? ' is-refreshing' : ''}`}
                            >
                              {aiLoading === 'similar' && aiSimilarSites !== null && (
                                <AiSimilarRefreshOverlay
                                  embedded
                                  rowCount={
                                    aiSimilarSites.length === 0
                                      ? 1
                                      : Math.min(aiSimilarSites.length, 10)
                                  }
                                />
                              )}
                              <div className="ai-similar-list ai-similar-list--saved">
                              {aiLoading === 'similar' && aiSimilarSites === null ? (
                                Array.from({ length: 5 }, (_, i) => i).map((i) => (
                                  <div key={i} className="ai-similar-card ai-similar-card--saved">
                                    <div className="ai-skeleton ai-skeleton-icon" style={{ width: 22, height: 22, borderRadius: 5, flexShrink: 0 }} />
                                    <div className="ai-skeleton-lines" style={{ flex: 1, minWidth: 0 }}>
                                      <div className="ai-skeleton ai-skeleton-line-long" />
                                      <div className="ai-skeleton ai-skeleton-line-short" />
                                    </div>
                                  </div>
                                ))
                              ) : aiSimilarSites !== null ? (
                                aiSimilarSites.length === 0 ? (
                                  <p className="ai-similar-empty-hint ai-similar-empty-hint--in-saved">
                                    本次推荐均已收录于导航，可稍后再试「搜索更多网站」。
                                  </p>
                                ) : (
                                  aiSimilarSites.map((site) => {
                                    const rowNorm = resolveSimilarSiteUrl(site.url).replace(/\/$/, '')
                                    const alreadyAdded = sites.some(
                                      (s) => !s.pending && s.url.replace(/\/$/, '') === rowNorm
                                    )
                                    const isAdding =
                                      addingSingleSiteUrl === site.url ||
                                      sites.some((s) => s.pending && s.url.replace(/\/$/, '') === rowNorm)
                                    return (
                                      <div key={site.url} className="ai-similar-card ai-similar-card--saved">
                                        <img
                                          src={`https://www.google.com/s2/favicons?domain=${new URL(site.url.startsWith('http') ? site.url : 'https://' + site.url).hostname}&sz=32`}
                                          alt=""
                                          className="ai-similar-favicon"
                                          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                                        />
                                        <div className="ai-similar-info">
                                          <span className="ai-similar-name">{site.name}</span>
                                          <span className="ai-similar-reason">{site.reason}</span>
                                        </div>
                                        <div className="ai-similar-actions">
                                          <button
                                            type="button"
                                            className={`ai-similar-add-btn${alreadyAdded ? ' added' : ''}${isAdding ? ' is-loading' : ''}`}
                                            disabled={alreadyAdded || isAdding || addingSingleSiteUrl !== null}
                                            onClick={() => void handleAddSingleAiSite(site)}
                                            title={alreadyAdded ? '已添加到导航' : isAdding ? '正在添加…' : '添加到导航'}
                                            aria-label={alreadyAdded ? '已添加到导航' : isAdding ? '正在添加' : '添加到导航'}
                                          >
                                            <AiSimilarNavAddIcons alreadyAdded={alreadyAdded} isAdding={isAdding} />
                                          </button>
                                        </div>
                                      </div>
                                    )
                                  })
                                )
                              ) : (
                                savedSimilarForMoreTab.map(site => {
                                  const rowNorm = resolveSimilarSiteUrl(site.url).replace(/\/$/, '')
                                  const alreadyAdded = sites.some(
                                    (s) => !s.pending && s.url.replace(/\/$/, '') === rowNorm
                                  )
                                  const isAdding =
                                    addingSingleSiteUrl === site.url ||
                                    sites.some((s) => s.pending && s.url.replace(/\/$/, '') === rowNorm)
                                  return (
                                    <div
                                      key={site.url}
                                      className={`ai-similar-card ai-similar-card--saved${dragSavedSimilarUrl === site.url ? ' is-dragging' : ''}${dropTargetSavedSimilarUrl === site.url ? ' is-drop-target' : ''}`}
                                      onDragOver={(e) => {
                                        if (!dragSavedSimilarUrl) return
                                        e.preventDefault()
                                        e.dataTransfer.dropEffect = 'move'
                                        if (dragSavedSimilarUrl !== site.url) {
                                          setDropTargetSavedSimilarUrl(site.url)
                                        }
                                      }}
                                      onDragLeave={(e) => {
                                        if (e.currentTarget.contains(e.relatedTarget as Node)) return
                                        if (dropTargetSavedSimilarUrl === site.url) {
                                          setDropTargetSavedSimilarUrl(null)
                                        }
                                      }}
                                      onDrop={(e) => {
                                        e.preventDefault()
                                        const draggedUrl = e.dataTransfer.getData('text/plain')
                                        if (draggedUrl && draggedUrl !== site.url) {
                                          handleReorderSavedSimilar(draggedUrl, site.url)
                                        }
                                        setDragSavedSimilarUrl(null)
                                        setDropTargetSavedSimilarUrl(null)
                                      }}
                                    >
                                      <div
                                        className="ai-similar-card-drag-handle"
                                        draggable
                                        onDragStart={(e) => {
                                          e.dataTransfer.setData('text/plain', site.url)
                                          e.dataTransfer.effectAllowed = 'move'
                                          setDragSavedSimilarUrl(site.url)
                                        }}
                                        onDragEnd={() => {
                                          setDragSavedSimilarUrl(null)
                                          setDropTargetSavedSimilarUrl(null)
                                        }}
                                        title="拖动排序"
                                        role="button"
                                        tabIndex={0}
                                        aria-label="拖动排序"
                                      >
                                        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="ai-similar-card-drag-handle-icon">
                                          <circle cx="9" cy="6" r="1.75"/>
                                          <circle cx="15" cy="6" r="1.75"/>
                                          <circle cx="9" cy="12" r="1.75"/>
                                          <circle cx="15" cy="12" r="1.75"/>
                                          <circle cx="9" cy="18" r="1.75"/>
                                          <circle cx="15" cy="18" r="1.75"/>
                                        </svg>
                                      </div>
                                      <img
                                        src={`https://www.google.com/s2/favicons?domain=${new URL(site.url.startsWith('http') ? site.url : 'https://' + site.url).hostname}&sz=32`}
                                        alt=""
                                        className="ai-similar-favicon"
                                        onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                                      />
                                      <div className="ai-similar-info">
                                        <span className="ai-similar-name">{site.name}</span>
                                        <span className="ai-similar-reason">{site.reason}</span>
                                      </div>
                                      <div className="ai-similar-actions">
                                        <button
                                          type="button"
                                          className={`ai-similar-add-btn${alreadyAdded ? ' added' : ''}${isAdding ? ' is-loading' : ''}`}
                                          disabled={alreadyAdded || isAdding || addingSingleSiteUrl !== null}
                                          onClick={() => void handleAddSingleAiSite(site)}
                                          title={alreadyAdded ? '已添加到导航' : isAdding ? '正在添加…' : '添加到导航'}
                                          aria-label={alreadyAdded ? '已添加到导航' : isAdding ? '正在添加' : '添加到导航'}
                                        >
                                          <AiSimilarNavAddIcons alreadyAdded={alreadyAdded} isAdding={isAdding} />
                                        </button>
                                        <button
                                          type="button"
                                          className="ai-similar-remove-btn"
                                          onClick={() => handleRemoveSimilarFromMore(site.url)}
                                          title="从列表移除"
                                          aria-label="移除"
                                        >
                                          <svg className="ai-similar-remove-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                                            <path d="M18 6L6 18M6 6l12 12"/>
                                          </svg>
                                        </button>
                                      </div>
                                    </div>
                                  )
                                })
                              )}
                            </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* 无已保存时：全宽发现按钮；有已保存时入口在标题行右侧 */}
                      {!hasSavedSimilarForMoreTab && (
                        <div className="ai-more-discovery-wrap">
                          <AiSimilarSearchOrPauseButton
                            busy={aiLoading === 'similar'}
                            userOk={!!user}
                            kimiOk={kimiKeyConfigured}
                            aiLoading={aiLoading}
                            onRun={handleAiSimilar}
                            onPause={cancelAiSimilarRequest}
                            className="ai-feature-btn ai-feature-btn--block ai-more-discovery-btn"
                            titleRun="发现同类优质网站"
                            titlePause="暂停搜索"
                            ariaRun="发现同类网站"
                            ariaPause="暂停搜索"
                            idleContent={
                              <>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                                  <path d="M23 4v6h-6M1 20v-6h6"/>
                                  <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                                </svg>
                                <span>发现同类网站</span>
                              </>
                            }
                          />
                          <p className="ai-more-hint">
                            AI 会先给出较多候选，排除导航中已有链接后展示最多 10 条；结果会自动存为当前站点的「已保存同类网站」最新列表。
                          </p>
                        </div>
                      )}

                      {/* 首次发现加载骨架（无已保存列表且尚无本次结果时，避免与下方结果区重复一张卡片） */}
                      {aiLoading === 'similar' && aiSimilarSites === null && !hasSavedSimilarForMoreTab && (
                        <div className="ai-result-section">
                          <div className="ai-result-header">
                            <span className="ai-result-title">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                                <path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z"/>
                              </svg>
                              正在发现同类优质网站…
                            </span>
                          </div>
                          <p className="ai-loading-hint">
                            请求在后台仍会继续；若暂时切走窗口，部分浏览器会延缓进度，回到本页后稍候即可。大模型耗时通常需数十秒。
                          </p>
                          <div className="ai-skeleton-list">
                            {Array.from({ length: 10 }, (_, i) => i + 1).map(i => (
                              <div key={i} className="ai-skeleton-item">
                                <div className="ai-skeleton ai-skeleton-icon" />
                                <div className="ai-skeleton-lines">
                                  <div className="ai-skeleton ai-skeleton-line-long" />
                                  <div className="ai-skeleton ai-skeleton-line-short" />
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* AI 发现结果（仅无已保存列表时单独成卡；再次搜索在同一卡片内刷新） */}
                      {!hasSavedSimilarForMoreTab && aiSimilarSites !== null && (
                        <div className="ai-result-section">
                          <div className="ai-result-header">
                            <span className="ai-result-title">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                                <path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z"/>
                              </svg>
                              AI 发现同类优质网站
                            </span>
                            <div className="ai-result-header-actions">
                              <AiSimilarSearchOrPauseButton
                                busy={aiLoading === 'similar'}
                                userOk={!!user}
                                kimiOk={kimiKeyConfigured}
                                aiLoading={aiLoading}
                                onRun={handleAiSimilar}
                                onPause={cancelAiSimilarRequest}
                                className="ai-saved-search-more-btn"
                                titleRun="用 AI 搜索更多同类网站"
                                titlePause="暂停搜索"
                                ariaRun="搜索更多网站"
                                ariaPause="暂停搜索"
                                idleContent={
                                  <>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="ai-saved-search-more-btn-icon">
                                      <circle cx="11" cy="11" r="8"/>
                                      <path d="M21 21l-4.3-4.3"/>
                                    </svg>
                                    <span className="ai-saved-search-more-btn-text">搜索更多网站</span>
                                  </>
                                }
                              />
                              <button
                                type="button"
                                className="ai-result-close"
                                onClick={clearAiSimilarOnly}
                                aria-label="关闭"
                              >×</button>
                            </div>
                          </div>
                          <div
                            className={`ai-similar-list ai-similar-list--standalone-wrap${aiLoading === 'similar' ? ' is-refreshing' : ''}`}
                          >
                            {aiLoading === 'similar' && (
                              <AiSimilarRefreshOverlay
                                rowCount={
                                  aiSimilarSites.length === 0
                                    ? 1
                                    : Math.min(aiSimilarSites.length, 10)
                                }
                              />
                            )}
                            {aiSimilarSites.length === 0 ? (
                              <p className="ai-similar-empty-hint">
                                本次推荐均已收录于导航，可点击「搜索更多网站」再试。
                              </p>
                            ) : (
                              aiSimilarSites.map(site => {
                                const rowNorm = resolveSimilarSiteUrl(site.url).replace(/\/$/, '')
                                const alreadyAdded = sites.some(
                                  (s) => !s.pending && s.url.replace(/\/$/, '') === rowNorm
                                )
                                const isAdding =
                                  addingSingleSiteUrl === site.url ||
                                  sites.some((s) => s.pending && s.url.replace(/\/$/, '') === rowNorm)
                                return (
                                  <div key={site.url} className="ai-similar-card">
                                    <img
                                      src={`https://www.google.com/s2/favicons?domain=${new URL(site.url.startsWith('http') ? site.url : 'https://' + site.url).hostname}&sz=32`}
                                      alt=""
                                      className="ai-similar-favicon"
                                      onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                                    />
                                    <div className="ai-similar-info">
                                      <span className="ai-similar-name">{site.name}</span>
                                      <span className="ai-similar-reason">{site.reason}</span>
                                    </div>
                                    <button
                                      type="button"
                                      className={`ai-similar-add-btn${alreadyAdded ? ' added' : ''}${isAdding ? ' is-loading' : ''}`}
                                      disabled={alreadyAdded || isAdding || addingSingleSiteUrl !== null}
                                      onClick={() => void handleAddSingleAiSite(site)}
                                      title={alreadyAdded ? '已添加到导航' : isAdding ? '正在添加…' : '添加到导航'}
                                      aria-label={alreadyAdded ? '已添加到导航' : isAdding ? '正在添加' : '添加到导航'}
                                    >
                                      <AiSimilarNavAddIcons alreadyAdded={alreadyAdded} isAdding={isAdding} />
                                    </button>
                                  </div>
                                )
                              })
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {aiPanelTab === 'resource' && (
                    <div
                      id="ai-panel-resource"
                      role="tabpanel"
                      aria-labelledby="ai-tab-resource"
                      className="ai-tab-panel"
                    >
                      {/* 空状态：尚无学习库（其他 AI 任务进行中时单独提示，避免面板空白） */}
                      {!aiResources && !aiLoading && (
                        <div className="ai-summary-trigger-row">
                          <span className="ai-summary-empty-hint">点击获取 AI 推荐资料，或手动添加链接</span>
                          <div className="ai-library-empty-actions">
                            <button
                              type="button"
                              className="ai-summary-trigger-btn"
                              onClick={handleAiResource}
                              disabled={!user || !kimiKeyConfigured || aiLoading !== null}
                              title={!user ? '请先登录' : !kimiKeyConfigured ? '请在「设置」中配置 Kimi API Key' : '获取 AI 推荐资料'}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                                <path d="M4 19.5A2.5 2.5 0 016.5 17H20"/>
                                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>
                                <path d="M8 7h8M8 11h8M8 15h5"/>
                              </svg>
                              获取 AI 推荐资料
                            </button>
                            <button
                              type="button"
                              className="ai-library-manual-add-entry"
                              onClick={() => {
                                persistAiResourceForSite(selectedSite!.id, { version: 1, summary: '', links: [] })
                                setShowAddLinkForm(true)
                              }}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                                <path d="M12 5v14M5 12h14"/>
                              </svg>
                              手动添加链接
                            </button>
                          </div>
                        </div>
                      )}
                      {!aiResources && aiLoading && aiLoading !== 'resource' && (
                        <div className="ai-cross-tab-hint" role="status">
                          <p>
                            当前正在进行「{AI_LOADING_TAB_LABEL[aiLoading]}」的 AI 请求。学习库暂无数据时可先到该标签查看进度。
                          </p>
                          <button
                            type="button"
                            className="ai-cross-tab-hint-btn"
                            onClick={() => setAiPanelTab(aiLoadingKindToPanelTab(aiLoading))}
                          >
                            切换到{AI_LOADING_TAB_LABEL[aiLoading]}
                          </button>
                        </div>
                      )}
                      {/* 加载中 */}
                      {aiLoading === 'resource' && (
                        <div className="ai-result-section">
                          <div className="ai-result-header">
                            <span className="ai-result-title">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                                <path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z"/>
                              </svg>
                              正在获取 AI 推荐资料…
                            </span>
                            <div className="ai-result-header-actions">
                              <button
                                type="button"
                                className="ai-result-regen"
                                onClick={cancelAiResourceRequest}
                                title="暂停（取消本次请求）"
                                aria-label="暂停"
                              >
                                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                                  <rect x="6" y="5" width="4" height="14" rx="1"/>
                                  <rect x="14" y="5" width="4" height="14" rx="1"/>
                                </svg>
                              </button>
                            </div>
                          </div>
                          <p className="ai-loading-hint">
                            请求在后台仍会继续；若暂时切走窗口，部分浏览器会延缓进度，回到本页后稍候即可。大模型耗时通常需数十秒。
                          </p>
                          <div className="ai-skeleton-list">
                            {[1, 2, 3, 4, 5].map(i => (
                              <div key={i} className="ai-skeleton-item">
                                <div className="ai-skeleton ai-skeleton-icon" />
                                <div className="ai-skeleton-lines">
                                  <div className="ai-skeleton ai-skeleton-line-long" />
                                  <div className="ai-skeleton ai-skeleton-line-short" />
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {/* 学习库内容（同类/总结加载中仍可浏览已缓存的学习库） */}
                      {aiResources && aiLoading !== 'resource' && (
                        <div className="ai-result-section">
                          {aiLoading && (
                            <div className="ai-cross-tab-banner" role="status">
                              <span>
                                正在进行「{AI_LOADING_TAB_LABEL[aiLoading]}」的 AI 请求，可切换到该标签查看进度。
                              </span>
                              <button
                                type="button"
                                className="ai-cross-tab-banner-btn"
                                onClick={() => setAiPanelTab(aiLoadingKindToPanelTab(aiLoading))}
                              >
                                前往
                              </button>
                            </div>
                          )}
                          <div className="ai-result-header">
                            <span className="ai-result-title">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                                <path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z"/>
                              </svg>
                              学习库
                            </span>
                            <div className="ai-result-header-actions">
                              <button
                                type="button"
                                className="ai-result-regen"
                                onClick={handleDownloadLibraryMarkdown}
                                title="下载学习库 Markdown"
                                aria-label="下载"
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                                  <polyline points="7 10 12 15 17 10"/>
                                  <line x1="12" y1="15" x2="12" y2="3"/>
                                </svg>
                              </button>
                              <button
                                type="button"
                                className="ai-result-regen"
                                onClick={handleRegenerateResourceClick}
                                disabled={!user || !kimiKeyConfigured || aiLoading !== null}
                                title={!user ? '请先登录' : !kimiKeyConfigured ? '请在「设置」中配置 Kimi API Key' : '重新获取 AI 推荐资料（手动链接保留）'}
                                aria-label="重新获取 AI 推荐资料"
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                  <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
                                  <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                                </svg>
                              </button>
                              <button
                                type="button"
                                className="ai-result-regen"
                                onClick={() => setConfirmDismissAiResources(true)}
                                title="删除学习库"
                                aria-label="删除学习库"
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                  <polyline points="3 6 5 6 21 6"/>
                                  <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                                  <path d="M10 11v6M14 11v6"/>
                                  <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
                                </svg>
                              </button>
                            </div>
                          </div>

                          {/* 链接列表：标题行右侧为搜索图标 + 添加；表单与网络搜索在链接卡片下方展开 */}
                          <div className="ai-summary-block ai-summary-block--resource-cards">
                            <div className="ai-library-links-header">
                              <div className="ai-summary-section-label ai-library-links-heading">
                                链接 ({aiResources.links.length})
                              </div>
                              <div className="ai-library-links-actions">
                                <button
                                  type="button"
                                  className={`ai-library-header-icon-btn${showBraveSearch ? ' is-active' : ''}`}
                                  onClick={() => setShowBraveSearch((v) => !v)}
                                  title="搜索网络"
                                  aria-label="搜索网络"
                                  aria-expanded={showBraveSearch}
                                >
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                    <circle cx="11" cy="11" r="8"/>
                                    <path d="M21 21l-4.3-4.3"/>
                                  </svg>
                                </button>
                                <button
                                  type="button"
                                  className={`ai-library-header-icon-btn${showAddLinkForm ? ' is-active' : ''}`}
                                  onClick={() => setShowAddLinkForm((v) => !v)}
                                  title="手动添加链接"
                                  aria-label="手动添加链接"
                                  aria-expanded={showAddLinkForm}
                                >
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
                                    <path d="M12 5v14M5 12h14"/>
                                  </svg>
                                </button>
                              </div>
                            </div>

                            {showAddLinkForm && (
                              <div className="ai-library-add-form ai-library-add-form--under-links">
                                <input
                                  type="url"
                                  className="ai-library-add-input"
                                  placeholder="网址（必填）"
                                  value={newLinkUrl}
                                  onChange={e => setNewLinkUrl(e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') handleAddLibraryLink() }}
                                  autoFocus
                                />
                                <input
                                  type="text"
                                  className="ai-library-add-input"
                                  placeholder="标题（可选，默认用网址）"
                                  value={newLinkTitle}
                                  onChange={e => setNewLinkTitle(e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') handleAddLibraryLink() }}
                                />
                                <input
                                  type="text"
                                  className="ai-library-add-input"
                                  placeholder="备注（可选）"
                                  value={newLinkNote}
                                  onChange={e => setNewLinkNote(e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') handleAddLibraryLink() }}
                                />
                                <div className="ai-library-add-form-actions">
                                  <button type="button" className="ai-result-btn" onClick={handleAddLibraryLink}>
                                    加入学习库
                                  </button>
                                  <button type="button" className="btn-secondary" onClick={() => { setShowAddLinkForm(false); setNewLinkUrl(''); setNewLinkTitle(''); setNewLinkNote('') }}>
                                    取消
                                  </button>
                                </div>
                              </div>
                            )}

                            {aiResources.links.length === 0 && (
                              <p className="ai-summary-text ai-library-links-empty-hint">
                                学习库为空，点击右侧「+」添加链接，或点放大镜搜索网络
                              </p>
                            )}
                            <div className="ai-resource-cards">
                              {libraryOrderedLinks.map((link) => {
                                const raw = link.url.trim()
                                let href = raw
                                if (href && !href.startsWith('http://') && !href.startsWith('https://')) {
                                  href = `https://${href}`
                                }
                                let host = ''
                                try {
                                  if (href) host = new URL(href).hostname.replace(/^www\./, '')
                                } catch { host = '' }
                                const sourceLabel = link.source === 'manual' ? '手动' : link.source === 'search' ? '搜索' : 'AI'
                                const sourceClass = link.source === 'manual' ? 'ai-resource-card-source--manual' : link.source === 'search' ? 'ai-resource-card-source--search' : 'ai-resource-card-source--ai'
                                const cardContent = (
                                  <>
                                    {host ? (
                                      <img
                                        src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`}
                                        alt=""
                                        className="ai-resource-card-favicon"
                                        onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden' }}
                                      />
                                    ) : (
                                      <span className="ai-resource-card-favicon ai-resource-card-favicon--placeholder" aria-hidden />
                                    )}
                                    <div className="ai-resource-card-body">
                                      <div className="ai-resource-card-title-row">
                                        <span className="ai-resource-card-title">{link.title || host || '链接'}</span>
                                        <span className={`ai-resource-card-source ${sourceClass}`}>{sourceLabel}</span>
                                      </div>
                                      <span className="ai-resource-card-url" title={raw || undefined}>
                                        {host || raw || '—'}
                                      </span>
                                      {link.note && (
                                        <span className="ai-resource-card-note">{link.note}</span>
                                      )}
                                    </div>
                                    <button
                                      type="button"
                                      className="ai-resource-card-delete"
                                      onClick={e => { e.preventDefault(); e.stopPropagation(); handleDeleteLibraryLink(link.url) }}
                                      title="从学习库移除"
                                      aria-label="删除"
                                    >
                                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                                        <path d="M18 6L6 18M6 6l12 12"/>
                                      </svg>
                                    </button>
                                  </>
                                )
                                return href ? (
                                  <a
                                    key={link.url}
                                    href={href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="ai-resource-card"
                                  >
                                    {cardContent}
                                  </a>
                                ) : (
                                  <div key={link.url} className="ai-resource-card ai-resource-card--static">
                                    {cardContent}
                                  </div>
                                )
                              })}
                            </div>

                            {showBraveSearch && (
                              <div className="ai-library-brave-panel">
                                {!braveKeyConfigured && (
                                  <p className="ai-library-brave-no-key">
                                    搜索网络需要配置 Brave Search API Key。
                                    <button
                                      type="button"
                                      className="ai-library-brave-no-key-link"
                                      onClick={() => setIsApiSettingsOpen(true)}
                                    >
                                      前往设置
                                    </button>
                                  </p>
                                )}
                                {braveKeyConfigured && (
                                  <div className="ai-library-brave-form">
                                    <input
                                      type="search"
                                      className="ai-library-brave-input"
                                      placeholder="搜索关键词（将结合网站名一起搜索）"
                                      value={braveSearchQuery}
                                      onChange={(e) => setBraveSearchQuery(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') void handleBraveSearch()
                                      }}
                                      autoFocus
                                    />
                                    <button
                                      type="button"
                                      className="ai-result-btn"
                                      onClick={() => void handleBraveSearch()}
                                      disabled={isBraveSearchLoading || !braveSearchQuery.trim()}
                                    >
                                      {isBraveSearchLoading ? '搜索中…' : '搜索'}
                                    </button>
                                  </div>
                                )}
                                {braveKeyConfigured && isBraveSearchLoading && (
                                  <div className="ai-library-brave-loading">
                                    <div className="ai-skeleton-list">
                                      {[1, 2, 3].map((i) => (
                                        <div key={i} className="ai-skeleton-item">
                                          <div className="ai-skeleton ai-skeleton-icon" />
                                          <div className="ai-skeleton-lines">
                                            <div className="ai-skeleton ai-skeleton-line-long" />
                                            <div className="ai-skeleton ai-skeleton-line-short" />
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                                {braveKeyConfigured && !isBraveSearchLoading && braveSearchResults.length > 0 && (
                                  <div className="ai-library-brave-results">
                                    {braveSearchResults.map((item, i) => (
                                      <div key={i} className="ai-library-brave-item">
                                        <div className="ai-library-brave-item-body">
                                          <a
                                            href={item.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="ai-library-brave-item-title"
                                          >
                                            {item.title}
                                          </a>
                                          {item.description && <p className="ai-library-brave-item-desc">{item.description}</p>}
                                          <span className="ai-library-brave-item-url">{item.url}</span>
                                        </div>
                                        <button
                                          type="button"
                                          className="ai-library-brave-add-btn"
                                          onClick={() => handleAddBraveResultToLibrary(item)}
                                          title="加入学习库"
                                        >
                                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
                                            <path d="M12 5v14M5 12h14"/>
                                          </svg>
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {braveKeyConfigured &&
                                  !isBraveSearchLoading &&
                                  braveSearchQuery &&
                                  braveSearchResults.length === 0 && (
                                    <p className="ai-library-brave-empty">暂无结果</p>
                                  )}
                              </div>
                            )}
                          </div>

                          {/* 保存到备注 */}
                          {selectedSite && !resourceNotesSavedIds.has(selectedSite.id) && (
                            <div className="ai-result-footer">
                              <button type="button" className="ai-result-btn" onClick={handleSaveResourcesToNotes}>
                                保存
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {aiPanelTab === 'summary' && (
                    <div
                      id="ai-panel-summary"
                      role="tabpanel"
                      aria-labelledby="ai-tab-summary"
                      className="ai-tab-panel ai-tab-panel--summary"
                    >
                      {!aiSummary && !aiLoading && (
                        <div className="ai-more-discovery-wrap">
                          <button
                            type="button"
                            className="ai-feature-btn ai-feature-btn--block ai-more-discovery-btn"
                            onClick={() => void handleAiSummary()}
                            disabled={!user || !kimiKeyConfigured || aiLoading !== null}
                            title={!user ? '请先登录' : !kimiKeyConfigured ? '请在「设置」中配置 Kimi API Key' : '深度总结网站产品与技术'}
                            aria-label={!user ? '请先登录' : !kimiKeyConfigured ? '请在设置中配置 Kimi API Key' : '生成深度总结'}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                              <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>
                            </svg>
                            <span>生成深度总结</span>
                          </button>
                          <p className="ai-more-hint">
                            AI 将分析该网站的产品定位、功能与视觉特征等，生成结构化总结；可写入备注或导出 Skill。大模型耗时通常需数十秒。
                          </p>
                        </div>
                      )}
                      {!aiSummary && aiLoading && aiLoading !== 'summary' && (
                        <div className="ai-cross-tab-hint" role="status">
                          <p>
                            当前正在进行「{AI_LOADING_TAB_LABEL[aiLoading]}」的 AI 请求。生成产品总结请待该任务结束后再试，或先切换到对应标签查看进度。
                          </p>
                          <button
                            type="button"
                            className="ai-cross-tab-hint-btn"
                            onClick={() => setAiPanelTab(aiLoadingKindToPanelTab(aiLoading))}
                          >
                            切换到{AI_LOADING_TAB_LABEL[aiLoading]}
                          </button>
                        </div>
                      )}
                      {aiLoading === 'summary' && (
                        <div className="ai-result-section">
                          <div className="ai-result-header">
                            <span className="ai-result-title">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                                <path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z"/>
                              </svg>
                              正在深度总结网站…
                            </span>
                            <div className="ai-result-header-actions">
                              <button
                                type="button"
                                className="ai-result-regen"
                                onClick={cancelAiSummaryRequest}
                                title="暂停（取消本次请求）"
                                aria-label="暂停"
                              >
                                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                                  <rect x="6" y="5" width="4" height="14" rx="1"/>
                                  <rect x="14" y="5" width="4" height="14" rx="1"/>
                                </svg>
                              </button>
                            </div>
                          </div>
                          <p className="ai-loading-hint">
                            请求在后台仍会继续；若暂时切走窗口，部分浏览器会延缓进度，回到本页后稍候即可。大模型耗时通常需数十秒。
                          </p>
                          <div className="ai-skeleton-list">
                            {[1, 2, 3, 4, 5].map(i => (
                              <div key={i} className="ai-skeleton-item">
                                <div className="ai-skeleton ai-skeleton-icon" />
                                <div className="ai-skeleton-lines">
                                  <div className="ai-skeleton ai-skeleton-line-long" />
                                  <div className="ai-skeleton ai-skeleton-line-short" />
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {aiSummaryDisplay && aiLoading !== 'summary' && (
                        <div className="ai-result-section">
                          {aiLoading && (
                            <div className="ai-cross-tab-banner" role="status">
                              <span>
                                正在进行「{AI_LOADING_TAB_LABEL[aiLoading]}」的 AI 请求，可切换到该标签查看进度。
                              </span>
                              <button
                                type="button"
                                className="ai-cross-tab-banner-btn"
                                onClick={() => setAiPanelTab(aiLoadingKindToPanelTab(aiLoading))}
                              >
                                前往
                              </button>
                            </div>
                          )}
                          <div className="ai-result-header">
                            <span className="ai-result-title">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                                <path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z"/>
                              </svg>
                              AI 深度总结
                            </span>
                            <div className="ai-result-header-actions">
                              <button
                                type="button"
                                className="ai-result-regen"
                                onClick={() => void handleCopySummary()}
                                disabled={aiLoading !== null}
                                title="复制全文（含视觉解析，Markdown）"
                                aria-label="复制产品总结"
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                                </svg>
                              </button>
                              <button
                                type="button"
                                className="ai-result-regen"
                                onClick={handleGenerateSiteSkill}
                                disabled={aiLoading !== null}
                                title="下载 Skill（产品报告 + 视觉风格）"
                                aria-label="下载 Skill 技能"
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                                </svg>
                              </button>
                              <button
                                type="button"
                                className="ai-result-regen"
                                onClick={handleRegenerateSummaryClick}
                                disabled={aiLoading !== null}
                                title="重新生成"
                                aria-label="重新生成"
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                                  <path d="M23 4v6h-6M1 20v-6h6"/>
                                  <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                                </svg>
                              </button>
                              <button
                                type="button"
                                className="ai-result-regen"
                                onClick={() => setConfirmDismissAiSummary(true)}
                                title="删除总结"
                                aria-label="删除总结"
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                                  <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14M10 11v6M14 11v6"/>
                                </svg>
                              </button>
                            </div>
                          </div>

                          <div className="ai-summary-block">
                            <div className="ai-summary-section-label">产品概述</div>
                            <p className="ai-summary-text">{aiSummaryDisplay.overview}</p>
                          </div>
                          <div className="ai-summary-block">
                            <div className="ai-summary-section-label">产品架构</div>
                            <p className="ai-summary-text">{aiSummaryDisplay.architecture}</p>
                          </div>
                          <div className="ai-summary-block">
                            <div className="ai-summary-section-label">核心功能</div>
                            <div className="ai-summary-tags">
                              {aiSummaryDisplay.features.map((f, i) => (
                                <span key={i} className="ai-summary-tag ai-summary-tag--feature">{f}</span>
                              ))}
                            </div>
                          </div>
                          <div className="ai-summary-block">
                            <div className="ai-summary-section-label">技术栈</div>
                            <div className="ai-summary-tags">
                              {aiSummaryDisplay.tech.map((t, i) => (
                                <span key={i} className="ai-summary-tag ai-summary-tag--tech">{t}</span>
                              ))}
                            </div>
                          </div>
                          <div className="ai-summary-block">
                            <div className="ai-summary-section-label">Skills</div>
                            <div className="ai-summary-tags">
                              {aiSummaryDisplay.skills.map((sk, i) => (
                                <span key={i} className="ai-summary-tag ai-summary-tag--skill">{sk}</span>
                              ))}
                            </div>
                          </div>
                          <div className="ai-summary-block">
                            <div className="ai-summary-section-label">视觉解析报告</div>
                            <div className="ai-visual-report">
                              {/* Section 1: 基础令牌 */}
                              <div className="ai-visual-section">
                                <div className="ai-visual-section-header">
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                                    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                                  </svg>
                                  <span>基础设计令牌</span>
                                </div>
                                <div className="ai-visual-token-row">
                                  <span className="ai-visual-token-label">风格</span>
                                  <span className="ai-visual-style-badge">{aiSummaryDisplay.visual.style}</span>
                                </div>
                                <div className="ai-visual-token-row">
                                  <span className="ai-visual-token-label">字体</span>
                                  <span className="ai-visual-mono-chip">{aiSummaryDisplay.visual.typography}</span>
                                </div>
                                <div className="ai-visual-token-row ai-visual-token-row--top">
                                  <span className="ai-visual-token-label">色彩</span>
                                  <div className="ai-visual-color-strip">
                                    {aiSummaryDisplay.visual.colors.map((c, i) => (
                                      <span key={i} className="ai-visual-color-chip">{c}</span>
                                    ))}
                                  </div>
                                </div>
                              </div>
                              {/* Section 2: 布局几何 */}
                              <div className="ai-visual-section">
                                <div className="ai-visual-section-header">
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                                    <path d="M3 9h18M9 21V9"/>
                                  </svg>
                                  <span>布局几何</span>
                                </div>
                                <div className="ai-visual-layout-block">{aiSummaryDisplay.visual.layout}</div>
                              </div>
                              {/* Section 3: UI 组件 */}
                              <div className="ai-visual-section">
                                <div className="ai-visual-section-header">
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                                    <rect x="2" y="3" width="6" height="4" rx="1"/>
                                    <rect x="9" y="3" width="13" height="4" rx="1"/>
                                    <rect x="2" y="10" width="13" height="4" rx="1"/>
                                    <rect x="18" y="10" width="4" height="4" rx="1"/>
                                    <rect x="2" y="17" width="4" height="4" rx="1"/>
                                    <rect x="9" y="17" width="13" height="4" rx="1"/>
                                  </svg>
                                  <span>UI 组件</span>
                                </div>
                                <div className="ai-visual-component-chips">
                                  {aiSummaryDisplay.visual.components.map((c, i) => (
                                    <span key={i} className="ai-visual-component-chip">{c}</span>
                                  ))}
                                </div>
                              </div>
                            </div>
                          </div>

                          {selectedSite && !summaryNotesSavedIds.has(selectedSite.id) && (
                            <div className="ai-result-footer">
                              <button type="button" className="ai-result-btn" onClick={handleSaveSummaryToNotes}>
                                保存
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              </div>

              <div className="panel-stats-footer">
                <h3 className="panel-section-title">统计</h3>
                <div className="panel-section panel-section-no-label">
                  <div className="panel-stats-card">
                    <div className="panel-stats">
                      <div className="stat-item">
                        <span className="stat-value">
                          {new Date(selectedSite.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}
                        </span>
                        <span className="stat-label">添加</span>
                      </div>
                      <div className="stat-item">
                        <span className="stat-value">{selectedSite.views?.toLocaleString() ?? 0}</span>
                        <span className="stat-label">浏览</span>
                      </div>
                      <div className="stat-item">
                        <span className="stat-value">{formatLastOpened(selectedSite.lastOpenedAt)}</span>
                        <span className="stat-label">最后打开</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
      )}

      {/* 登录弹窗 */}
      {isLoginModalOpen && (
        <div className="modal-overlay login-modal-overlay" onClick={resetLoginState}>
          <div className="modal login-modal" onClick={(e) => e.stopPropagation()}>
            <div className="login-modal-split">
              <aside className="login-modal-brand">
                <p className="login-brand-eyebrow">OpenNav</p>
                <h2 className="login-brand-title">用我们的 Web 应用，为工作提速。</h2>
                <p className="login-brand-lead">书签、分类与 AI 笔记，一处管理。</p>
                <div className="login-brand-partners">
                  <span className="login-brand-partners-label">能力亮点</span>
                  <ul className="login-brand-partner-icons" aria-hidden>
                    <li title="同步">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M4 12a8 8 0 0113.657-5.657M20 12a8 8 0 01-13.657 5.657M4 12h4m8 0h4M12 4v4m0 8v4"/>
                      </svg>
                    </li>
                    <li title="AI">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3zM5 18l.8 2.4L8 21l-2.2.6L5 24l-.8-2.4L2 21l2.2-.6L5 18z"/>
                      </svg>
                    </li>
                    <li title="安全">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M12 3l7 4v5c0 5-3.5 9-7 10-3.5-1-7-5-7-10V7l7-4z"/>
                      </svg>
                    </li>
                    <li title="快捷">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/>
                      </svg>
                    </li>
                  </ul>
                </div>
              </aside>
              <div className="login-modal-right">
                <button type="button" className="login-modal-close" onClick={resetLoginState} aria-label="关闭">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path d="M18 6L6 18M6 6l12 12"/>
                  </svg>
                </button>
                <div className="modal-body login-modal-body">
                  <header className="login-form-header">
                    <h2 className="login-form-title">开始使用</h2>
                    <p className="login-form-subtitle">
                      {loginTab === 'qq'
                        ? '通过 QQ 授权登录，凭证由官方页面处理。'
                        : '输入邮箱收取验证码。新用户验证通过后自动创建账号，已注册用户验证后直接登录。'}
                    </p>
                  </header>

              {loginTab === 'email' && emailOtpStep === 1 && (
                <form onSubmit={handleSendEmailOtp} className="login-method-panel">
                  <p className="login-panel-intro">
                    我们将向该邮箱发送 6 位验证码，有效期 5 分钟。
                  </p>
                  <div className="form-group">
                    <label className="form-label">邮箱</label>
                    <input
                      type="email"
                      className="form-input"
                      placeholder="your@email.com"
                      value={loginEmail}
                      onChange={(e) => setLoginEmail(e.target.value)}
                      required
                      autoFocus
                      autoComplete="email"
                    />
                  </div>
                  <button type="submit" className="btn-submit" disabled={isLoginLoading}>
                    {isLoginLoading ? '发送中...' : '获取验证码'}
                  </button>
                </form>
              )}

              {loginTab === 'email' && emailOtpStep === 2 && (
                <form onSubmit={handleVerifyEmailOtp} className="login-method-panel">
                  <p className="login-panel-intro">
                    验证码已发送至{' '}
                    <strong>{loginEmail.trim()}</strong>
                  </p>
                  <div className="form-group">
                    <label className="form-label">6 位验证码</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="\d{6}"
                      maxLength={6}
                      className="form-input"
                      placeholder="000000"
                      value={loginOtpCode}
                      onChange={(e) => setLoginOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      required
                      autoFocus
                      autoComplete="one-time-code"
                    />
                  </div>
                  <button type="submit" className="btn-submit" disabled={isLoginLoading}>
                    {isLoginLoading ? '验证中...' : '验证并进入'}
                  </button>
                  <p className="login-email-mode-switch">
                    <button
                      type="button"
                      className="login-link-btn"
                      disabled={emailOtpCooldown > 0 || isLoginLoading}
                      onClick={() => void handleSendEmailOtp()}
                    >
                      {emailOtpCooldown > 0 ? `${emailOtpCooldown}s 后可重发` : '重新发送验证码'}
                    </button>
                    <span aria-hidden> · </span>
                    <button type="button" className="login-link-btn" onClick={resetEmailOtpFlow}>
                      修改邮箱
                    </button>
                  </p>
                </form>
              )}

              {loginTab === 'qq' && (
                <div className="login-method-panel login-qq-panel">
                  <p className="login-panel-intro">
                    使用 QQ 官方授权完成登录，不在前端暴露长期登录凭证。
                  </p>
                  <div className="login-hint-box">
                    <p className="login-hint-box-title">接入前准备</p>
                    <p className="login-hint login-hint-inline">
                      请在 <code>backend/.env</code> 配置 <code>QQ_APP_ID</code>、<code>QQ_APP_KEY</code>，并将
                      回调地址设为 <code>BACKEND_PUBLIC_URL/auth/qq/callback</code>。
                    </p>
                  </div>
                  <button type="button" className="btn-submit login-qq-btn" onClick={handleQQLogin}>
                    跳转 QQ 授权
                  </button>
                </div>
              )}

              <div className="login-divider-or" aria-hidden>
                <span className="login-divider-or-line"/>
                <span className="login-divider-or-text">或</span>
                <span className="login-divider-or-line"/>
              </div>

              <div className="login-alt-methods" role="tablist" aria-label="切换登录方式">
                <button
                  type="button"
                  role="tab"
                  aria-selected={loginTab === 'email'}
                  className={`login-alt-btn ${loginTab === 'email' ? 'active' : ''}`}
                  onClick={() => {
                    setLoginTab('email')
                    setEmailOtpStep(1)
                    setLoginOtpCode('')
                    setEmailOtpCooldown(0)
                  }}
                >
                  <span className="login-alt-btn-icon" aria-hidden>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                      <rect x="3" y="5" width="18" height="14" rx="2"/>
                      <path d="M3 7l9 6 9-6"/>
                    </svg>
                  </span>
                  <span className="login-alt-btn-label">邮箱验证码登录</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={loginTab === 'qq'}
                  className={`login-alt-btn ${loginTab === 'qq' ? 'active' : ''}`}
                  onClick={() => {
                    setLoginTab('qq')
                    setEmailOtpStep(1)
                    setLoginOtpCode('')
                    setEmailOtpCooldown(0)
                  }}
                >
                  <span className="login-alt-btn-icon login-alt-btn-icon--qq" aria-hidden>
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <ellipse cx="12" cy="14" rx="7.5" ry="6.5"/>
                      <ellipse cx="9" cy="12.5" rx="2" ry="2.5" fill="var(--login-qq-mark-alt, rgba(255,255,255,0.92))"/>
                      <ellipse cx="15" cy="12.5" rx="2" ry="2.5" fill="var(--login-qq-mark-alt, rgba(255,255,255,0.92))"/>
                    </svg>
                  </span>
                  <span className="login-alt-btn-label">使用 QQ 登录</span>
                </button>
              </div>

              <p className="login-legal-hint">继续即表示你确认当前设备可信，并同意同步个人导航数据与 AI 配置状态。</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 删除网站确认 */}
      {confirmDeleteSite && (
        <div className="modal-overlay" onClick={() => setConfirmDeleteSite(null)}>
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-message">确定删除「{confirmDeleteSite.name}」？此操作不可恢复。</p>
            <div className="confirm-actions">
              <button type="button" className="btn-secondary" onClick={() => setConfirmDeleteSite(null)}>取消</button>
              <button type="button" className="btn-danger" onClick={handleDeleteConfirm}>确定删除</button>
            </div>
          </div>
        </div>
      )}

      {/* 删除 AI 总结确认（仅清除本机缓存的总结，备注不受影响，可重新生成） */}
      {confirmDismissAiSummary && (
        <div className="modal-overlay" onClick={() => setConfirmDismissAiSummary(false)}>
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-message">
              确定删除当前站点的 AI 深度总结？将清除本机缓存中的总结内容，网站备注不会改动，之后可随时重新生成。
            </p>
            <div className="confirm-actions">
              <button type="button" className="btn-secondary" onClick={() => setConfirmDismissAiSummary(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn-danger"
                onClick={() => {
                  dismissAiSummary()
                  setConfirmDismissAiSummary(false)
                }}
              >
                确定删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 重新生成：未保存到备注时询问 */}
      {confirmRegenerateSummary && (
        <div className="modal-overlay" onClick={() => setConfirmRegenerateSummary(false)}>
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-message">
              当前深度总结尚未保存到网站备注。重新生成将替换当前展示内容，是否先保存？
            </p>
            <div className="confirm-actions confirm-actions--multiline">
              <button type="button" className="btn-primary" onClick={() => {
                handleSaveSummaryToNotes()
                setConfirmRegenerateSummary(false)
                void handleAiSummary()
              }}>
                保存并重新生成
              </button>
              <button type="button" className="btn-secondary" onClick={() => {
                setConfirmRegenerateSummary(false)
                void handleAiSummary()
              }}>
                不保存，直接重新生成
              </button>
              <button type="button" className="btn-secondary" onClick={() => setConfirmRegenerateSummary(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 重新获取 AI 资料：未保存到备注时询问（手动添加的链接保留） */}
      {confirmRegenerateResource && (
        <div className="modal-overlay" onClick={() => setConfirmRegenerateResource(false)}>
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-message">
              当前 AI 资料尚未保存到备注。重新获取将替换 AI 推荐内容（手动添加的链接保留）。是否先保存？
            </p>
            <div className="confirm-actions confirm-actions--multiline">
              <button type="button" className="btn-primary" onClick={() => {
                handleSaveResourcesToNotes()
                setConfirmRegenerateResource(false)
                void handleAiResource()
              }}>
                保存并重新获取
              </button>
              <button type="button" className="btn-secondary" onClick={() => {
                setConfirmRegenerateResource(false)
                void handleAiResource()
              }}>
                不保存，直接重新获取
              </button>
              <button type="button" className="btn-secondary" onClick={() => setConfirmRegenerateResource(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除学习库确认 */}
      {confirmDismissAiResources && (
        <div className="modal-overlay" onClick={() => setConfirmDismissAiResources(false)}>
          <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-message">
              确定清空当前站点的学习库？AI 推荐链接和手动添加的链接均会删除，网站备注不受影响。
            </p>
            <div className="confirm-actions">
              <button type="button" className="btn-danger" onClick={() => {
                if (selectedSite) {
                  removeAiResourceFromCache(selectedSite.id)
                  setResourceNotesSavedIds(prev => { const s = new Set(prev); s.delete(selectedSite.id); return s })
                }
                setConfirmDismissAiResources(false)
              }}>
                删除
              </button>
              <button type="button" className="btn-secondary" onClick={() => setConfirmDismissAiResources(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* API 设置弹窗 */}
      {isApiSettingsOpen && (
        <div className="modal-overlay" onClick={() => { setIsApiSettingsOpen(false); setApiKeyInput(''); setBraveKeyInput('') }}>
          <div className="modal api-settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">API 设置</h2>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => { setIsApiSettingsOpen(false); setApiKeyInput(''); setBraveKeyInput('') }}
                aria-label="关闭"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>

            <div className="api-settings-body">
              {/* ── Kimi ── */}
              <div className="api-settings-section">
                <div className="api-key-status-row">
                  <span className="api-key-label">Kimi / Moonshot API Key</span>
                  {kimiKeyConfigured
                    ? <span className="api-key-badge configured">已配置 ✓</span>
                    : <span className="api-key-badge">未配置</span>
                  }
                </div>
                <p className="api-settings-desc">
                  Key 仅存储于你的账号。未配置时 AI 总结、同类推荐等不可用。
                  在{' '}
                  <a href="https://platform.moonshot.cn/console/api-keys" target="_blank" rel="noopener noreferrer">Moonshot 控制台</a>
                  {' '}或官方提供的接口页面复制完整 Key。若使用 Coding 接口，请在后端 <code className="api-settings-code">.env</code> 中配置{' '}
                  <code className="api-settings-code">KIMI_USE_CODING_PLAN=1</code> 及对应 Base URL。
                </p>
                <div className="api-key-input-row">
                  <input
                    type="password"
                    className="api-key-input"
                    placeholder="从控制台粘贴完整 Key"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveApiKey()}
                    autoComplete="off"
                  />
                </div>
                <div className="api-settings-actions">
                  {kimiKeyConfigured && (
                    <button type="button" className="btn-secondary" onClick={handleClearApiKey} disabled={apiKeySaving}>
                      清除 Key
                    </button>
                  )}
                  <button type="button" className="btn-primary" onClick={handleSaveApiKey} disabled={apiKeySaving || !apiKeyInput.trim()}>
                    {apiKeySaving ? '保存中...' : '保存'}
                  </button>
                </div>
              </div>

              <div className="api-settings-divider" />

              {/* ── Brave Search ── */}
              <div className="api-settings-section">
                <div className="api-key-status-row">
                  <span className="api-key-label">Brave Search API Key</span>
                  {braveKeyConfigured
                    ? <span className="api-key-badge configured">已配置 ✓</span>
                    : <span className="api-key-badge">未配置</span>
                  }
                </div>
                <p className="api-settings-desc">
                  用于学习库「搜索网络」功能，调用 Brave Search 返回真实搜索结果。
                  免费注册获取：{' '}
                  <a href="https://brave.com/search/api/" target="_blank" rel="noopener noreferrer">brave.com/search/api</a>。
                  未配置时学习库搜索功能不可用，其他 AI 功能不受影响。
                </p>
                <div className="api-key-input-row">
                  <input
                    type="password"
                    className="api-key-input"
                    placeholder="粘贴 Brave Search API Key"
                    value={braveKeyInput}
                    onChange={(e) => setBraveKeyInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void handleSaveBraveKey()}
                    autoComplete="off"
                  />
                </div>
                <div className="api-settings-actions">
                  {braveKeyConfigured && (
                    <button type="button" className="btn-secondary" onClick={handleClearBraveKey} disabled={braveKeySaving}>
                      清除 Key
                    </button>
                  )}
                  <button type="button" className="btn-primary" onClick={handleSaveBraveKey} disabled={braveKeySaving || !braveKeyInput.trim()}>
                    {braveKeySaving ? '保存中...' : '保存'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  )
}

export default App
