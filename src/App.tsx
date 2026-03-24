import { useState, useEffect, useCallback, useRef } from 'react'
import { GoogleLogin, type CredentialResponse } from '@react-oauth/google'
import './App.css'
import {
  type AiSimilarSite,
  type AiResourceResult,
  type AiSummaryResult,
  apiGoogleLogin,
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
  apiUpdateKimiKey,
  apiGetKimiKeyStatus,
  type ApiSite,
} from './api'

const VITE_GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''

/** 判断是否已配置后端（存有 token） */
const hasBackend = () => Boolean(localStorage.getItem('myNavToken'))

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

const BUILTIN_CATEGORIES: Category[] = [
  { id: 'all', name: '全部' },
  { id: 'favorites', name: '收藏' },
  { id: 'ungrouped', name: '未分组' },
]


// ==================== 工具函数 ====================
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

// 通过 Microlink API 获取网站元数据（标题、简介、图标）
const fetchSiteInfo = async (url: string): Promise<{ name: string; favicon: string; description: string } | null> => {
  try {
    const res = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}`)
    const data = await res.json()
    const payload = data?.data
    const domain = new URL(url).hostname
    const fallbackName = domain.replace(/^www\./, '').split('.')[0]
    const name = payload?.title?.trim() || (fallbackName.charAt(0).toUpperCase() + fallbackName.slice(1))
    const favicon = payload?.logo?.url || `https://www.google.com/s2/favicons?domain=${domain}&sz=128`
    const description = typeof payload?.description === 'string' ? payload.description.trim() : ''
    return { name, favicon, description }
  } catch {
    try {
      const urlObj = new URL(url)
      const domain = urlObj.hostname
      let name = domain.replace(/^www\./, '').split('.')[0]
      name = name.charAt(0).toUpperCase() + name.slice(1)
      const favicon = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`
      return { name, favicon, description: '' }
    } catch {
      return null
    }
  }
}

// 获取网站截图
const getSiteThumbnail = (url: string) => {
  try {
    const domain = new URL(url).hostname
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=256`
  } catch {
    return ''
  }
}

function App() {
  const [sites, setSites] = useState<Site[]>([])
  const [categories, setCategories] = useState<Category[]>(() => {
    const saved = localStorage.getItem('myNavCategories')
    if (!saved) return BUILTIN_CATEGORIES
    const parsed = JSON.parse(saved) as Category[]
    const custom = parsed.filter((c: Category) => c.id.startsWith('cat_'))
    return [...BUILTIN_CATEGORIES, ...custom]
  })
  const [currentCategory, setCurrentCategory] = useState('all')
  
  // 用户认证状态
  const [user, setUser] = useState<User | null>(null)
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false)
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [isLoginLoading, setIsLoginLoading] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)
  
  // 快捷输入栏状态（双模式）
  const [quickInput, setQuickInput] = useState('')
  const [isQuickInputFocused, setIsQuickInputFocused] = useState(false)
  const [isAdding, setIsAdding] = useState(false)
  
  // 右侧面板状态
  const [selectedSite, setSelectedSite] = useState<Site | null>(null)
  const [isPanelOpen, setIsPanelOpen] = useState(false)
  const [confirmDeleteSite, setConfirmDeleteSite] = useState<Site | null>(null)
  const [editNotes, setEditNotes] = useState('')
  const [editFollowed, setEditFollowed] = useState(false)

  // 新建分组
  const [showAddCategory, setShowAddCategory] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState('')
  const panelCloseRef = useRef<HTMLButtonElement>(null)

  // AI 智能助手状态
  const [isAiMenuOpen, setIsAiMenuOpen] = useState(false)
  const [aiMenuPos, setAiMenuPos] = useState<{ top: number; right: number } | null>(null)
  const [aiLoading, setAiLoading] = useState<'similar' | 'resource' | 'summary' | null>(null)
  const [aiSimilarSites, setAiSimilarSites] = useState<AiSimilarSite[] | null>(null)
  const [aiResources, setAiResources] = useState<AiResourceResult | null>(null)
  const [aiSummary, setAiSummary] = useState<AiSummaryResult | null>(null)
  const [aiSummaryVisualOpen, setAiSummaryVisualOpen] = useState(false)
  const [aiChecked, setAiChecked] = useState<Set<string>>(new Set())
  const aiMenuRef = useRef<HTMLDivElement>(null)
  const aiBtnRef = useRef<HTMLButtonElement>(null)

  // Kimi API Key 配置状态
  const [kimiKeyConfigured, setKimiKeyConfigured] = useState(false)
  const [isApiSettingsOpen, setIsApiSettingsOpen] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [apiKeySaving, setApiKeySaving] = useState(false)

  // Toast 通知
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' | 'warn' } | null>(null)
  const showToast = (msg: string, type: 'success' | 'error' | 'warn' = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  // 拖拽状态：当前拖动的卡片、悬停的卡片（排序目标）、悬停的分组（快速分组）
  const [dragSiteId, setDragSiteId] = useState<string | null>(null)
  const [dropTargetSiteId, setDropTargetSiteId] = useState<string | null>(null)
  const [dragOverCategoryId, setDragOverCategoryId] = useState<string | null>(null)
  const isDraggingRef = useRef(false)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isPanelOpen && !confirmDeleteSite && !isLoginModalOpen) {
        closePanel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isPanelOpen, confirmDeleteSite, isLoginModalOpen])

  useEffect(() => {
    if (isPanelOpen && selectedSite) {
      requestAnimationFrame(() => panelCloseRef.current?.focus())
    }
  }, [isPanelOpen, selectedSite])

  // 点击 AI 菜单外部时关闭
  useEffect(() => {
    if (!isAiMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (aiMenuRef.current && !aiMenuRef.current.contains(e.target as Node)) {
        setIsAiMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isAiMenuOpen])

  // 加载数据：有后端 token 则请求 API，否则回退 localStorage
  useEffect(() => {
    if (hasBackend()) {
      // 从后端加载
      const token = localStorage.getItem('myNavToken')!
      const savedUser = localStorage.getItem('myNavUser')
      if (savedUser) setUser(JSON.parse(savedUser))

      Promise.all([apiGetSites(), apiGetCategories(), apiGetKimiKeyStatus().catch(() => ({ configured: false }))])
        .then(([remoteSites, remoteCats, keyStatus]) => {
          const sites: Site[] = remoteSites.map((s: ApiSite) => ({
            id: s.id,
            favicon: s.favicon,
            name: s.name,
            url: s.url,
            category: s.category,
            tags: s.tags,
            notes: s.notes,
            description: s.description,
            isFollowed: s.isFollowed,
            isFavorite: s.isFavorite,
            views: s.views,
            likes: s.likes,
            createdAt: s.createdAt,
            lastOpenedAt: s.lastOpenedAt,
          }))
          setSites(sites)
          const custom = remoteCats.filter((c) => c.id.startsWith('cat_'))
          setCategories([...BUILTIN_CATEGORIES, ...custom.map((c) => ({ id: c.id, name: c.name }))])
          setKimiKeyConfigured(keyStatus.configured)
        })
        .catch(() => {
          // token 失效，清空，降级到本地模式
          localStorage.removeItem('myNavToken')
          loadFromLocalStorage()
        })
      void token
    } else {
      loadFromLocalStorage()
    }
  }, [])

  function loadFromLocalStorage() {
    const savedCats = localStorage.getItem('myNavCategories')
    let validCategories = BUILTIN_CATEGORIES
    if (savedCats) {
      const parsed = JSON.parse(savedCats) as Category[]
      validCategories = [...BUILTIN_CATEGORIES, ...parsed.filter((c: Category) => c.id.startsWith('cat_'))]
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
        return next as unknown as Site
      })
      setSites(migrated)
    }
    setCategories(validCategories)
    if (savedUser) setUser(JSON.parse(savedUser))
  }

  // 保存站点：本地 + API（有 token 时）
  const saveSites = useCallback((newSites: Site[]) => {
    setSites(newSites)
    localStorage.setItem('myNavSites', JSON.stringify(newSites))
  }, [])

  const saveCategories = useCallback((newCats: Category[]) => {
    setCategories(newCats)
    localStorage.setItem('myNavCategories', JSON.stringify(newCats))
  }, [])

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
      return site.name.toLowerCase().includes(term) ||
             site.url.toLowerCase().includes(term) ||
             site.notes.toLowerCase().includes(term)
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
          name: info.name,
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

  // 登录相关
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!loginEmail.trim() || !loginPassword.trim()) return
    
    setIsLoginLoading(true)
    
    // 模拟登录（后续替换为真实API）
    await new Promise(resolve => setTimeout(resolve, 1000))
    
    const mockUser: User = {
      id: 'user_' + Date.now(),
      email: loginEmail,
      name: loginEmail.split('@')[0]
    }
    
    setUser(mockUser)
    localStorage.setItem('myNavUser', JSON.stringify(mockUser))
    setIsLoginModalOpen(false)
    setLoginEmail('')
    setLoginPassword('')
    setIsLoginLoading(false)
  }

  const handleGoogleLoginSuccess = async (res: CredentialResponse) => {
    const cred = res.credential
    if (!cred) {
      showToast('未获取到 Google 凭证', 'error')
      return
    }
    try {
      const { token, user } = await apiGoogleLogin(cred)
      const nextUser: User = { id: user.id, email: user.email, name: user.name, avatar: user.avatar }
      localStorage.setItem('myNavToken', token)
      localStorage.setItem('myNavUser', JSON.stringify(nextUser))
      setUser(nextUser)
      setIsLoginModalOpen(false)
      setLoginEmail('')
      setLoginPassword('')
      showToast('Google 登录成功', 'success')
      // 登录后从后端拉取数据及 Key 配置状态
      const [remoteSites, remoteCats, keyStatus] = await Promise.all([
        apiGetSites(),
        apiGetCategories(),
        apiGetKimiKeyStatus().catch(() => ({ configured: false })),
      ])
      setKimiKeyConfigured(keyStatus.configured)
      setSites(remoteSites.map((s: ApiSite) => ({
        id: s.id, favicon: s.favicon, name: s.name, url: s.url,
        category: s.category, tags: s.tags, notes: s.notes,
        description: s.description, isFollowed: s.isFollowed,
        isFavorite: s.isFavorite, views: s.views, likes: s.likes,
        createdAt: s.createdAt, lastOpenedAt: s.lastOpenedAt,
      })))
      const custom = remoteCats.filter((c) => c.id.startsWith('cat_'))
      setCategories([...BUILTIN_CATEGORIES, ...custom.map((c) => ({ id: c.id, name: c.name }))])
    } catch (e) {
      // 若后端不可用，回退到纯前端模式（不存 token）
      showToast(`登录失败：${(e as Error).message}`, 'error')
    }
  }

  const handleLogout = () => {
    setUser(null)
    setKimiKeyConfigured(false)
    localStorage.removeItem('myNavUser')
    localStorage.removeItem('myNavToken')
    setShowUserMenu(false)
  }

  const handleSaveApiKey = async () => {
    if (!apiKeyInput.trim()) {
      showToast('请输入 API Key', 'warn')
      return
    }
    setApiKeySaving(true)
    try {
      await apiUpdateKimiKey(apiKeyInput.trim())
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

  const handleExport = () => {
    const data = { categories, sites, exportedAt: new Date().toISOString() }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `my-nav-${new Date().toISOString().split('T')[0]}.json`
    a.click()
    URL.revokeObjectURL(url)
    setShowUserMenu(false)
  }

  // 打开右侧详情面板 (Manus风格)
  const openSitePanel = (site: Site) => {
    setSelectedSite(site)
    setEditNotes(site.notes)
    setEditFollowed(site.isFollowed ?? false)
    setIsPanelOpen(true)
    
    const now = new Date().toISOString()
    const updated = sites.map(s =>
      s.id === site.id
        ? { ...s, views: (s.views || 0) + 1, lastOpenedAt: now }
        : s
    )
    setSites(updated)
    localStorage.setItem('myNavSites', JSON.stringify(updated))
  }

  // 关闭右侧面板
  const closePanel = () => {
    setIsPanelOpen(false)
    setTimeout(() => setSelectedSite(null), 300)
  }

  /** 侧栏打开时：点击主内容区空白关闭；卡片/按钮等交互仅切换内容或不关闭 */
  const handleMainDismissPanel = (e: React.MouseEvent) => {
    if (!isPanelOpen) return
    const el = e.target as HTMLElement
    if (el.closest('.site-card')) return
    if (el.closest('button')) return
    if (el.closest('input, textarea, select')) return
    if (el.closest('a[href]')) return
    closePanel()
  }

  /** Hero / 顶栏：仅点到容器自身空白时关闭（避免误点标题、搜索区） */
  const handleShellDismissPanel = (e: React.MouseEvent) => {
    if (!isPanelOpen) return
    if (e.target === e.currentTarget) closePanel()
  }

  // 保存编辑
  const handleSaveEdit = () => {
    if (!selectedSite) return
    const patch = { notes: editNotes, isFollowed: editFollowed }
    const updated = sites.map(s => s.id === selectedSite.id ? { ...s, ...patch } : s)
    saveSites(updated)
    setSelectedSite({ ...selectedSite, ...patch })
    if (hasBackend()) apiUpdateSite(selectedSite.id, patch).catch(() => {})
  }

  const toggleFavorite = () => {
    if (!selectedSite) return
    const next = !selectedSite.isFavorite
    const updated = sites.map(s => s.id === selectedSite.id ? { ...s, isFavorite: next } : s)
    saveSites(updated)
    setSelectedSite({ ...selectedSite, isFavorite: next })
    if (hasBackend()) apiUpdateSite(selectedSite.id, { isFavorite: next }).catch(() => {})
  }

  const handleDeleteConfirm = () => {
    if (!confirmDeleteSite) return
    if (hasBackend()) apiDeleteSite(confirmDeleteSite.id).catch(() => {})
    saveSites(sites.filter(s => s.id !== confirmDeleteSite.id))
    setConfirmDeleteSite(null)
    if (selectedSite?.id === confirmDeleteSite.id) closePanel()
  }

  // ==================== AI 智能助手 ====================
  const clearAiResults = () => {
    setAiSimilarSites(null)
    setAiResources(null)
    setAiSummary(null)
    setAiSummaryVisualOpen(false)
    setAiChecked(new Set())
  }

  const handleAiSimilar = async () => {
    if (!selectedSite) return
    setIsAiMenuOpen(false)
    clearAiResults()
    setAiLoading('similar')
    try {
      const results = await apiAiSimilar(
        selectedSite.name,
        selectedSite.url,
        selectedSite.description ?? ''
      )
      setAiSimilarSites(results)
      setAiChecked(new Set(results.map((s: AiSimilarSite) => s.url)))
    } catch (e) {
      showToast((e as Error).message, 'error')
    } finally {
      setAiLoading(null)
    }
  }

  const handleAiResource = async () => {
    if (!selectedSite) return
    setIsAiMenuOpen(false)
    clearAiResults()
    setAiLoading('resource')
    try {
      const result: AiResourceResult = await apiAiResources(
        selectedSite.name,
        selectedSite.url,
        selectedSite.description ?? ''
      )
      setAiResources(result)
    } catch (e) {
      showToast((e as Error).message, 'error')
    } finally {
      setAiLoading(null)
    }
  }

  const handleAddAiSites = async () => {
    if (!aiSimilarSites || !selectedSite) return
    const toAdd = aiSimilarSites.filter(s => aiChecked.has(s.url))
    if (toAdd.length === 0) {
      showToast('请至少勾选一个网站', 'warn')
      return
    }
    setAiLoading('similar')
    let added = 0
    const newSites = [...sites]
    for (const ai of toAdd) {
      const normalized = ai.url.replace(/\/$/, '')
      if (newSites.some(s => s.url.replace(/\/$/, '') === normalized)) continue
      const info = await fetchSiteInfo(ai.url).catch(() => null)
      const siteData = {
        id: 'site_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        favicon: info?.favicon ?? `https://www.google.com/s2/favicons?domain=${new URL(ai.url.startsWith('http') ? ai.url : 'https://' + ai.url).hostname}&sz=128`,
        name: info?.name ?? ai.name,
        url: ai.url.startsWith('http') ? ai.url : 'https://' + ai.url,
        category: selectedSite.category,
        tags: [] as string[],
        notes: ai.reason,
        description: info?.description ?? '',
        isFollowed: false,
        isFavorite: false,
        createdAt: new Date().toISOString(),
        views: 0,
        likes: 0,
      }
      if (hasBackend()) {
        try {
          const created = await apiCreateSite(siteData)
          newSites.push({ ...siteData, id: created.id })
        } catch {
          newSites.push(siteData)
        }
      } else {
        newSites.push(siteData)
      }
      added++
    }
    saveSites(newSites)
    setAiLoading(null)
    clearAiResults()
    showToast(`已成功添加 ${added} 个网站`, 'success')
  }

  const handleSaveResourcesToNotes = () => {
    if (!aiResources || !selectedSite) return
    const lines: string[] = []
    lines.push(`【AI 资料】${selectedSite.name}`)
    lines.push(aiResources.summary)
    lines.push('')
    aiResources.links.forEach((l, i) => {
      lines.push(`${i + 1}. ${l.title}`)
      lines.push(`   ${l.url}`)
    })
    const appended = editNotes
      ? editNotes + '\n\n' + lines.join('\n')
      : lines.join('\n')
    setEditNotes(appended)
    const updated = sites.map(s => s.id === selectedSite.id ? { ...s, notes: appended } : s)
    saveSites(updated)
    setSelectedSite({ ...selectedSite, notes: appended })
    if (hasBackend()) apiUpdateSite(selectedSite.id, { notes: appended }).catch(() => {})
    clearAiResults()
    showToast('资料已保存到备注', 'success')
  }

  const handleAiSummary = async () => {
    if (!selectedSite) return
    clearAiResults()
    setAiLoading('summary')
    try {
      const result = await apiAiSummary(
        selectedSite.name,
        selectedSite.url,
        selectedSite.description ?? ''
      )
      setAiSummary(result)
    } catch (e) {
      showToast((e as Error).message, 'error')
    } finally {
      setAiLoading(null)
    }
  }

  const buildSummaryMarkdown = (s: AiSummaryResult, siteName: string): string => {
    const lines: string[] = []
    lines.push(`# ${siteName} — AI 深度总结`)
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
    lines.push('## 视觉设计')
    lines.push(`**风格**：${s.visual.style}`)
    lines.push(`**布局**：${s.visual.layout}`)
    lines.push(`**字体/排版**：${s.visual.typography}`)
    lines.push(`**主要色彩**：${s.visual.colors.join('、')}`)
    lines.push(`**典型组件**：${s.visual.components.join('、')}`)
    return lines.join('\n')
  }

  const handleDownloadSummaryMarkdown = () => {
    if (!aiSummary || !selectedSite) return
    const md = buildSummaryMarkdown(aiSummary, selectedSite.name)
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${selectedSite.name.replace(/[/\\:*?"<>|]/g, '_')}_summary.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleDownloadVisualJson = () => {
    if (!aiSummary || !selectedSite) return
    const payload = {
      site: selectedSite.name,
      url: selectedSite.url,
      visual: aiSummary.visual,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${selectedSite.name.replace(/[/\\:*?"<>|]/g, '_')}_visual.json`
    a.click()
    URL.revokeObjectURL(url)
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
    clearAiResults()
    showToast('总结已保存到备注', 'success')
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
  const getHostname = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
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

  return (
    <div className={`app ${isPanelOpen ? 'panel-open' : ''}`}>
      {/* 顶部导航 */}
      <header className="header" onClick={handleShellDismissPanel}>
        <div className="logo">
          <div className="logo-mark">◈</div>
          <span className="logo-text">OpenNav</span>
        </div>
        <div className="header-actions">
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
                onClick={() => setShowUserMenu(!showUserMenu)}
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
                    <span className="dropdown-item-text">API 设置（Kimi K2.5）</span>
                    {kimiKeyConfigured
                      ? <span className="api-key-badge configured">已配置</span>
                      : <span className="api-key-badge">未配置</span>
                    }
                  </div>
                  <div className="dropdown-item" onClick={handleExport}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                    </svg>
                    导出数据
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
            <span className="hero-title-greeting">Hi{user ? `，${user.name}` : ''}</span>
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
                  className={`site-card ${selectedSite?.id === site.id ? 'selected' : ''} ${dragSiteId === site.id ? 'dragging' : ''} ${dropTargetSiteId === site.id ? 'drop-target' : ''}`}
                  draggable
                  onClick={() => {
                    if (isDraggingRef.current) return
                    openSitePanel(site)
                  }}
                  onDragStart={(e) => {
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
                      img.src = getSiteThumbnail(site.url) || site.favicon
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
                  <div className="site-icon-area">
                    {/* 模糊背景层 */}
                    <img
                      src={site.favicon}
                      alt=""
                      className="site-favicon-bg"
                      onError={(e) => {
                        (e.target as HTMLImageElement).src = getSiteThumbnail(site.url) || site.favicon
                      }}
                    />
                    {/* 居中清晰图标层 */}
                    <img 
                      src={site.favicon} 
                      alt="" 
                      className="site-favicon"
                      onError={(e) => {
                        (e.target as HTMLImageElement).src = getSiteThumbnail(site.url) || site.favicon
                      }}
                    />
                  </div>
                  
                  <div className="site-info">
                    <h3 className="site-name">{site.name}</h3>
                    <p className="site-domain">{getHostname(site.url)}</p>
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
            <button ref={panelCloseRef} type="button" className="panel-close" onClick={closePanel} aria-label="关闭">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
            <div className="panel-actions">
              {/* AI 智能助手入口 */}
              <div className="ai-menu-wrap" ref={aiMenuRef}>
                <button
                  ref={aiBtnRef}
                  type="button"
                  className={`panel-ai-btn${isAiMenuOpen ? ' active' : ''}${!user || !kimiKeyConfigured ? ' disabled' : ''}`}
                  disabled={!user || !kimiKeyConfigured}
                  onClick={() => {
                    if (!isAiMenuOpen && aiBtnRef.current) {
                      const rect = aiBtnRef.current.getBoundingClientRect()
                      setAiMenuPos({
                        top: rect.bottom + 8,
                        right: window.innerWidth - rect.right,
                      })
                    }
                    setIsAiMenuOpen(v => !v)
                  }}
                  title={!user ? '请先登录' : !kimiKeyConfigured ? '请在「设置」中配置 Kimi API Key' : 'AI 智能助手'}
                  aria-label="AI 智能助手"
                  aria-expanded={isAiMenuOpen}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                    <path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z"/>
                    <path d="M5 3L4 6l3-1"/>
                    <path d="M19 17l-1 3 3-1"/>
                  </svg>
                  AI
                </button>
                {isAiMenuOpen && aiMenuPos && (
                  <div
                    className="ai-menu"
                    role="menu"
                    style={{ top: aiMenuPos.top, right: aiMenuPos.right }}
                  >
                    <button
                      type="button"
                      className="ai-menu-item"
                      role="menuitem"
                      onClick={handleAiSimilar}
                      disabled={aiLoading !== null}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                        <circle cx="11" cy="11" r="8"/>
                        <path d="M21 21l-4.35-4.35"/>
                        <path d="M11 8v6M8 11h6"/>
                      </svg>
                      <div className="ai-menu-item-text">
                        <span className="ai-menu-item-title">发现同类优质网站</span>
                        <span className="ai-menu-item-desc">AI 识别当前网站类型，推荐 5 个同类网站</span>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="ai-menu-item"
                      role="menuitem"
                      onClick={handleAiResource}
                      disabled={aiLoading !== null}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                        <path d="M4 19.5A2.5 2.5 0 016.5 17H20"/>
                        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>
                        <path d="M8 7h8M8 11h8M8 15h5"/>
                      </svg>
                      <div className="ai-menu-item-text">
                        <span className="ai-menu-item-title">获取相关资料教程</span>
                        <span className="ai-menu-item-desc">AI 收集教程与文章，保存到备注</span>
                      </div>
                    </button>
                  </div>
                )}
              </div>
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
                <img src={selectedSite.favicon} alt="" className="panel-favicon" />
                <div className="panel-site-info">
                  <h2 id="panel-site-name" className="panel-site-name">{selectedSite.name}</h2>
                  <p className="panel-site-url">{getHostname(selectedSite.url)}</p>
                </div>
              </div>

              {selectedSite.description ? (
                <p className="panel-description">{selectedSite.description}</p>
              ) : (
                <p className="panel-description muted">暂无描述</p>
              )}

              {/* AI 加载骨架屏 */}
              {aiLoading && (
                <div className="ai-result-section">
                  <div className="ai-result-header">
                    <span className="ai-result-title">
                      {aiLoading === 'similar' ? '正在发现同类优质网站…' : aiLoading === 'summary' ? '正在深度总结网站…' : '正在获取相关资料…'}
                    </span>
                  </div>
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

              {/* AI 同类网站结果 */}
              {!aiLoading && aiSimilarSites && (
                <div className="ai-result-section">
                  <div className="ai-result-header">
                    <span className="ai-result-title">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                        <path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z"/>
                      </svg>
                      AI 发现同类优质网站
                    </span>
                    <button
                      type="button"
                      className="ai-result-close"
                      onClick={clearAiResults}
                      aria-label="关闭"
                    >×</button>
                  </div>
                  <div className="ai-similar-list">
                    {aiSimilarSites.map(site => (
                      <label key={site.url} className={`ai-similar-card${aiChecked.has(site.url) ? ' checked' : ''}`}>
                        <input
                          type="checkbox"
                          className="ai-similar-checkbox"
                          checked={aiChecked.has(site.url)}
                          onChange={e => {
                            setAiChecked(prev => {
                              const next = new Set(prev)
                              e.target.checked ? next.add(site.url) : next.delete(site.url)
                              return next
                            })
                          }}
                        />
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
                      </label>
                    ))}
                  </div>
                  <div className="ai-result-footer">
                    <span className="ai-result-hint">已选 {aiChecked.size} / {aiSimilarSites.length}</span>
                    <button
                      type="button"
                      className="ai-result-btn"
                      onClick={handleAddAiSites}
                      disabled={aiChecked.size === 0}
                    >
                      添加选中网站
                    </button>
                  </div>
                </div>
              )}

              {/* AI 资料收纳结果 */}
              {!aiLoading && aiResources && (
                <div className="ai-result-section">
                  <div className="ai-result-header">
                    <span className="ai-result-title">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                        <path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z"/>
                      </svg>
                      AI 相关资料教程
                    </span>
                    <button
                      type="button"
                      className="ai-result-close"
                      onClick={clearAiResults}
                      aria-label="关闭"
                    >×</button>
                  </div>
                  <p className="ai-resource-summary">{aiResources.summary}</p>
                  <ul className="ai-resource-list">
                    {aiResources.links.map((link, i) => (
                      <li key={i} className="ai-resource-link">
                        <span className="ai-resource-index">{i + 1}</span>
                        <div className="ai-resource-link-info">
                          <a
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ai-resource-link-title"
                          >
                            {link.title}
                          </a>
                          <span className="ai-resource-link-url">{link.url}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="ai-result-footer">
                    <button
                      type="button"
                      className="ai-result-btn"
                      onClick={handleSaveResourcesToNotes}
                    >
                      保存到备注
                    </button>
                  </div>
                </div>
              )}

              {/* AI 总结结果 */}
              {!aiLoading && aiSummary && (
                <div className="ai-result-section">
                  <div className="ai-result-header">
                    <span className="ai-result-title">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                        <path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z"/>
                      </svg>
                      AI 深度总结
                    </span>
                    <button type="button" className="ai-result-close" onClick={clearAiResults} aria-label="关闭">×</button>
                  </div>

                  <div className="ai-summary-block">
                    <div className="ai-summary-section-label">产品概述</div>
                    <p className="ai-summary-text">{aiSummary.overview}</p>
                  </div>
                  <div className="ai-summary-block">
                    <div className="ai-summary-section-label">产品架构</div>
                    <p className="ai-summary-text">{aiSummary.architecture}</p>
                  </div>
                  <div className="ai-summary-block">
                    <div className="ai-summary-section-label">核心功能</div>
                    <div className="ai-summary-tags">
                      {aiSummary.features.map((f, i) => (
                        <span key={i} className="ai-summary-tag ai-summary-tag--feature">{f}</span>
                      ))}
                    </div>
                  </div>
                  <div className="ai-summary-block">
                    <div className="ai-summary-section-label">技术栈</div>
                    <div className="ai-summary-tags">
                      {aiSummary.tech.map((t, i) => (
                        <span key={i} className="ai-summary-tag ai-summary-tag--tech">{t}</span>
                      ))}
                    </div>
                  </div>
                  <div className="ai-summary-block">
                    <div className="ai-summary-section-label">Skills</div>
                    <div className="ai-summary-tags">
                      {aiSummary.skills.map((sk, i) => (
                        <span key={i} className="ai-summary-tag ai-summary-tag--skill">{sk}</span>
                      ))}
                    </div>
                  </div>
                  <div className="ai-summary-block">
                    <button
                      type="button"
                      className="ai-summary-visual-toggle"
                      onClick={() => setAiSummaryVisualOpen(v => !v)}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                        <rect x="3" y="3" width="18" height="18" rx="2"/>
                        <path d="M3 9h18M9 21V9"/>
                      </svg>
                      视觉设计分析
                      <svg className={`toggle-chevron${aiSummaryVisualOpen ? ' open' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                        <path d="M6 9l6 6 6-6"/>
                      </svg>
                    </button>
                    {aiSummaryVisualOpen && (
                      <div className="ai-summary-visual">
                        <div className="ai-summary-visual-row"><span className="ai-summary-visual-key">风格</span><span>{aiSummary.visual.style}</span></div>
                        <div className="ai-summary-visual-row"><span className="ai-summary-visual-key">布局</span><span>{aiSummary.visual.layout}</span></div>
                        <div className="ai-summary-visual-row"><span className="ai-summary-visual-key">字体排版</span><span>{aiSummary.visual.typography}</span></div>
                        <div className="ai-summary-visual-row">
                          <span className="ai-summary-visual-key">色彩</span>
                          <span>{aiSummary.visual.colors.join('、')}</span>
                        </div>
                        <div className="ai-summary-visual-row">
                          <span className="ai-summary-visual-key">UI 组件</span>
                          <span>{aiSummary.visual.components.join('、')}</span>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="ai-result-footer ai-result-footer--wrap">
                    <button type="button" className="ai-result-btn" onClick={handleSaveSummaryToNotes}>保存到备注</button>
                    <button type="button" className="ai-result-btn ai-result-btn--outline" onClick={handleDownloadSummaryMarkdown}>下载 MD</button>
                    <button type="button" className="ai-result-btn ai-result-btn--outline" onClick={handleDownloadVisualJson}>视觉 JSON</button>
                  </div>
                </div>
              )}

              {/* AI 功能 */}
              <div className="panel-section panel-section-ai">
                <div className="ai-feature-card">
                  <div className="ai-feature-head">
                    <span className="ai-feature-icon" aria-hidden>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z"/>
                        <path d="M5 3L4 6l3-1"/>
                        <path d="M19 17l-1 3 3-1"/>
                      </svg>
                    </span>
                    <span className="ai-feature-title">AI</span>
                  </div>
                  <div className="ai-feature-buttons">
                    <button
                      type="button"
                      className="ai-feature-btn"
                      onClick={handleAiSimilar}
                      disabled={!user || !kimiKeyConfigured || aiLoading !== null}
                      title={!user ? '请先登录' : !kimiKeyConfigured ? '请在「设置」中配置 Kimi API Key' : '发现同类优质网站'}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="11" cy="11" r="8"/>
                        <path d="M21 21l-4.35-4.35"/>
                        <path d="M11 8v6M8 11h6"/>
                      </svg>
                      <span>发现</span>
                    </button>
                    <button
                      type="button"
                      className="ai-feature-btn"
                      onClick={handleAiResource}
                      disabled={!user || !kimiKeyConfigured || aiLoading !== null}
                      title={!user ? '请先登录' : !kimiKeyConfigured ? '请在「设置」中配置 Kimi API Key' : '获取相关资料教程'}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M4 19.5A2.5 2.5 0 016.5 17H20"/>
                        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>
                        <path d="M8 7h8M8 11h8M8 15h5"/>
                      </svg>
                      <span>资料</span>
                    </button>
                    <button
                      type="button"
                      className="ai-feature-btn"
                      onClick={handleAiSummary}
                      disabled={!user || !kimiKeyConfigured || aiLoading !== null}
                      title={!user ? '请先登录' : !kimiKeyConfigured ? '请在「设置」中配置 Kimi API Key' : '深度总结网站产品与技术'}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                        <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>
                      </svg>
                      <span>总结</span>
                    </button>
                  </div>
                  {(!user || !kimiKeyConfigured) && (
                    <p className="ai-feature-hint">
                      {!user ? '登录后可使用 AI 功能' : '请前往头像 → API 设置中配置 Kimi Key'}
                    </p>
                  )}
                </div>
              </div>

              {/* 分类（可编辑） */}
              <div className="panel-section panel-section-category">
                <label className="panel-label">分组</label>
                <div className="panel-select-wrap">
                  <select
                    className="panel-select"
                    value={selectedSite.category}
                    onChange={(e) => handleCategoryChange(e.target.value)}
                    aria-label="选择分组"
                  >
                    {categories
                      .filter(c => c.id === 'ungrouped' || c.id.startsWith('cat_'))
                      .map(c => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                  </select>
                </div>
              </div>

              {/* 笔记编辑 */}
              <div className="panel-section">
                <label className="panel-label">笔记</label>
                <textarea 
                  className="panel-textarea"
                  placeholder="备注、备忘..."
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  onBlur={handleSaveEdit}
                />
              </div>
              </div>

              <div className="panel-stats-footer">
                <h3 className="panel-section-title">统计</h3>
                <div className="panel-section panel-section-no-label">
                  <div className="panel-stats-card">
                    <div className="panel-stats">
                      <div className="stat-item">
                        <span className="stat-value">{selectedSite.views?.toLocaleString() ?? 0}</span>
                        <span className="stat-label">浏览</span>
                      </div>
                      <div className="stat-item">
                        <span className="stat-value">
                          {new Date(selectedSite.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}
                        </span>
                        <span className="stat-label">添加</span>
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
        <div className="modal-overlay" onClick={() => setIsLoginModalOpen(false)}>
          <div className="modal login-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">欢迎回来</h2>
              <button className="modal-close" onClick={() => setIsLoginModalOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <form onSubmit={handleLogin}>
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
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">密码</label>
                  <input
                    type="password"
                    className="form-input"
                    placeholder="输入密码"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    required
                  />
                </div>
                <button 
                  type="submit" 
                  className="btn-submit"
                  disabled={isLoginLoading}
                >
                  {isLoginLoading ? '登录中...' : '登录'}
                </button>
              </form>
              
              <div className="login-divider">
                <span>或</span>
              </div>

              {VITE_GOOGLE_CLIENT_ID ? (
                <div className="google-login-wrap">
                  <GoogleLogin
                    onSuccess={handleGoogleLoginSuccess}
                    onError={() => showToast('Google 登录失败', 'error')}
                    text="continue_with"
                    shape="rectangular"
                    size="large"
                    width="100%"
                  />
                </div>
              ) : (
                <p className="login-hint login-hint-google">
                  使用 Google 登录：在项目根目录创建 <code>.env</code>，填写{' '}
                  <code>VITE_GOOGLE_CLIENT_ID=你的客户端ID</code> 后重启开发服务器。
                </p>
              )}

              <p className="login-hint">
                邮箱密码为演示模式，任意填写即可登录
              </p>
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

      {/* API 设置弹窗 */}
      {isApiSettingsOpen && (
        <div className="modal-overlay" onClick={() => { setIsApiSettingsOpen(false); setApiKeyInput('') }}>
          <div className="modal api-settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">大模型 API 设置</h2>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => { setIsApiSettingsOpen(false); setApiKeyInput('') }}
                aria-label="关闭"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>

            <div className="api-settings-body">
              <div className="api-key-status-row">
                <span className="api-key-label">Kimi Coding Plan（K2.5）API Key</span>
                {kimiKeyConfigured
                  ? <span className="api-key-badge configured">已配置 ✓</span>
                  : <span className="api-key-badge">未配置</span>
                }
              </div>
              <p className="api-settings-desc">
                Key 仅存储于你的账号，不会对外暴露。未配置时 AI 功能不可用。
                前往 <a href="https://platform.moonshot.cn/console/api-keys" target="_blank" rel="noopener noreferrer">Moonshot 控制台</a> 创建 Key（需 Kimi Coding Plan）。
              </p>

              <div className="api-key-input-row">
                <input
                  type="password"
                  className="api-key-input"
                  placeholder="sk-xxxxxxxxxxxxxxxxxxxxxxxx"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveApiKey()}
                  autoComplete="off"
                />
              </div>

              <div className="api-settings-actions">
                {kimiKeyConfigured && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={handleClearApiKey}
                    disabled={apiKeySaving}
                  >
                    清除 Key
                  </button>
                )}
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleSaveApiKey}
                  disabled={apiKeySaving || !apiKeyInput.trim()}
                >
                  {apiKeySaving ? '保存中...' : '保存'}
                </button>
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
