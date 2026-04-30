/**
 * Node fetch（undici）与浏览器要求 HTTP 头值为 Latin-1；非 ASCII（如中文、全角「。」）会抛
 * “Cannot convert argument to a ByteString…”。
 * Kimi/Moonshot Key 均为 ASCII，误粘贴说明文字时会触发上述错误。
 */
export function assertKimiKeyHeaderSafe(key: string): void {
  if (!key) return
  for (let i = 0; i < key.length; i++) {
    if (key.charCodeAt(i) > 127) {
      const err = new Error(
        'Kimi API Key 只能包含英文与常见符号，不能含中文或全角标点。请从 Kimi/Moonshot 控制台重新复制完整 Key。'
      ) as Error & { status?: number }
      err.status = 400
      throw err
    }
  }
}
