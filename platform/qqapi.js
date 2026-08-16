/**
 * QQ OpenAPI 封装：token / gateway / 发消息（msg_seq、错误退避）。
 *
 * 协议要点（设计文档 §7，均已核实）：
 *   - token：POST https://bots.qq.com/app/getAppAccessToken {appId, clientSecret}
 *            → access_token + expires_in；提前 60s 定时刷新，仅存内存
 *   - gateway：GET {endpoint}/gateway；沙箱 https://sandbox.api.sgroup.qq.com，
 *              正式 https://api.sgroup.qq.com
 *   - 发消息三处 POST 均必带 msg_seq（防重放，缺失直接 500）：自增计数，不用固定值
 *   - 频控错误码 50015014「系统繁忙」= 平台频控：指数退避重试（5s → 10s → 20s → 上限 60s）
 *   - 11255（私域机器人 / 沙箱外人员）= 永久性错误，不重试，仅记录
 *
 * 运行环境：Node 22（全局 fetch）。token 刷新定时器用 ctx.timer（卸载自动清理）。
 */

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const TOKEN_TTL_MARGIN_MS = 60_000 // 提前 60s 刷新
const REFRESH_CHECK_MS = 30_000 // 每 30s 检查一次是否需要刷新
/** 官方建议发消息接口 timeout 最低 5s；统一 10s 兜底防挂死。 */
const HTTP_TIMEOUT_MS = 10_000

/** fetch + AbortController 超时（防接口挂起导致整条链路卡死）。 */
async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`QQ API 请求超时（${HTTP_TIMEOUT_MS}ms）: ${url}`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** 频控退避：重试次数 → 等待毫秒。 */
const RATE_LIMIT_BACKOFF = [5_000, 10_000, 20_000, 30_000, 60_000]

export class QQApi {
  /**
   * @param {object} opts
   * @param {string} opts.id          AppID
   * @param {string} opts.secret      AppSecret（明文或 secretEnv 解析后）
   * @param {boolean} opts.sandbox    沙箱 / 正式
   * @param {object} opts.logger      makeLogger 产物
   * @param {object} opts.timer       ctx.timer（timeout/interval 返回 disposer）
   */
  constructor({ id, secret, sandbox, logger, timer }) {
    this.appId = id
    this.secret = secret
    this.sandbox = !!sandbox
    this.log = logger
    this.timer = timer

    this.token = null // access_token（仅内存）
    this.tokenExpiresAt = 0 // epoch ms
    this.gatewayUrl = null

    this.endpoint = this.sandbox
      ? 'https://sandbox.api.sgroup.qq.com'
      : 'https://api.sgroup.qq.com'

    this.seqCounter = 0 // msg_seq 自增（防重放）
    this._refreshDisposer = null
    this._stopped = false
  }

  /** msg_seq：每 bot 实例自增计数（设计文档 §7：不用固定值 1）。 */
  nextSeq() {
    this.seqCounter = (this.seqCounter + 1) % 2 ** 31
    return this.seqCounter
  }

  /** 启动 token 定时刷新循环（幂等；stop() 后不再刷新）。 */
  startTokenRefresh() {
    if (this._refreshDisposer) return
    this._refreshDisposer = this.timer.interval(() => {
      if (this._stopped) return
      if (Date.now() + TOKEN_TTL_MARGIN_MS >= this.tokenExpiresAt) {
        this.refreshToken().catch((err) => this.log.error('token 刷新失败', err?.message))
      }
    }, REFRESH_CHECK_MS)
  }

  stop() {
    this._stopped = true
    this._refreshDisposer?.()
    this._refreshDisposer = null
  }

  /**
   * 获取（或缓存）access_token。
   * 首次调用强制拉取；之后若未过期直接返回缓存。
   */
  async getAccessToken(force = false) {
    if (!force && this.token && Date.now() + TOKEN_TTL_MARGIN_MS < this.tokenExpiresAt) {
      return this.token
    }
    return this.refreshToken()
  }

  /** POST getAppAccessToken，更新内存 token。 */
  async refreshToken() {
    const res = await fetchWithTimeout(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.secret }),
    })
    if (!res.ok) {
      throw new Error(`getAppAccessToken HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    }
    const data = await res.json()
    if (!data.access_token) {
      throw new Error(`getAppAccessToken 响应缺少 access_token: ${JSON.stringify(data).slice(0, 200)}`)
    }
    this.token = data.access_token
    this.tokenExpiresAt = Date.now() + (Number(data.expires_in) || 7200) * 1000
    this.log.debug('token 已刷新，有效期', Math.round((this.tokenExpiresAt - Date.now()) / 1000), 's')
    return this.token
  }

  /** GET {endpoint}/gateway，取 WS 网关地址（缓存）。 */
  async getGateway() {
    if (this.gatewayUrl) return this.gatewayUrl
    const token = await this.getAccessToken()
    const res = await fetchWithTimeout(`${this.endpoint}/gateway`, {
      headers: { Authorization: `QQBot ${token}` },
    })
    if (!res.ok) {
      throw new Error(`gateway HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    }
    const data = await res.json()
    if (!data.url) throw new Error('gateway 响应缺少 url')
    this.gatewayUrl = data.url
    this.log.debug('gateway:', this.gatewayUrl)
    return this.gatewayUrl
  }

  /**
   * 发送消息（统一入口）。
   *
   * @param {{kind: 'user'|'group'|'channel', id: string}} chat 目标
   * @param {object} payload
   * @param {Array<{type: 'text'|'image'|'file', text?: string}>} payload.blocks 出站块（当前只发 text）
   * @param {boolean} [payload.passive] 是否被动回复（带 msg_id，限 replyPassiveLimit 次/消息）
   * @param {string} [payload.msgId]    被动回复时携带的入站消息 id
   * @param {object} [payload.keyboard] 消息内嵌按钮（审批桥用）
   * @returns {Promise<object|null>} 平台返回体（发失败且重试耗尽返回 null，不抛出——出站不致命）
   */
  async sendMessage(chat, { blocks = [], passive = false, msgId, keyboard } = {}) {
    const text = blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (!text) return null

    const body = {
      content: text,
      // ⚠️ msg_type 按会话类型区分（官方文档实锤）：
      //   v2 单聊/群聊：0 = 纯文本（content），2 = Markdown（需模板权限）
      //   频道（旧 guild 接口 /channels/{id}/messages）：1 = 文本
      //   旧实现写死 1，导致 C2C/群发消息报 40034127「无markdown模板权限」
      msg_type: chat.kind === 'channel' ? 1 : 0,
      msg_seq: this.nextSeq(),
    }
    if (passive && msgId) body.msg_id = msgId
    if (keyboard) body.keyboard = keyboard

    const url = this.messageUrl(chat)
    const token = await this.getAccessToken()
    return this.postWithRetry(url, token, body, chat)
  }

  /** 按会话类型拼消息 URL（三处 POST 均必带 msg_seq，已在 body 里）。 */
  messageUrl(chat) {
    if (chat.kind === 'group') return `${this.endpoint}/v2/groups/${chat.id}/messages`
    if (chat.kind === 'channel') return `${this.endpoint}/channels/${chat.id}/messages`
    return `${this.endpoint}/v2/users/${chat.id}/messages`
  }

  /**
   * 互动事件回应（官方要求：type=11 按钮 / 12 快捷菜单 收到后必须 PUT /interactions/{id}，
   * 否则客户端一直 loading 直到超时；同一 id 只能回应一次）。
   * @param {string} interactionId 事件外层 d.id
   */
  async ackInteraction(interactionId) {
    if (!interactionId) return
    try {
      const token = await this.getAccessToken()
      const res = await fetchWithTimeout(`${this.endpoint}/interactions/${interactionId}`, {
        method: 'PUT',
        headers: { Authorization: `QQBot ${token}` },
      })
      if (!res.ok) {
        this.log.warn(`互动回应失败 HTTP ${res.status}: ${await res.text().catch(() => '')}`)
      }
    } catch (err) {
      this.log.error('互动回应异常:', err?.message)
    }
  }

  /**
   * POST 统一带退避重试：
   *   - 401/403 → 刷新 token 后重试一次
   *   - 50015014（频控）→ 指数退避重试
   *   - 11255（私域/沙箱外人员）→ 永久错误，不重试
   *   - 其余 → 记录日志不重试
   */
  async postWithRetry(url, token, body, chat) {
    const attempt = async (authToken, isRetry) => {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          Authorization: `QQBot ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        return res.json().catch(() => null)
      }
      const text = await res.text().catch(() => '')
      let code = null
      try {
        code = JSON.parse(text).code ?? null
      } catch {
        /* 非 JSON 响应 */
      }
      return { _status: res.status, _code: code, _text: text.slice(0, 300) }
    }

    let result = await attempt(token, false)
    // token 失效：刷新后重试一次
    if (result && typeof result === 'object' && '_status' in result && [401, 403].includes(result._status)) {
      this.log.warn('token 失效，刷新后重试')
      const fresh = await this.refreshToken().catch(() => null)
      if (fresh) result = await attempt(fresh, true)
    }
    // 频控 50015014：指数退避重试
    let backoffIndex = 0
    while (
      result && typeof result === 'object' && '_code' in result && result._code === 50015014 &&
      backoffIndex < RATE_LIMIT_BACKOFF.length
    ) {
      const wait = RATE_LIMIT_BACKOFF[backoffIndex]
      this.log.warn(`平台频控 50015014，${wait / 1000}s 后重试 (${backoffIndex + 1}/${RATE_LIMIT_BACKOFF.length})`)
      await sleep(wait)
      const freshToken = await this.getAccessToken().catch(() => token)
      result = await attempt(freshToken, true)
      backoffIndex += 1
    }

    if (result && typeof result === 'object' && '_status' in result) {
      const { _status, _code, _text } = result
      if (_code === 11255) {
        this.log.error(`发送失败 code=11255（永久性错误：私域机器人或发送者不在沙箱/测试人员名单）: ${_text}`)
      } else {
        this.log.error(`发送失败 HTTP ${_status} code=${_code}: ${_text}`)
      }
      return null
    }
    this.log.debug('发送成功 →', chat.kind, chat.id, 'seq', body.msg_seq)
    return result
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
