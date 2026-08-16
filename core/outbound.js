/**
 * 出站管线：回复合并 / 分段 / 去内部标签 / 被动回复限额 / 错误兜底（设计文档 §5 / §9.3）。
 *
 * 事件监听（签名实锤：ctx.on('session/event', (session, event) => …)，第一参是 Session 对象）：
 *   过滤 session.id 前缀 'qq:'；outbound 消费 assistant/message 提取文本。
 * 事件序列实测：turn/start → user/message → step/start → assistant/message → step/end → turn/end
 *
 * 策略：
 *   - 合并：同轮多条 assistant/message 先聚合，deliverWindowMs 静默期后 flush；
 *     deliverMaxWaitMs 上限强制 flush；turn/end 立即 flush
 *   - 被动回复：每条入站消息的 msg_id 最多用于 replyPassiveLimit 次被动回复，
 *     超限自动转主动消息（QQ 平台规则：被动回复限 4 次/消息）
 *   - 错误兜底：turn/end reason.kind === 'error' 且该轮无任何内容 → 回
 *     「服务暂时不可用，请稍后重试」（绝不静默无响应）
 */

import { stripInternalTags, chunkText, textFromBlocks } from '../lib/util.js'

const FALLBACK_TEXT = '服务暂时不可用，请稍后重试'

export class Outbound {
  /**
   * @param {object} opts
   * @param {object} opts.ctx       Cordis ctx（timer / on）
   * @param {object} opts.config    插件配置（deliverWindowMs / deliverMaxWaitMs / textChunkLimit / replyPassiveLimit）
   * @param {object} opts.logger
   * @param {object} opts.sessionMap 反查 chat（chatForSession）
   * @param {(chat: object, blocks: Array, opts: object) => Promise<void>} opts.send 发送回调（index.js 提供 → qqapi）
   */
  constructor({ ctx, config, logger, sessionMap, send }) {
    this.ctx = ctx
    this.cfg = config
    this.log = logger
    this.sessionMap = sessionMap
    this.send = send
    this.buffers = new Map() // sessionId → buffer
    this.turnHasContent = new Map() // sessionId → Set<turn>（该 turn 是否有 assistant/message）
    this.pendingPassive = new Map() // sessionId → { msgId, used }（入站消息的被动预算，buffer 创建时消费）
  }

  /** 注册 session/event 监听（插件生命周期内自动清理）。 */
  install() {
    this.ctx.on('session/event', (session, event) => this.onSessionEvent(session, event))
  }

  /**
   * 入站消息开始处理：重置被动预算（msg_id 只对本条入站消息有效），
   * 并 flush 上一轮未发出的残留。
   */
  beginTurn(sessionId, msgId) {
    this.flush(sessionId)
    this.pendingPassive.set(sessionId, { msgId: msgId || null, used: 0 })
  }

  onSessionEvent(session, event) {
    if (!session.id.startsWith('qq:')) return
    // ⚠️ session/event 的负载在 event.data 里（dsh-session append() 构造
    //    {type, seq, time, data, ...}），顶层只有 type/seq/time——读顶层字段
    //    会全部 undefined，导致回复被静默丢弃（曾实机复现：agent 正常出话但 QQ 无回复）
    const d = event.data ?? {}
    switch (event.type) {
      case 'turn/start': {
        const set = this.turnHasContent.get(session.id) || new Set()
        set.delete(d.turn)
        this.turnHasContent.set(session.id, set)
        break
      }
      case 'assistant/message': {
        const text = textFromBlocks(d.message?.content)
        if (!text) return
        const set = this.turnHasContent.get(session.id) || new Set()
        set.add(d.turn)
        this.turnHasContent.set(session.id, set)
        this.buffer(session, d.turn, text)
        break
      }
      case 'turn/end': {
        this.flush(session.id)
        // 错误兜底：本轮报错且无任何已发内容 → 回兜底文本
        if (d.reason?.kind === 'error') {
          const set = this.turnHasContent.get(session.id)
          if (!set || !set.has(d.turn)) {
            this.log.warn(`turn ${d.turn} 报错，发送兜底文本`)
            this.sendFallback(session.id)
          }
        }
        break
      }
      default:
        break
    }
  }

  /** 聚合一条 assistant 文本到合并缓冲。 */
  buffer(session, turn, text) {
    let b = this.buffers.get(session.id)
    if (!b) {
      const chat = this.sessionMap.chatForSession(session.id)
      if (!chat) return // 无对应聊天（会话已重置），丢弃
      // 消费 beginTurn 预置的被动预算（若无则无被动）
      const pp = this.pendingPassive.get(session.id)
      b = {
        sessionId: session.id,
        chat,
        parts: [],
        turn,
        flushTimer: null,
        maxTimer: null,
        passive: pp ?? { msgId: null, used: 0 },
      }
      this.pendingPassive.delete(session.id)
      b.flushTimer = this.ctx.timer.timeout(() => this.flush(session.id), this.cfg.deliverWindowMs)
      b.maxTimer = this.ctx.timer.timeout(() => this.flush(session.id), this.cfg.deliverMaxWaitMs)
      this.buffers.set(session.id, b)
    }
    const cleaned = stripInternalTags(text)
    if (cleaned) b.parts.push(cleaned)
  }

  /** 发送合并缓冲（清 timer）。 */
  async flush(sessionId) {
    const b = this.buffers.get(sessionId)
    if (!b) return
    b.flushTimer?.()
    b.maxTimer?.()
    this.buffers.delete(sessionId)
    this.pendingPassive.delete(sessionId)

    const text = b.parts.join('\n\n').trim()
    if (!text) return

    // 分段：> textChunkLimit 拆多条；串行发送（防乱序 + 降频控）。
    // ⚠️ 全部走被动回复（官方：主动消息每月限 4 条/人/群，超限发送失败）——
    //    被动回复限 replyPassiveLimit 次/消息，预算内绝不落主动
    const chunks = chunkText(text, this.cfg.textChunkLimit)
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]
      const passive = b.passive.msgId && b.passive.used < this.cfg.replyPassiveLimit
      if (passive) b.passive.used += 1
      try {
        await this.send(b.chat, [{ type: 'text', text: chunk }], {
          passive,
          msgId: b.passive.msgId || undefined,
        })
      } catch (err) {
        this.log.error('出站发送失败:', err?.message)
      }
    }
  }

  /** 错误兜底：给该会话发固定文本（记录日志，不静默）。 */
  async sendFallback(sessionId) {
    const chat = this.sessionMap.chatForSession(sessionId)
    if (!chat) return
    // 优先用本回合的被动预算（msg_id 有效期内），避免烧主动消息月度配额
    const pp = this.pendingPassive.get(sessionId)
    const passive = !!(pp?.msgId && pp.used < this.cfg.replyPassiveLimit)
    if (passive) pp.used += 1
    try {
      await this.send(chat, [{ type: 'text', text: FALLBACK_TEXT }], {
        passive,
        msgId: pp?.msgId || undefined,
      })
    } catch (err) {
      this.log.error('兜底发送失败:', err?.message)
    }
  }
}
