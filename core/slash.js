/**
 * 斜杠命令（设计文档 §8 slashCommands / §9.2 撤销）。
 *
 * 命令集：/help /ping /me /new /approve /always /revoke
 *   - /new      开启新会话（清空上下文；历史保留在磁盘）
 *   - /approve  允许当前待审批操作一次（文本兜底，等价 ✅ 按钮）
 *   - /always   始终允许后续审批（等价 ⭐ 按钮，policy=never）
 *   - /revoke   撤销「始终允许」，恢复逐次审批（policy=ask）
 */

const HELP = `🤖 dsh-im-qq 可用命令：
/help — 显示本帮助
/ping — 连通性测试
/me — 当前会话信息
/new — 开启新会话（清空上下文）
/approve — 允许当前待审批操作一次
/always — 始终允许后续审批（/revoke 可撤销）
/revoke — 撤销「始终允许」`

export class Slash {
  /**
   * @param {object} opts
   * @param {object} opts.ctx           Cordis ctx
   * @param {object} opts.config         插件配置
   * @param {object} opts.logger
   * @param {object} opts.sessionMap     会话映射（reset / info）
   * @param {object|null} opts.approvalBridge 审批桥（/approve /always /revoke）
   */
  constructor({ ctx, config, logger, sessionMap, approvalBridge }) {
    this.ctx = ctx
    this.cfg = config
    this.log = logger
    this.sessionMap = sessionMap
    this.approvalBridge = approvalBridge
  }

  /**
   * 尝试处理斜杠命令。
   * @param {object} chat  标准消息 chat（含 chatKey）
   * @param {string} text  清洗后的消息文本
   * @returns {Promise<null | {reply: string}>} null = 不是命令，走 agent 管线
   */
  async handle(chat, text) {
    const t = (text || '').trim()
    if (!t.startsWith('/')) return null
    const [cmd] = t.split(/\s+/)
    switch (cmd.toLowerCase()) {
      case '/help':
        return { reply: HELP }
      case '/ping':
        return { reply: 'pong 🏓' }
      case '/me': {
        const info = this.sessionMap.info(chat.chatKey)
        const created = info.createdAt ? new Date(info.createdAt).toLocaleString() : '—'
        return { reply: `📋 会话：${info.sessionId}\n创建时间：${created}\n状态：${info.live ? '🟢 活跃' : '⚪ 待唤醒'}` }
      }
      case '/new': {
        // 等待旧 agent 真正 dispose 完成再回复（避免旧 agent 泄漏/并发写文件）
        await this.sessionMap.reset(chat).catch((err) => this.log.error('/new 失败:', err?.message))
        return { reply: '🆕 已开启新会话，上下文已清空（历史记录保留在磁盘）。' }
      }
      case '/approve': {
        if (!this.approvalBridge) return { reply: '审批桥未启用（config.approval=false）' }
        const ok = this.approvalBridge.approveOnce(chat.chatKey)
        return { reply: ok ? '✅ 已允许该操作一次' : '当前没有待审批的操作。' }
      }
      case '/always': {
        if (!this.approvalBridge) return { reply: '审批桥未启用（config.approval=false）' }
        const ok = this.approvalBridge.setAlways(chat)
        return { reply: ok ? '⭐ 已设置始终允许，后续操作不再询问（/revoke 可撤销）' : '当前没有活跃会话可设置。' }
      }
      case '/revoke': {
        if (!this.approvalBridge) return { reply: '审批桥未启用（config.approval=false）' }
        const ok = this.approvalBridge.revoke(chat)
        return { reply: ok ? '↩️ 已撤销「始终允许」，恢复逐次审批。' : '当前没有活跃会话可撤销。' }
      }
      default:
        return { reply: `❓ 未知命令 ${cmd}，发送 /help 查看帮助` }
    }
  }
}
