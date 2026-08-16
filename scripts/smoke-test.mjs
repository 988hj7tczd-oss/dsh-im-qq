/**
 * 冒烟测试（无真实平台/dsh 运行时）：mock dsh 服务，验证核心逻辑。
 *
 * 运行：node scripts/smoke-test.mjs
 * 覆盖：router 事件路由 / acl fail-closed / util 清洗分段 /
 *       qqapi URL 与 seq / session-map 生命周期 / outbound 合并与兜底 /
 *       approval 按钮回调解析
 */
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { routeEvent } from '../platform/router.js'
import { QQApi } from '../platform/qqapi.js'
import { Acl } from '../core/acl.js'
import { SessionMap } from '../core/session-map.js'
import { Outbound } from '../core/outbound.js'
import { ApprovalBridge } from '../core/approval.js'
import { Slash } from '../core/slash.js'
import { chunkText, stripInternalTags, textFromBlocks } from '../lib/util.js'

let passed = 0
let failed = 0
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log('  ✓', name) }
  else { failed++; console.log('  ✗', name, extra) }
}

function makeTimer() {
  const timers = []
  const timer = {
    timeout: (fn, ms) => { const h = { fn, ms, cancelled: false }; timers.push(h); return () => { h.cancelled = true } },
    interval: (fn, ms) => { const h = { fn, ms, cancelled: false }; timers.push(h); return () => { h.cancelled = true } },
  }
  return { timer, timers, fire() { for (const t of [...timers]) if (!t.cancelled) t.fn() } }
}

const logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
}

console.log('== 1. router 事件路由 ==')
{
  const c2c = routeEvent({ t: 'C2C_MESSAGE_CREATE', d: { id: 'm1', msg_id: 'q1', author: { user_openid: 'OPENID_1', nickname: '小明' }, content: 'hello' } })
  ok('C2C → user 会话', c2c?.message?.chatKey === 'qq:user:OPENID_1' && c2c.message.chat.kind === 'user')
  ok('C2C 带 replyTo.msg_id（=d.id）', c2c.message.replyTo?.messageId === 'm1')
  ok('C2C 内容', c2c.message.content[0].text === 'hello')

  const group = routeEvent({ t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'm2', msg_id: 'q2', group_openid: 'GROUP_1', author: { member_openid: 'M1' }, content: '<@!bot123> 大家好' } })
  ok('群@ → group 会话', group?.message?.chatKey === 'qq:group:GROUP_1')
  ok('群@ 去提及标记', group.message.content[0].text === '大家好')

  const ch = routeEvent({ t: 'AT_MESSAGE_CREATE', d: { id: 'm3', msg_id: 'q3', guild_id: 'G1', channel_id: 'C1', author: { id: 'A1' }, content: 'hi' } })
  ok('频道@ → channel 会话', ch?.message?.chatKey === 'qq:channel:G1:C1' && ch.message.chat.id === 'C1')

  const inter = routeEvent({ t: 'INTERACTION_CREATE', d: { id: 'i1', data: { id: 'qq_apv_1:allow-once' } } })
  ok('按钮回调 → interaction', inter?.interaction?.dataId === 'qq_apv_1:allow-once')
  const inter2 = routeEvent({ t: 'INTERACTION_CREATE', d: { id: 'i2', data: { button_data: { id: 'qq_apv_2:reject' } } } })
  ok('按钮回调（button_data 兜底）', inter2?.interaction?.dataId === 'qq_apv_2:reject')
  // 官方字段实锤：按钮 id 在 data.resolved.button_id；点击者在 user_openid / group_member_openid
  const inter3 = routeEvent({ t: 'INTERACTION_CREATE', d: { id: 'i3', type: 11, user_openid: 'CLICKER_O', data: { resolved: { button_id: 'qq_apv_3:allow-once' } } } })
  ok('按钮 id 从 data.resolved.button_id 取', inter3?.interaction?.dataId === 'qq_apv_3:allow-once')
  ok('点击者从 user_openid 取', inter3.interaction.clicker === 'CLICKER_O')
  ok('互动 id 透传（回应用）', inter3.interaction.interactionId === 'i3' && inter3.interaction.type === 11)
  const inter4 = routeEvent({ t: 'INTERACTION_CREATE', d: { id: 'i4', type: 11, group_member_openid: 'M1', data: { resolved: { button_id: 'x:reject' } } } })
  ok('群聊点击者从 group_member_openid 取', inter4.interaction.clicker === 'M1')
  ok('未知事件忽略', routeEvent({ t: 'GUILD_MEMBER_ADD', d: {} }) === null)
}

console.log('== 2. acl fail-closed ==')
{
  const closed = new Acl({ allowFrom: [], groupAllowFrom: [], logger })
  ok('空白名单 → 拒绝', closed.check({ kind: 'user', id: 'x' }, 'qq:user:x').ok === false)
  const open = new Acl({ allowFrom: ['*'], groupAllowFrom: ['*'], logger })
  ok("'*' → 放行", open.check({ kind: 'user', id: 'x' }, 'qq:user:x').ok === true)
  const exact = new Acl({ allowFrom: ['OPENID_1'], groupAllowFrom: [], logger })
  ok('精确匹配放行', exact.check({ kind: 'user', id: 'OPENID_1' }, 'qq:user:OPENID_1').ok === true)
  ok('精确不匹配拒绝', exact.check({ kind: 'user', id: 'OTHER' }, 'qq:user:OTHER').ok === false)
}

console.log('== 3. util 清洗/分段 ==')
{
  const cleaned = stripInternalTags('好的<think>内部推理</think>，马上办<system-reminder>system</system-reminder>')
  ok('剥离内部标签', !cleaned.includes('think') && cleaned.includes('马上办'))
  const chunks = chunkText('a'.repeat(500) + '\n' + 'b'.repeat(5000), 4000)
  ok('超长分段为多条且拼接等长', chunks.length === 2 && (chunks[0] + chunks[1]).replace(/\n/g, '').length === 5500)
  // 字节分段：中文 4000 字符 ≈ 12000 字节，必须按字节切（每段 ≤ 4000 字节）
  const cn = chunkText('中'.repeat(5000), 4000)
  ok('中文按字节分段（每段≤4000 字节且不丢字）', cn.length === 4 && cn.every((c) => Buffer.byteLength(c, 'utf8') <= 4000) && cn.join('') === '中'.repeat(5000))
  ok('textFromBlocks 提取 text', textFromBlocks([{ type: 'text', text: 'A' }, { type: 'tool-result', content: [] }]) === 'A')
}

console.log('== 4. qqapi URL / seq（无网络） ==')
{
  const api = new QQApi({ id: '1', secret: 's', sandbox: true, logger, timer: { timeout: () => () => {}, interval: () => () => {} } })
  ok('沙箱 C2C URL', api.messageUrl({ kind: 'user', id: 'o1' }) === 'https://sandbox.api.sgroup.qq.com/v2/users/o1/messages')
  ok('沙箱群 URL', api.messageUrl({ kind: 'group', id: 'g1' }) === 'https://sandbox.api.sgroup.qq.com/v2/groups/g1/messages')
  ok('沙箱频道 URL', api.messageUrl({ kind: 'channel', id: 'c1' }) === 'https://sandbox.api.sgroup.qq.com/channels/c1/messages')
  const s1 = api.nextSeq(); const s2 = api.nextSeq()
  ok('msg_seq 自增', s1 === 1 && s2 === 2)
  const api2 = new QQApi({ id: '1', secret: 's', sandbox: false, logger, timer: { timeout: () => () => {}, interval: () => () => {} } })
  ok('正式端点', api2.endpoint === 'https://api.sgroup.qq.com')
}

console.log('== 5. session-map 生命周期（mock dsh） ==')
{
  const tmp = mkdtempSync(join(tmpdir(), 'qq-smoke-'))
  const created = []
  const resumed = []
  const followups = []
  const liveAgents = new Map()
  const { timer } = makeTimer()
  const ctx = {
    timer,
    agents: {
      get: (id) => liveAgents.get(id),
      create: async (opts) => {
        created.push(opts)
        const agent = { session: { id: opts.sessionId }, followup: (m) => followups.push({ id: opts.sessionId, m }) }
        liveAgents.set(opts.sessionId, agent)
        return { agent, dispose: async () => { liveAgents.delete(opts.sessionId) } }
      },
      resume: async (opts) => {
        resumed.push(opts)
        const agent = { session: { id: opts.resumeSessionId }, followup: (m) => followups.push({ id: opts.resumeSessionId, m }) }
        liveAgents.set(opts.resumeSessionId, agent)
        return { agent, dispose: async () => { liveAgents.delete(opts.resumeSessionId) } }
      },
    },
    workspaceRegistry: { create: async (path) => ({ id: path }) },
    agentPresets: { mount: async () => ({}) },
  }
  const cfg = { cwd: tmp, workspaceIsolation: true, provider: 'p', model: 'm', agentPreset: 'standard' }
  const sm = new SessionMap({ ctx, config: cfg, logger })
  sm.init(tmp)

  const msg = (chatKey, chat, text) => ({
    chatKey, chat: { ...chat, chatKey }, content: [{ type: 'text', text }], replyTo: { messageId: 'q1' },
  })

  await sm.deliver(msg('qq:user:O1', { kind: 'user', id: 'O1', name: 'x' }, '你好'))
  ok('首条消息 create agent', created.length === 1 && created[0].sessionId === 'qq:user:O1')
  ok('create 带 meta.cwd/agentPreset', created[0].meta.cwd.endsWith('qq_user_O1') && created[0].meta.agentPreset === 'standard')
  ok('followup 收到消息且 source=plugin', followups[0].m.source?.kind === 'plugin' && followups[0].m.source?.plugin === 'dsh-im-qq')
  ok('followup content 是 ContentBlock[]', Array.isArray(followups[0].m.content) && followups[0].m.content[0].type === 'text')

  // 第二条消息复用 live agent
  await sm.deliver(msg('qq:user:O1', { kind: 'user', id: 'O1' }, '再问'))
  ok('live agent 复用（不重复 create）', created.length === 1 && followups.length === 2)

  // /new 后生成新 generation
  await sm.reset({ chatKey: 'qq:user:O1' })
  ok('/new 后 entry.sessionId 置空', sm.entries.get('qq:user:O1').sessionId === null)
  await sm.deliver(msg('qq:user:O1', { kind: 'user', id: 'O1' }, '新会话'))
  ok('/new 后 create 新 sessionId(#1)', created.length === 2 && created[1].sessionId === 'qq:user:O1#1')

  // 持久化 + 恢复
  const sm2 = new SessionMap({ ctx, config: cfg, logger })
  sm2.init(tmp)
  ok('重启恢复映射（含 generation）', sm2.entries.get('qq:user:O1')?.sessionId === 'qq:user:O1#1')
  // 恢复后 agent 懒恢复
  liveAgents.clear()
  await sm2.deliver(msg('qq:user:O1', { kind: 'user', id: 'O1' }, '恢复后发言'))
  ok('懒恢复走 resume', resumed.length === 1 && resumed[0].resumeSessionId === 'qq:user:O1#1')
  // 🔴1 验收：resume 后 handle 必须写回映射（否则 /new 泄漏、/always 失效、/me 待唤醒）
  ok('resume 后 handle 已写回映射', sm2.entries.get('qq:user:O1')?.handle != null)
  ok('resume 后 agentForChat 可拿到 agent', !!sm2.agentForChat({ chatKey: 'qq:user:O1' }))
  // /new 必须 dispose 旧 agent
  await sm2.reset({ chatKey: 'qq:user:O1' })
  ok('/new 后旧 agent 被 dispose（liveAgents 清空）', liveAgents.size === 0)
  rmSync(tmp, { recursive: true, force: true })
}

console.log('== 6. outbound 合并/分段/兜底（mock） ==')
{
  const { timer, timers, fire } = makeTimer()
  const sent = []
  const mockSm = {
    chatForSession: (id) => ({ kind: 'user', id: 'O1', chatKey: 'qq:user:O1' }),
  }
  const cfg = { deliverWindowMs: 900, deliverMaxWaitMs: 6000, textChunkLimit: 4000, replyPassiveLimit: 4 }
  const out = new Outbound({
    ctx: { timer, on: () => () => {} },
    config: cfg, logger,
    sessionMap: mockSm,
    send: async (chat, blocks, opts) => { sent.push({ chat, blocks, opts }) },
  })
  out.install()
  const listeners = []
  const ctx2 = { timer, on: (name, fn) => { listeners.push(fn); return () => {} } }
  // 重新构造以捕获监听器
  const out2 = new Outbound({ ctx: ctx2, config: cfg, logger, sessionMap: mockSm, send: async (c, b, o) => sent.push({ c, b, o }) })
  out2.install()

  const sess = { id: 'qq:user:O1' }
  // ⚠️ session/event 真实形状：负载在 data 里（{type, seq, time, data}）
  out2.onSessionEvent(sess, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '第一段' }] } } })
  out2.onSessionEvent(sess, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '第二段' }] } } })
  ok('合并窗口内未立即发送', sent.length === 0)
  fire()
  ok('窗口到期合并为一条', sent.length === 1 && sent[0].b[0].text === '第一段\n\n第二段')

  // 被动预算：beginTurn 后首次发送带 msg_id
  sent.length = 0
  out2.beginTurn('qq:user:O1', 'MSG_9')
  out2.onSessionEvent(sess, { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: '回复' }] } } })
  fire()
  ok('被动回复带 msg_id', sent.length === 1 && sent[0].o.passive === true && sent[0].o.msgId === 'MSG_9')

  // 错误兜底：turn/end error 且无内容
  sent.length = 0
  out2.onSessionEvent(sess, { type: 'turn/start', data: { turn: 3 } })
  out2.onSessionEvent(sess, { type: 'turn/end', data: { turn: 3, reason: { kind: 'error', error: { message: 'boom' } } } })
  ok('turn error → 兜底文本', sent.length === 1 && sent[0].b[0].text.includes('服务暂时不可用'))
}

console.log('== 7. approval 桥（mock） ==')
{
  const { timer, timers, fire } = makeTimer()
  const keyboardSent = []
  const policyCalls = []
  const pendingChat = { kind: 'user', id: 'O1', chatKey: 'qq:user:O1' }
  const mockSm = {
    chatForSession: (id) => id === 'qq:user:O1' ? pendingChat : null,
    agentForChat: (chat) => ({ session: { id: 'qq:user:O1' } }),
    chatForChatKey: (k) => pendingChat,
    authorFor: () => 'O1', // 审批点击者身份校验用
  }
  const cfg = { approvalTimeoutMs: 1000 }
  const bridge = new ApprovalBridge({
    ctx: { timer, approval: { setPolicy: (agent, policy) => policyCalls.push(policy) }, on: () => () => {} },
    config: cfg, logger, sessionMap: mockSm,
    sendKeyboard: async (chat, text, actions) => { keyboardSent.push({ chat, text, actions }) },
  })
  const requests = []
  bridge.install()
  // 手动捕获 waterfall 监听
  const nextFn = async () => 'unavailable'
  // 模拟 dsh 调 answerer；等一 tick 让 pending 注册完成
  const promise = bridge.handle({ agent: { session: { id: 'qq:user:O1' } }, toolName: 'bash', reason: 'rm -rf' }, nextFn)
  await new Promise((r) => setTimeout(r, 0))
  ok('审批按钮已发', keyboardSent.length === 1 && keyboardSent[0].actions.length === 3)
  ok('按钮带 3 个动作', keyboardSent[0].actions.map((a) => a.action).join(',') === 'allow-once,always,reject')

  // ⭐ 始终允许：回调后 setPolicy(never) + 返回 allowed-once
  const dataId = keyboardSent[0].actions[1].id
  const consumed = bridge.onInteraction(dataId)
  const outcome = await promise
  ok('⭐ 回调被消费', consumed === true)
  ok('⭐ 结果 allowed-once', outcome === 'allowed-once')
  ok('⭐ 触发 setPolicy(never)', policyCalls.includes('never'))

  // /revoke：setPolicy(ask)
  policyCalls.length = 0
  const ok2 = bridge.revoke(pendingChat)
  ok('/revoke 撤销 → setPolicy(ask)', ok2 === true && policyCalls.includes('ask'))

  // 超时 → unavailable（fail-closed）
  const promise2 = bridge.handle({ agent: { session: { id: 'qq:user:O1' } }, toolName: 'fs' }, nextFn)
  await new Promise((r) => setTimeout(r, 0))
  fire()
  const outcome2 = await promise2
  ok('超时 → unavailable（fail-closed）', outcome2 === 'unavailable')

  // 非 qq: 会话不拦截
  const promise3 = bridge.handle({ agent: { session: { id: 'web-session-1' } }, toolName: 'bash' }, nextFn)
  ok('非 qq: 会话放行到下游', (await promise3) === 'unavailable') // next() 的结果

  // 🔴3 验收：点击者身份校验——发起者(authorFor='O1')能点，他人点击被忽略
  const promise4 = bridge.handle({ agent: { session: { id: 'qq:user:O1' } }, toolName: 'bash' }, nextFn)
  await new Promise((r) => setTimeout(r, 0))
  const btnId = keyboardSent[keyboardSent.length - 1].actions[0].id
  const hackConsumed = bridge.onInteraction(btnId, 'HACKER_OPENID')
  ok('他人点击被忽略（身份不符，吞掉不打扰）', hackConsumed === true)
  // pending 未被 settle：发起者本人再点才生效
  const ownerConsumed = bridge.onInteraction(btnId, 'O1')
  const outcome4 = await promise4
  ok('发起者点击生效（身份匹配）', ownerConsumed === true && outcome4 === 'allowed-once')
  // 无点击者信息（clicker 空）时向后兼容放行
  const promise5 = bridge.handle({ agent: { session: { id: 'qq:user:O1' } }, toolName: 'bash' }, nextFn)
  await new Promise((r) => setTimeout(r, 0))
  const btnId5 = keyboardSent[keyboardSent.length - 1].actions[0].id
  const noClicker = bridge.onInteraction(btnId5)
  ok('无点击者信息时放行（向后兼容）', noClicker === true && (await promise5) === 'allowed-once')
}

console.log('== 8. slash 命令 ==')
{
  const slash = new Slash({
    ctx: {}, config: {}, logger,
    sessionMap: { info: () => ({ sessionId: 'qq:user:O1', createdAt: Date.now(), live: true }), reset: async () => {} },
    approvalBridge: { approveOnce: () => true, setAlways: () => true, revoke: () => true },
  })
  ok('/ping', (await slash.handle({ chatKey: 'x' }, '/ping'))?.reply === 'pong 🏓')
  ok('/help 有内容', (await slash.handle({ chatKey: 'x' }, '/help'))?.reply.includes('/revoke'))
  ok('/approve 走审批桥', (await slash.handle({ chatKey: 'x' }, '/approve'))?.reply.includes('已允许'))
  ok('/revoke 走审批桥', (await slash.handle({ chatKey: 'x' }, '/revoke'))?.reply.includes('撤销'))
  ok('非命令返回 null', (await slash.handle({ chatKey: 'x' }, '普通消息')) === null)
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed ? 1 : 0)
