/**
 * 通用工具：日志、文本清洗、分段、消息文本提取。
 *
 * 运行环境：文件系统 Cordis 插件 = 完整 Node 22（ESM）。Node 全局
 * （fetch / WebSocket / process / setTimeout）均可用，与 dsh-computer-use 同模式。
 */

/** 统一日志器（debug 开关控制 verbose 输出）。 */
export function makeLogger(debug) {
  const tag = '[dsh-im-qq]'
  return {
    info: (...args) => console.log(tag, ...args),
    warn: (...args) => console.warn(tag, ...args),
    error: (...args) => console.error(tag, ...args),
    debug: (...args) => {
      if (debug) console.log(tag, '[debug]', ...args)
    },
  }
}

/** dsh 内部标签（不展示给 QQ 用户）。合并扩展时在此追加。 */
const INTERNAL_TAG_RE =
  /<(think|system-reminder|goal-round-reminder|tool-reminder|repeat-tool-reminder)\b[^>]*>[\s\S]*?<\/\1>/gi

/**
 * 剥离 dsh 内部标签（<think> / <system-reminder> / <goal-round-reminder> 等），
 * 并折叠多余空行。出站卫生（设计文档 §9.3）。
 */
export function stripInternalTags(text) {
  if (!text) return ''
  return text
    .replace(INTERNAL_TAG_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 长文本分段：按 UTF-8 字节上限切（平台限制通常是字节而非字符数；
 * 4000 个中文字 ≈ 12000 字节，按字符切会超限），尽量在换行处断开。
 * 返回非空片段数组。
 */
export function chunkText(text, limit) {
  const out = []
  const rest = (text ?? '').trim()
  if (!rest) return out
  const max = limit > 0 ? limit : 4000
  let remaining = rest
  while (Buffer.byteLength(remaining, 'utf8') > max) {
    let bytes = 0
    let cut = 0
    let lastNewline = -1
    for (let i = 0; i < remaining.length; i += 1) {
      bytes += Buffer.byteLength(remaining[i], 'utf8')
      if (bytes > max) break
      if (remaining[i] === '\n') lastNewline = i
      cut = i + 1
    }
    // 预算过半后若遇到换行，优先在换行处断开（可读性）
    if (lastNewline > max / 2 && lastNewline + 1 < remaining.length) cut = lastNewline + 1
    // 不在 UTF-16 代理对中间切断：emoji 等 4 字节字符是代理对（2 个 code unit），
    // 切成两半会产生孤立代理项，发给平台会损坏内容
    if (cut > 0 && cut < remaining.length &&
        remaining.charCodeAt(cut - 1) >= 0xD800 && remaining.charCodeAt(cut - 1) <= 0xDBFF &&
        remaining.charCodeAt(cut) >= 0xDC00 && remaining.charCodeAt(cut) <= 0xDFFF) {
      cut -= 1
    }
    out.push(remaining.slice(0, cut).trim())
    remaining = remaining.slice(cut).trim()
  }
  if (remaining) out.push(remaining)
  return out
}

/**
 * 从 assistant message 的 ContentBlock[] 提取纯文本（text 块拼接）。
 * 其他块类型（tool-result 等）忽略——出站只发文本（图片/文件为 P4）。
 */
export function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/** 简单 sleep（Node 全局 timer）。 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
