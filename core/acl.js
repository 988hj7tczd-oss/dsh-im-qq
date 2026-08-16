/**
 * 访问控制：白名单（fail-closed）+ 频率限制（设计文档 §9.1）。
 *
 * ⚠️ 安全核心：本插件背后是带 bash / 文件 / 子代理的全量 agent，
 *    白名单空 = 全部拒绝（fail-closed），'*' = 显式放行。
 *    openid / group_openid 是平台按 bot 哈希的，无法提前预填——
 *    只能从真实收到的消息里抄（设计文档 §3.4 前置 #4），
 *    联调阶段用 '*' 放行，上线前收紧。
 */

/** 频率限制：每 chatKey 60s 滑动窗口内最多条数（宽松，防误伤）。 */
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 30

export class Acl {
  /**
   * @param {object} opts
   * @param {string[]} opts.allowFrom      私聊白名单（空=全拒，'*'=放行）
   * @param {string[]} opts.groupAllowFrom 群/频道白名单（同上）
   * @param {object} opts.logger
   */
  constructor({ allowFrom, groupAllowFrom, logger }) {
    this.allowFrom = Array.isArray(allowFrom) ? allowFrom : []
    this.groupAllowFrom = Array.isArray(groupAllowFrom) ? groupAllowFrom : []
    this.log = logger
    this.rateHits = new Map() // chatKey → number[]（时间戳）
  }

  /**
   * 检查某聊天对象是否允许访问。
   * @param {{kind: string, id: string}} chat
   * @param {string} chatKey
   * @returns {{ok: boolean, reason?: string}}
   */
  check(chat, chatKey) {
    // —— 白名单（fail-closed）——
    // 频道属于"群组"性质，与群共用 groupAllowFrom
    const list = chat.kind === 'group' || chat.kind === 'channel'
      ? this.groupAllowFrom
      : this.allowFrom
    if (list.length === 0) {
      return { ok: false, reason: `未配置白名单（fail-closed），拒绝 ${chatKey}` }
    }
    if (!list.includes('*') && !list.includes(chat.id)) {
      return { ok: false, reason: `不在白名单，拒绝 ${chatKey}` }
    }

    // —— 频率限制（滑动窗口）——
    const now = Date.now()
    const hits = (this.rateHits.get(chatKey) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS)
    if (hits.length >= RATE_LIMIT_MAX) {
      return { ok: false, reason: `频率超限（${RATE_LIMIT_MAX} 条/${RATE_LIMIT_WINDOW_MS / 1000}s），拒绝 ${chatKey}` }
    }
    hits.push(now)
    this.rateHits.set(chatKey, hits)
    return { ok: true }
  }
}
