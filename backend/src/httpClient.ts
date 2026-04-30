/**
 * 带超时的 fetch 包装。
 *
 * 目的：
 * - 对外部服务（QQ、Kimi、Brave）调用加上统一超时，避免请求在下游卡住时无限挂起
 * - 统一用 AbortController 触发，错误消息友好
 *
 * 用法：
 *   const res = await fetchWithTimeout(url, { method: 'POST', body, timeoutMs: 15_000 })
 */

export interface FetchWithTimeoutInit extends RequestInit {
  timeoutMs?: number
}

export class FetchTimeoutError extends Error {
  constructor(public readonly url: string, public readonly timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`)
    this.name = 'FetchTimeoutError'
  }
}

export async function fetchWithTimeout(
  url: string,
  init: FetchWithTimeoutInit = {}
): Promise<Response> {
  const { timeoutMs = 15_000, signal: externalSignal, ...rest } = init
  const ac = new AbortController()
  const onExternalAbort = () => ac.abort((externalSignal as AbortSignal)?.reason)
  if (externalSignal) {
    if (externalSignal.aborted) ac.abort(externalSignal.reason)
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }
  const timer = setTimeout(() => ac.abort(new FetchTimeoutError(url, timeoutMs)), timeoutMs)
  try {
    return await fetch(url, { ...rest, signal: ac.signal })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      const reason = (ac.signal.reason as unknown)
      if (reason instanceof FetchTimeoutError) throw reason
      throw new FetchTimeoutError(url, timeoutMs)
    }
    throw e
  } finally {
    clearTimeout(timer)
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort)
  }
}
