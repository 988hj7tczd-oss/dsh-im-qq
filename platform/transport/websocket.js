/**
 * QQ WS 网关（当前默认 transport，设计文档 §5 / §7）。
 *
 * 协议要点（均已核实）：
 *   - op10(hello) 收 heartbeat_interval → op2 identify {token:'QQBot xxx', intents, shard:[0,1]}
 *   - 心跳 op1 携带 last_sequence；op11(HEARTBEAT_ACK) 确认
 *   - op7(RECONNECT)：可 RESUME（带 session_id + seq 恢复）
 *   - op9(INVALID_SESSION)：session 失效，必须全新 identify（不带 session_id）
 *   - 服务器约每 30min 主动关 WS（close code 4009 "Session timed out"）= 正常行为，自动恢复
 *   - intents：PUBLIC_GUILD_MESSAGES(1<<30) + USER_MESSAGE(1<<25) + INTERACTION_CREATE(1<<26)
 *   - 断线重连：指数退避（1s → 2s → 4s → … → 上限 30s）
 *
 * 运行环境：Node 22（全局 WebSocket，undici 实现）。定时器用 ctx.timer（卸载自动清理）。
 */

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE: 3,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
}

/** 频道/群/单聊/按钮回调所需全部事件。 */
const INTENTS = (1 << 30) | (1 << 25) | (1 << 26)

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000
/** 心跳超时判定：超过 2 个心跳周期未收到 ack 视为断线。 */
const HEARTBEAT_ACK_TIMEOUT_FACTOR = 2

export class QQWebSocketTransport {
  /**
   * @param {object} opts
   * @param {object} opts.qqapi    QQApi 实例（token / gateway）
   * @param {object} opts.logger   makeLogger 产物
   * @param {object} opts.timer    ctx.timer
   * @param {(dispatch: object) => void} opts.onEvent  每个 op0 dispatch 事件（含 t/d/s）
   */
  constructor({ qqapi, logger, timer, onEvent }) {
    this.qqapi = qqapi
    this.log = logger
    this.timer = timer
    this.onEvent = onEvent

    this.ws = null
    this.sequence = null // 最近收到的服务端 seq（dispatch 的 s）
    this.sessionId = null // READY 后赋值，RESUME 用
    this.resumable = false // op9 后置 false（必须重 identify）
    this.heartbeatIntervalMs = 0
    this.heartbeatTimer = null
    this.lastAckAt = 0
    this.awaitingAck = false
    this.reconnectAttempt = 0
    this.reconnectTimer = null
    this.stopped = false
  }

  /** 启动：取 token + gateway → 建立连接 + 启动 token 刷新。失败 30s 后自动重试。 */
  async start() {
    if (this.stopped) return
    this.qqapi.startTokenRefresh()
    try {
      await this.qqapi.getAccessToken()
      const url = await this.qqapi.getGateway()
      this.connect(url)
    } catch (err) {
      this.log.error('transport 启动失败，30s 后重试:', err?.message)
      this.reconnectTimer = this.timer.timeout(() => {
        this.reconnectTimer = null
        this.start()
      }, RECONNECT_MAX_MS)
    }
  }

  connect(url = this.qqapi.gatewayUrl) {
    if (this.stopped) return
    this.log.info(`连接 WS 网关… (attempt ${this.reconnectAttempt + 1})`)
    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      this.log.info('WS 已连接，等待 hello(op10)…')
    }

    ws.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        this.log.warn('无法解析 WS 帧:', String(ev.data).slice(0, 200))
        return
      }
      this.handleMessage(msg)
    }

    ws.onclose = (ev) => {
      this.log.warn(`WS 关闭 code=${ev.code} reason=${ev.reason || ''}`)
      if (ev.code === 4009) {
        // QQ 服务器约每 30min 主动关闭（"Session timed out"）——正常行为，非 bug
        this.log.info('code=4009（Session timed out）：服务器周期断连，自动恢复')
      }
      if (this.ws === ws) this.ws = null
      this.stopHeartbeat()
      this.scheduleReconnect()
    }

    ws.onerror = (err) => {
      this.log.error('WS 错误:', err?.message || err)
    }
  }

  handleMessage(msg) {
    switch (msg.op) {
      case OP.HELLO: {
        this.heartbeatIntervalMs = msg.d?.heartbeat_interval ?? 41_000
        this.log.debug('hello: heartbeat_interval =', this.heartbeatIntervalMs)
        this.startHeartbeat()
        this.identify()
        break
      }
      case OP.DISPATCH: {
        this.sequence = msg.s
        if (msg.t === 'READY') {
          this.sessionId = msg.d?.session_id ?? null
          this.resumable = true
          this.reconnectAttempt = 0 // 连接稳定，重置退避
          this.log.info('WS READY, session_id =', this.sessionId?.slice(0, 8) + '…')
        } else if (msg.t === 'RESUMED') {
          this.resumable = true
          this.reconnectAttempt = 0
          this.log.info('WS RESUMED（会话恢复成功）')
        }
        if (this.onEvent) this.onEvent(msg)
        break
      }
      case OP.HEARTBEAT_ACK: {
        this.awaitingAck = false
        this.lastAckAt = Date.now()
        break
      }
      case OP.RECONNECT: {
        // op7：服务器要求重连，可 RESUME
        this.log.warn('收到 op7(reconnect)，主动重连（将尝试 RESUME）')
        this.resumable = true
        this.ws?.close(4000, 'op7 reconnect')
        break
      }
      case OP.INVALID_SESSION: {
        // op9：session 失效，必须全新 identify（不能带 session_id）
        this.log.warn('收到 op9(invalid session)，session 失效，将全新 identify')
        this.resumable = false
        this.sessionId = null
        this.sequence = null
        this.ws?.close(4000, 'op9 invalid session')
        break
      }
      default:
        this.log.debug('未处理 op:', msg.op)
    }
  }

  /** 心跳循环：每 heartbeat_interval 发 op1；超过 2 周期未 ack 判定断线重连。 */
  startHeartbeat() {
    this.stopHeartbeat()
    this.awaitingAck = false
    this.lastAckAt = Date.now()
    this.heartbeatTimer = this.timer.interval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
      if (this.awaitingAck && Date.now() - this.lastAckAt > this.heartbeatIntervalMs * HEARTBEAT_ACK_TIMEOUT_FACTOR) {
        this.log.warn('心跳超时（未收到 ack），强制重连')
        this.ws.close(4000, 'heartbeat timeout')
        return
      }
      this.awaitingAck = true
      try {
        this.ws.send(JSON.stringify({ op: OP.HEARTBEAT, d: this.sequence ?? null }))
      } catch (err) {
        this.log.error('心跳发送失败', err?.message)
      }
    }, this.heartbeatIntervalMs)
  }

  stopHeartbeat() {
    this.heartbeatTimer?.()
    this.heartbeatTimer = null
  }

  /** identify / resume 二选一：resumable 且有 session_id 时走 RESUME，否则全新 IDENTIFY。 */
  identify() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const token = `QQBot ${this.qqapi.token}`
    if (this.resumable && this.sessionId) {
      this.log.info('发起 RESUME(seq=' + this.sequence + ')')
      this.ws.send(JSON.stringify({
        op: OP.RESUME,
        d: { token, session_id: this.sessionId, seq: this.sequence ?? null },
      }))
    } else {
      this.log.info('发起 IDENTIFY（全新会话）')
      this.ws.send(JSON.stringify({
        op: OP.IDENTIFY,
        d: { token, intents: INTENTS, shard: [0, 1] },
      }))
    }
  }

  /** 断线重连：指数退避（1s → 2s → … → 30s 上限）。 */
  scheduleReconnect() {
    if (this.stopped) return
    this.reconnectTimer?.()
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt)
    this.reconnectAttempt += 1
    this.log.info(`${delay / 1000}s 后重连…`)
    this.reconnectTimer = this.timer.timeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  /** 插件卸载/停止：关闭连接、清定时器。 */
  stop() {
    this.stopped = true
    this.stopHeartbeat()
    this.reconnectTimer?.()
    this.reconnectTimer = null
    try {
      this.ws?.close(4000, 'dsh-im-qq stop')
    } catch {
      /* ignore */
    }
    this.ws = null
  }
}
