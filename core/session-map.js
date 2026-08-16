/**
 * 聊天对象 ↔ dsh session 映射与生命周期（设计文档 §5 / §7）。
 *
 * 设计要点：
 *   - chatKey 由 router 生成（'qq:user:<openid>' / 'qq:group:<group_openid>' /
 *     'qq:channel:<guildId>:<channelId>'），sessionId 与之对齐且前缀 'qq:'，
 *     与 Web UI 会话天然隔离
 *   - 会话隔离：workspaceIsolation=true 时每个 chatKey 用 <cwd>/<chatKey>/ 子目录
 *   - agent 生命周期（签名已实锤 rc.6）：
 *       create:  workspaceRegistry.create(cwd) → agents.create({sessionId, meta:{cwd, agentPreset},
 *                agentOptions:{provider, model}, setup: agentCtx => agentPresets.mount(agentCtx, preset)})
 *       resume:  agents.resume({resumeSessionId, setup: mount})（懒恢复，收到消息才 resume）
 *       followup: agent.followup(createUserMessage({content:[{type:'text',text}],
 *                source:{kind:'plugin', plugin:'dsh-im-qq'}}))
 *   - 幂等恢复（引擎重启）：映射持久化到 <cwd>/.qq-sessions.json，onStart 读回；
 *     live agent 用 ctx.agents.get(sessionId) 复用，不重复创建
 *   - /new 重置：dispose 旧 agent，generation+1 生成新 sessionId（历史会话保留在磁盘）
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const SESSIONS_FILE = '.qq-sessions.json'

/** chatKey → 目录名（去 ':' 等文件系统非法字符，Windows 也安全）。 */
function safeSegment(chatKey) {
  return chatKey.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/** 从 chatKey 反解析 chat（恢复映射用；name 无法持久化，发消息只需 kind+id）。 */
function parseChatKey(chatKey) {
  const m = /^qq:(user|group|channel):(.+)$/.exec(chatKey)
  if (!m) return null
  const kind = m[1]
  if (kind === 'channel') {
    const [guildId, channelId] = m[2].split(':')
    if (!channelId) return null
    return { kind, id: channelId, guildId }
  }
  return { kind, id: m[2] }
}

export class SessionMap {
  /**
   * @param {object} opts
   * @param {object} opts.ctx     Cordis ctx（agents / agentPresets / workspaceRegistry）
   * @param {object} opts.config  插件配置（cwd / workspaceIsolation / provider / model / agentPreset）
   * @param {object} opts.logger
   */
  constructor({ ctx, config, logger }) {
    this.ctx = ctx
    this.cfg = config
    this.log = logger
    this.entries = new Map() // chatKey → { sessionId, generation, chat, handle, createdAt }
    this.inflight = new Map() // chatKey → promise（防并发创建）
    this.authors = new Map() // chatKey → 最近一条入站消息的作者 openid（审批点击者身份校验用）
    this.mapFile = null
    this.outbound = null // index.js 组装后注入（被动回复预算）
  }

  setOutbound(outbound) {
    this.outbound = outbound
  }

  /** onStart：初始化映射文件路径并从磁盘恢复（幂等可重入）。 */
  init(cwd) {
    this.mapFile = join(cwd, SESSIONS_FILE)
    this.restore()
  }

  /** 从 .qq-sessions.json 恢复映射（agent 懒恢复，收到消息才 resume）。 */
  restore() {
    if (!this.mapFile || !existsSync(this.mapFile)) return
    try {
      const data = JSON.parse(readFileSync(this.mapFile, 'utf8'))
      for (const [chatKey, rec] of Object.entries(data || {})) {
        const chat = parseChatKey(chatKey)
        if (!chat) continue
        // sessionId 可能为 null（/new 后未发新消息就重启）：保留 generation，
        // 下次 deliver 时用 generation 生成新会话 id，避免与磁盘旧日志冲突
        this.entries.set(chatKey, {
          sessionId: rec.sessionId ?? null,
          generation: rec.generation ?? 0,
          chat,
          handle: null, // 懒恢复
          createdAt: rec.createdAt ?? Date.now(),
        })
      }
      this.log.info(`已恢复 ${this.entries.size} 个 QQ 会话映射`)
    } catch (err) {
      this.log.error('恢复会话映射失败（将重新开始）:', err?.message)
      this.entries.clear()
    }
  }

  /** 持久化映射（chatKey → sessionId / generation）。写失败不影响主流程。 */
  save() {
    if (!this.mapFile) return
    try {
      const data = {}
      for (const [chatKey, e] of this.entries) {
        data[chatKey] = { sessionId: e.sessionId, generation: e.generation, createdAt: e.createdAt }
      }
      writeFileSync(this.mapFile, JSON.stringify(data, null, 2), 'utf8')
    } catch (err) {
      this.log.error('保存会话映射失败:', err?.message)
    }
  }

  /** 会话信息（/me 命令）。 */
  info(chatKey) {
    const e = this.entries.get(chatKey)
    return e
      ? { sessionId: e.sessionId, createdAt: e.createdAt, live: !!e.handle }
      : { sessionId: '(未创建)', createdAt: null, live: false }
  }

  /** sessionId 反查 chat（outbound / approval 用）；附带 chatKey 便于匹配。 */
  chatForSession(sessionId) {
    for (const [chatKey, e] of this.entries) {
      if (e.sessionId === sessionId) return { ...e.chat, chatKey }
    }
    return null
  }

  /** chatKey 反查 chat（approval / slash 用）。 */
  chatForChatKey(chatKey) {
    const e = this.entries.get(chatKey)
    return e ? { ...e.chat, chatKey } : null
  }

  /** 记录该 chatKey 最近一条入站消息的作者 openid（审批身份校验）。 */
  setAuthor(chatKey, openid) {
    if (openid) this.authors.set(chatKey, openid)
  }

  /** 该 chatKey 最近消息的作者 openid（无则 undefined → 审批退化为不校验身份）。 */
  authorFor(chatKey) {
    return this.authors.get(chatKey)
  }

  /** chat 找 live agent（approval 桥用）。 */
  agentForChat(chat) {
    const chatKey = chat.chatKey
    const e = chatKey ? this.entries.get(chatKey) : null
    return e?.handle?.agent ?? null
  }

  /**
   * 入站管线入口：确保 agent 就绪并投递用户消息。
   * @param {object} message 标准消息对象（router 产出，含 chatKey / chat / text / replyTo）
   */
  async deliver(message) {
    const chatKey = message.chatKey
    const chat = message.chat
    const text = message.content?.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') || ''

    // 同 chatKey 串行化（防并发 create/resume 竞态）
    const run = async () => this.deliverCore(chatKey, chat, text, message)
    const prev = this.inflight.get(chatKey) || Promise.resolve()
    const cur = prev.then(run, run)
    this.inflight.set(chatKey, cur)
    try {
      return await cur
    } finally {
      if (this.inflight.get(chatKey) === cur) this.inflight.delete(chatKey)
    }
  }

  async deliverCore(chatKey, chat, text, message) {
    let entry = this.entries.get(chatKey)
    this.setAuthor(chatKey, message?.authorOpenid)

    // 1. live agent 复用（⚠️ ctx.agents.get(id) 返回 agent 本身，不是 handle）
    let agent = entry?.sessionId ? this.ctx.agents.get(entry.sessionId) : undefined

    // 2. 无 live：有持久化记录 → resume；无 → create
    if (!agent) {
      if (entry?.sessionId) {
        try {
          const handle = await this.resume(entry.sessionId)
          agent = handle.agent
          entry = { ...entry, handle }
          // ⚠️ 必须写回映射（create 分支有 set+save，resume 分支曾漏掉）：
          //   不写回则 entry.handle 永远为 null → /new 泄漏旧 agent、
          //   /always /revoke 永远失败、/me 永远显示「待唤醒」
          this.entries.set(chatKey, entry)
          this.save()
        } catch (err) {
          // 持久化损坏/缺失：放弃该记录，落回新建会话（generation+1）
          this.log.error(`恢复会话 ${entry.sessionId} 失败，改为新建:`, err?.message)
          entry = null
        }
      }
      if (!agent) {
        const sessionId = this.newSessionId(chatKey, entry?.generation)
        const handle = await this.create(sessionId, chatKey, chat)
        agent = handle.agent
        entry = { sessionId, generation: entry?.generation ?? 0, chat, handle, createdAt: Date.now() }
        this.entries.set(chatKey, entry)
        this.save()
      }
    }

    // 3. 通知 outbound 本轮的被动回复预算（msg_id 只对本条入站消息有效）
    this.outbound?.beginTurn(agent.session.id, message.replyTo?.messageId)

    // 4. 投递（createUserMessage 签名实锤：无 id 字段，content 是 ContentBlock[]）
    const userMessage = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-im-qq' },
    })
    agent.followup(userMessage)
    return agent
  }

  /** 全新会话：workspace 注册（前置两步，避免 workspace-not-found）→ agents.create。 */
  async create(sessionId, chatKey, chat) {
    const wsPath = this.workspacePath(chatKey)
    mkdirSync(wsPath, { recursive: true })
    await this.ctx.workspaceRegistry.create(wsPath, `QQ ${chat.kind} ${chat.id}`)
    this.log.info(`创建新会话 ${sessionId}（cwd: ${wsPath}）`)
    return this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd: wsPath, agentPreset: this.cfg.agentPreset },
      agentOptions: { provider: this.cfg.provider, model: this.cfg.model },
      setup: async (agentCtx) => {
        // 显式 mount（实锤：factory 不自动消费 meta.agentPreset，必须在 setup 里挂）
        await this.ctx.agentPresets.mount(agentCtx, this.cfg.agentPreset)
      },
    })
  }

  /** 恢复持久化会话（懒加载；mount 幂等，重复绑定同 agent 无害）。 */
  async resume(sessionId) {
    this.log.info(`恢复会话 ${sessionId}`)
    // ⚠️ 必须带 agentOptions（provider/model）——resume 不带的话 agent 没有模型，
    //    prompt 组装时 {{model}} 无值 → 回合直接报错（曾实机复现：重启后
    //    一直回「服务暂时不可用」兜底文本）
    return this.ctx.agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: { provider: this.cfg.provider, model: this.cfg.model },
      setup: async (agentCtx) => {
        await this.ctx.agentPresets.mount(agentCtx, this.cfg.agentPreset)
      },
    })
  }

  /**
   * /new：dispose 旧 agent，generation+1；sessionId 置空，
   * 下次 deliver 时新建会话（历史保留在磁盘，新会话用 chatKey#<gen> 避免冲突）。
   */
  async reset(chat) {
    const chatKey = chat.chatKey
    const entry = this.entries.get(chatKey)
    if (entry?.handle) {
      await entry.handle.dispose().catch((err) => this.log.error('dispose 旧 agent 失败:', err?.message))
    }
    const generation = (entry?.generation ?? -1) + 1
    this.entries.set(chatKey, { sessionId: null, generation, chat, handle: null, createdAt: Date.now() })
    this.save()
    this.log.info(`/new：${chatKey} 已重置（generation=${generation}）`)
  }

  /** workspaceIsolation=true 时每个 chatKey 独立子目录，防并发写文件互踩。 */
  workspacePath(chatKey) {
    return this.cfg.workspaceIsolation
      ? join(this.cfg.cwd, safeSegment(chatKey))
      : this.cfg.cwd
  }

  /** sessionId 生成：首个会话 = chatKey，之后 chatKey#<generation>（前缀保持 qq:）。 */
  newSessionId(chatKey, generation = 0) {
    return generation === 0 ? chatKey : `${chatKey}#${generation}`
  }
}
