/**
 * 事件路由：频道@ / 群@ / 单聊 / 按钮回调 → 标准消息对象（设计文档 §5 / §6）。
 *
 * 事件路由表：
 *   AT_MESSAGE_CREATE        → channel 会话（需 guild_id + channel_id）
 *   GROUP_AT_MESSAGE_CREATE  → group 会话（group_openid，平台哈希）
 *   C2C_MESSAGE_CREATE       → user 会话（openid，bot 维度哈希）
 *   INTERACTION_CREATE       → 审批按钮回调（与消息路由分开处理）
 *
 * ⚠️ payload 字段名（openid 等）在不同环境/版本可能有差异，此处按官方文档
 *    常见字段宽容解析；真实事件流抓取后若有出入，只需在本文件修正（VERIFICATION §12）。
 */

/** 群聊/频道文本里的 @提及标记（<@!openid>），投给 agent 前剔除。 */
const MENTION_RE = /<@![^>]*>/g

/**
 * 路由一个 op0 dispatch 事件。
 *
 * @returns {null | {message: object} | {interaction: {dataId: string}}}
 *   - message: 标准消息对象（含 chatKey / text / replyTo）
 *   - interaction: 审批按钮回调（由 approval 桥消费，不进 agent 管线）
 */
export function routeEvent(dispatch) {
  const type = dispatch?.t
  const d = dispatch?.d
  if (!d || typeof d !== 'object') return null

  switch (type) {
    case 'C2C_MESSAGE_CREATE':
      return routeC2C(d)
    case 'GROUP_AT_MESSAGE_CREATE':
      return routeGroup(d)
    case 'AT_MESSAGE_CREATE':
      return routeChannel(d)
    case 'INTERACTION_CREATE':
      return routeInteraction(d)
    default:
      return null // 其余事件（READY 之外的系统事件等）忽略
  }
}

function routeC2C(d) {
  const openid = d.author?.user_openid || d.author?.openid || d.author?.member_openid
  if (!openid) return null
  const text = cleanContent(d.content)
  if (!text) return null
  return {
    message: {
      id: d.id,
      chat: { kind: 'user', id: openid, name: d.author?.nickname || openid },
      chatKey: `qq:user:${openid}`,
      content: [{ type: 'text', text }],
      authorOpenid: openid,
      // ⚠️ 被动回复 msg_id 取事件的 d.id（官方文档：C2C_MESSAGE_CREATE 等事件的 d.id），
      //    不是 d.msg_id——取错会导致带错 msg_id 发消息被平台拒绝
      replyTo: { chatId: 'user', messageId: d.id },
    },
  }
}

function routeGroup(d) {
  const groupOpenid = d.group_openid
  if (!groupOpenid) return null
  const text = cleanContent(d.content)
  if (!text) return null
  return {
    message: {
      id: d.id,
      chat: { kind: 'group', id: groupOpenid, name: d.group_openid || groupOpenid },
      chatKey: `qq:group:${groupOpenid}`,
      content: [{ type: 'text', text }],
      authorOpenid: d.author?.member_openid || d.author?.user_openid || d.author?.id || '',
      replyTo: { chatId: 'group', messageId: d.id },
    },
  }
}

function routeChannel(d) {
  const channelId = d.channel_id
  const guildId = d.guild_id
  if (!channelId) return null
  const text = cleanContent(d.content)
  if (!text) return null
  return {
    message: {
      id: d.id,
      chat: { kind: 'channel', id: channelId, guildId, name: `频道 ${channelId}` },
      chatKey: `qq:channel:${guildId}:${channelId}`,
      content: [{ type: 'text', text }],
      replyTo: { chatId: 'channel', messageId: d.id },
    },
  }
}

/**
 * 按钮回调：取出按钮 data.id、互动 id 与点击者 openid（审批桥校验身份用）。
 * ⚠️ 官方字段实锤（bot.q.qq.com 互动事件）：
 *   - 按钮 id：data.resolved.button_id（原取 data.id / data.button_data.id 取不到）
 *   - 点击者：user_openid（单聊）/ group_member_openid（群聊）/ data.resolved.user_id（频道）
 *   - 互动 id：事件外层 d.id（用于 PUT /interactions/{id} 回应）
 */
function routeInteraction(d) {
  const dataId =
    d.data?.resolved?.button_id ||
    d.data?.resolved?.button_data ||
    d.data?.id ||
    d.data?.button_data?.id ||
    d.data?.data?.id
  if (!dataId) return null
  const clicker =
    d.user_openid ||
    d.group_member_openid ||
    d.data?.resolved?.user_id ||
    d.user?.id ||
    d.user?.openid ||
    d.user?.user_openid ||
    d.user?.member_openid ||
    ''
  return {
    interaction: {
      dataId: String(dataId),
      clicker: String(clicker),
      interactionId: d.id ? String(d.id) : '', // PUT /interactions/{id} 回应用
      type: d.type, // 11=消息按钮点击 等；仅 11/12 需回应
    },
  }
}

/** 消息清洗：去 <@!openid> 提及标记后 trim。 */
function cleanContent(content) {
  return String(content || '').replace(MENTION_RE, '').trim()
}
