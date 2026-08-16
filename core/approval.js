/**
 * 审批策略桥（设计文档 §9.2，签名已实锤）。
 *
 * ⚠️ 关键约束（rc.6 源码实锤）：ApprovalService.request() 必须在 open turn 内调用，
 * 而 QQ 按钮回调（INTERACTION_CREATE）发生在 turn 之外，不能直接调 request()。
 * 正确做法：插件注册为 answerer（waterfall 中间件 ctx.on('approval/request', (req, next) => …)），
 * 把审批请求变成 QQ 内联按钮消息，等回调后返回 ApprovalOutcome；无 answerer 时 dsh fail-closed。
 *
 * ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
 * 「始终允许」不是 outcome，而是把会话 approval policy 切到 'never'：
 *   approval.setPolicy(agent, 'never')（可被 /revoke 撤销回 'ask'）。
 *
 * 按钮回调 data.id 编码：'qq_apv_<requestId>:<action>'，router 解析出 dataId 后交回本桥。
 * ⚠️ INTERACTION_CREATE 的 payload 字段（data.id / button_data.id）按官方文档宽容解析，
 *    以真实事件流实测为准（VERIFICATION §12）。
 */

const PREFIX = 'qq_apv_'
const ACTION_ALLOW = 'allow-once'
const ACTION_ALWAYS = 'always'
const ACTION_REJECT = 'reject'

export class ApprovalBridge {
  /**
   * @param {object} opts
   * @param {object} opts.ctx        Cordis ctx（timer / on / approval）
   * @param {object} opts.config     插件配置（approvalTimeoutMs）
   * @param {object} opts.logger
   * @param {object} opts.sessionMap 反查 chat（chatForSession）
   * @param {(chat: object, text: string, actions: Array<{id:string,label:string,action:string}>) => Promise<void>} opts.sendKeyboard
   */
  constructor({ ctx, config, logger, sessionMap, sendKeyboard }) {
    this.ctx = ctx
    this.cfg = config
    this.log = logger
    this.sessionMap = sessionMap
    this.sendKeyboard = sendKeyboard
    this.counter = 0
    this.pending = new Map() // requestId → { resolve, settled, chat }
  }

  /** 注册 answerer（waterfall 中间件）。 */
  install() {
    this.ctx.on('approval/request', (req, next) => this.handle(req, next))
  }

  /**
   * waterfall 处理：只拦截本插件的会话；其余交给下游。
   * 返回 Promise<ApprovalOutcome>；超时返回 'unavailable'（fail-closed）。
   */
  async handle(req, next) {
    const sessionId = req.agent.session.id
    if (!sessionId.startsWith('qq:')) return next()

    const chat = this.sessionMap.chatForSession(sessionId)
    if (!chat) return next() // 会话已被 /new 重置等，无发送目标 → 不拦截

    const requestId = `${PREFIX}${++this.counter}`
    const reason = req.reason ? `（${req.reason}）` : ''
    const minutes = Math.max(1, Math.round(this.cfg.approvalTimeoutMs / 60000))
    const text = `⚠️ 需要你的审批：\n操作：${req.toolName}${reason}\n\n（${minutes} 分钟内有效，超时自动拒绝）`

    try {
      await this.sendKeyboard(chat, text, [
        { id: `${requestId}:${ACTION_ALLOW}`, label: '✅ 允许一次', action: ACTION_ALLOW },
        { id: `${requestId}:${ACTION_ALWAYS}`, label: '⭐ 始终允许', action: ACTION_ALWAYS },
        { id: `${requestId}:${ACTION_REJECT}`, label: '❌ 拒绝', action: ACTION_REJECT },
      ])
    } catch (err) {
      this.log.error('审批按钮发送失败（fail-closed → unavailable）:', err?.message)
      return 'unavailable'
    }

    // 等待按钮回调；超时 fail-closed
    return new Promise((resolve) => {
      const timer = this.ctx.timer.timeout(() => {
        this.pending.delete(requestId)
        this.log.warn(`审批 ${requestId} 超时（${this.cfg.approvalTimeoutMs}ms），自动拒绝`)
        resolve('unavailable')
      }, this.cfg.approvalTimeoutMs)
      this.pending.set(requestId, {
        chat,
        // 发起审批时的最近入站作者（审批点击者身份校验：只有发起者能点）
        initiator: this.sessionMap.authorFor(chat.chatKey) || '',
        resolve: (outcome) => {
          this.pending.delete(requestId)
          timer()
          resolve(outcome)
        },
        settled: false,
      })
    })
  }

  /**
   * 按钮回调入口（index.js 从 router 的 INTERACTION_CREATE 分流）。
   * @param {string} dataId 按钮 id（'qq_apv_<n>:<action>'）
   * @param {string} [clicker] 点击者 openid（INTERACTION_CREATE 事件 user.id）
   * @returns {boolean} 是否本桥消费（是 → 不再进消息管线）
   *
   * ⚠️ 安全：校验点击者身份——按钮 id 只编码 requestId，若不禁身份，
   *    群聊里任何成员都能点 ⭐「始终允许」把群会话 policy 切到 never。
   *    校验规则：有发起者且有点击者时两者必须一致；任一缺失则放行（防误伤）。
   */
  onInteraction(dataId, clicker = '') {
    const m = new RegExp(`^${PREFIX}(\\d+):(${ACTION_ALLOW}|${ACTION_ALWAYS}|${ACTION_REJECT})$`).exec(dataId)
    if (!m) return false
    const [, n, action] = m
    const entry = this.pending.get(`${PREFIX}${n}`)
    if (!entry) return true // 已过期/已处理：吞掉，不打扰用户
    if (entry.settled) return true
    if (entry.initiator && clicker && entry.initiator !== clicker) {
      this.log.warn(`审批点击者身份不符，忽略（initiator=${entry.initiator} clicker=${clicker}）`)
      return true
    }
    entry.settled = true

    if (action === ACTION_ALLOW) {
      entry.resolve('allowed-once')
    } else if (action === ACTION_REJECT) {
      entry.resolve('rejected')
    } else if (action === ACTION_ALWAYS) {
      // 「始终允许」：把该 agent 的 approval policy 切到 'never'（可 /revoke 撤销）
      const agent = this.liveAgent(entry.chat)
      if (agent) {
        try {
          this.ctx.approval.setPolicy(agent, 'never')
          this.log.info('已设置始终允许（policy=never）')
        } catch (err) {
          this.log.error('setPolicy(never) 失败:', err?.message)
        }
      }
      entry.resolve('allowed-once') // 本次放行 + 后续不再询问
    }
    return true
  }

  /** 按 chat 找 live agent（session-map entries 里的 handle）。 */
  liveAgent(chat) {
    return this.sessionMap.agentForChat(chat)
  }

  /** /approve：允许当前待审批操作一次（仅本 chat 的 pending）。 */
  approveOnce(chatKey) {
    const chat = this.sessionMap.chatForChatKey(chatKey)
    for (const [requestId, entry] of this.pending) {
      if (entry.settled) continue
      if (chat && entry.chat.chatKey === chatKey) {
        entry.settled = true
        entry.resolve('allowed-once')
        this.log.info(`/approve：允许 ${requestId}`)
        return true
      }
    }
    return false
  }

  /** /always：该 chat 的 agent 切 policy=never（始终允许）。 */
  setAlways(chat) {
    const agent = this.sessionMap.agentForChat(chat)
    if (!agent) return false
    try {
      this.ctx.approval.setPolicy(agent, 'never')
      return true
    } catch (err) {
      this.log.error('setPolicy(never) 失败:', err?.message)
      return false
    }
  }

  /** /revoke：撤销「始终允许」，恢复逐次审批（policy=ask）。 */
  revoke(chat) {
    const agent = this.sessionMap.agentForChat(chat)
    if (!agent) return false
    try {
      this.ctx.approval.setPolicy(agent, 'ask')
      return true
    } catch (err) {
      this.log.error('setPolicy(ask) 失败:', err?.message)
      return false
    }
  }
}
