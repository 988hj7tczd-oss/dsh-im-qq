/**
 * dsh-im-qq —— QQ 官方机器人接入插件（设计文档 qq-bot-plugin-design.md v0.3）。
 *
 * 让用户通过 QQ（私聊 / 群聊 / 频道 @）直接与 harness 完整 agent 对话：
 * 工具调用、记忆、子代理、文件系统与安全护栏全部与 Web UI 同源。
 *
 * 架构（换平台 = 换 platform/ 目录，core/ 复用）：
 *   platform/transport/websocket.js   WS 网关（token/心跳/重连/RESUME，当前默认）
 *   platform/router.js                事件 → 标准消息对象（含审批按钮回调分流）
 *   platform/qqapi.js                 QQ OpenAPI（token/gateway/发消息/msg_seq/频控退避）
 *   core/session-map.js               聊天对象 ↔ dsh session 映射与生命周期
 *   core/outbound.js                  回复合并/分段/去标签/被动限额/错误兜底
 *   core/approval.js                  审批 answerer 桥（QQ 内联按钮）
 *   core/acl.js                       白名单 fail-closed + 频控
 *   core/slash.js                     /help /ping /me /new /approve /always /revoke
 *   client.js                         客户端半边：设置 → 插件 → QQ 机器人 配置卡片
 *
 * 安装形态（与 dsh-computer-use 同模式）：cordis.patch.yml insert + symlink 到
 * profiles/web/node_modules；install.sh / uninstall.sh 一键管理。
 *
 * 凭据三通道（按优先级）：
 *   1. row 配置 id / secret（cordis.patch.yml 明文，兜底）
 *   2. 环境变量 secretEnv（桌面 GUI 需 launchctl setenv）
 *   3. dsh 凭据域（推荐）：QQ_BOT_APP_ID / QQ_BOT_APP_SECRET，
 *      由「设置 → 插件 → QQ 机器人」卡片写入 $DSH_HOME/.credentials.yaml。
 * 凭据域保存会触发 credentials/updated 事件 → 机器人自动启停，无需重启应用。
 */

import z from '@deepseek-ai/schemastery'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { makeLogger } from './lib/util.js'
import { QQApi } from './platform/qqapi.js'
import { QQWebSocketTransport } from './platform/transport/websocket.js'
import { routeEvent } from './platform/router.js'
import { Acl } from './core/acl.js'
import { SessionMap } from './core/session-map.js'
import { Outbound } from './core/outbound.js'
import { ApprovalBridge } from './core/approval.js'
import { Slash } from './core/slash.js'

export const name = 'dsh-im-qq'

/** 硬依赖（对应服务缺失时插件进入等待，服务出现后自动激活）。 */
export const inject = [
  'agents',
  'agentPresets',
  'workspaceRegistry',
  'sessionPersistence',
  'approval',
  'timer',
  'sessions',
]

/** 凭据域 ref（配置卡片写入、本插件读取；值存 $DSH_HOME/.credentials.yaml）。 */
export const CRED_APPID = 'QQ_BOT_APP_ID'
export const CRED_SECRET = 'QQ_BOT_APP_SECRET'

/** 插件配置（设计文档 §8）。 */
export const Config = z.object({
  id: z.string().default(''), // AppID（YAML 里必须加引号）；空则读凭据域
  secret: z.string().default(''), // AppSecret 明文（与 secretEnv 互斥）
  secretEnv: z.string().default(''), // AppSecret 环境变量名（与 secret 互斥）
  sandbox: z.boolean().default(true), // 先沙箱验证，稳定后 false
  transport: z.string().default('websocket'), // websocket | webhook（P5 预留）
  provider: z.string().default('deepseek-official'),
  model: z.string().default('deepseek-v4-flash'),
  agentPreset: z.string().default('standard'),
  cwd: z.string().default('~/qq-workspace'),
  workspaceIsolation: z.boolean().default(true),
  allowFrom: z.array(z.string()).default(['*']), // 空=全拒（fail-closed）
  groupAllowFrom: z.array(z.string()).default(['*']),
  markdown: z.boolean().default(false), // msg_type 2，需平台开通权限
  typing: z.boolean().default(true), // P4 实测确认接口后实现
  streaming: z.boolean().default(false), // P4 实测确认接口后实现
  streamThrottleMs: z.number().default(1200),
  deliverWindowMs: z.number().default(900),
  deliverMaxWaitMs: z.number().default(6000),
  textChunkLimit: z.number().default(4000),
  replyPassiveLimit: z.number().default(4),
  approval: z.boolean().default(true),
  approvalTimeoutMs: z.number().default(300000),
  slashCommands: z.boolean().default(true),
  debug: z.boolean().default(false),
})

export function apply(ctx, config) {
  // schema 校验 + 默认值合并（防御：不依赖加载器是否已合并默认值）。
  // ⚠️ fail-soft：配置非法时只停用本插件，绝不 throw——插件的 apply 异常会让
  //   整个 dsh 引擎启动失败（fail-loud → exit 1），桌面端就会"打不开"。
  let raw
  try {
    raw = Config(config)
  } catch (err) {
    console.error('[dsh-im-qq] 配置校验失败，插件已停用:', err?.message)
    return
  }
  const log = makeLogger(!!raw.debug)
  log.info('加载中…（sandbox =', raw.sandbox ? '沙箱' : '正式', 'transport =', raw.transport, '）')

  // —— 凭据互斥校验（fail-soft，见上）——
  if (raw.secret && raw.secretEnv) {
    log.error('secret 与 secretEnv 互斥，只能配置一个；插件已停用')
    return
  }

  // —— 工作区：展开 ~ 并确保存在（设计文档 §8：cwd 必须真实存在）——
  const cwd = resolve(raw.cwd.replace(/^~(?=\/|$)/, homedir()))
  mkdirSync(cwd, { recursive: true })

  const cfg = {
    ...raw,
    cwd,
  }
  // ⚠️ 不在此处捕获 credentials 服务：loader 并发挂载插件，凭据服务可能晚于本插件
  //    激活；ctx.get('credentials') 必须在每次使用时现取。

  // —— 入站管线：事件 → 标准消息 → acl → slash → agent ——
  const onEvent = async (dispatch) => {
    try {
      const routed = routeEvent(dispatch)
      if (!routed) return

      // 审批按钮回调：与消息路由分开处理（设计文档 §5 路由表）；透传点击者 openid 供身份校验
      if (routed.interaction) {
        const { interaction } = routed
        // 官方要求：按钮(11)/快捷菜单(12) 互动必须 PUT /interactions/{id} 回应，否则客户端一直 loading
        if (interaction.type === 11 || interaction.type === 12) {
          qqapi?.ackInteraction(interaction.interactionId)
        }
        if (approvalBridge?.onInteraction(interaction.dataId, interaction.clicker)) return
        log.debug('未消费的交互回调 dataId =', interaction.dataId)
        return
      }

      const { message } = routed
      log.info(`入站 ${message.chat.kind}(${message.chat.id}): ${message.content?.[0]?.text?.slice(0, 60) || ''}`)

      // 白名单 fail-closed
      const gate = acl.check(message.chat, message.chatKey)
      if (!gate.ok) {
        log.warn(`拒绝 ${message.chatKey}: ${gate.reason}`)
        return
      }

      // 斜杠命令（chat 需携带 chatKey 供 slash/session-map 匹配）
      if (slash) {
        const chat = { ...message.chat, chatKey: message.chatKey }
        const text = message.content?.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') || ''
        const result = await slash.handle(chat, text)
        if (result) {
          await qqapi.sendMessage(chat, {
            blocks: [{ type: 'text', text: result.reply }],
            passive: true,
            msgId: message.replyTo?.messageId,
          })
          return
        }
      }

      // 投递 agent（create/resume/followup 在 session-map 内完成）
      await sessionMap.deliver(message)
    } catch (err) {
      log.error('入站管线异常:', err?.message, err?.stack?.slice(0, 300) || '')
    }
  }

  // —— core 层（始终建立；凭据就绪后机器人才启动）——
  const acl = new Acl({ allowFrom: cfg.allowFrom, groupAllowFrom: cfg.groupAllowFrom, logger: log })
  const sessionMap = new SessionMap({ ctx, config: cfg, logger: log })
  sessionMap.init(cwd)

  const outbound = new Outbound({
    ctx,
    config: cfg,
    logger: log,
    sessionMap,
    send: async (chat, blocks, opts) => {
      await qqapi.sendMessage(chat, { blocks, passive: opts.passive, msgId: opts.msgId })
    },
  })
  outbound.install()
  sessionMap.setOutbound(outbound)

  const approvalBridge = cfg.approval
    ? new ApprovalBridge({
        ctx,
        config: cfg,
        logger: log,
        sessionMap,
        sendKeyboard: async (chat, text, actions) => {
          await qqapi.sendMessage(chat, {
            blocks: [{ type: 'text', text }],
            keyboard: buildKeyboard(actions),
          })
        },
      })
    : null
  approvalBridge?.install()

  const slash = cfg.slashCommands
    ? new Slash({ ctx, config: cfg, logger: log, sessionMap, approvalBridge })
    : null

  // —— 机器人生命周期：凭据就绪才启动，凭据变化自动启停 ——
  let bot = null // { qqapi, transport, appId, credKey }
  let qqapi = null // 入站/出站管线共享的发送通道（bot 启动后赋值）
  let botStarting = null // 并发守卫：两路 ensureBot 同时触发时只启动一次

  const stopBot = () => {
    if (!bot) return
    try {
      bot.transport?.stop()
    } catch { /* ignore */ }
    try {
      bot.qqapi?.stop()
    } catch { /* ignore */ }
    bot = null
    qqapi = null
  }

  /** 凭据解析：row 配置 → 环境变量 → 凭据域（推荐通道）。 */
  const resolveCreds = async () => {
    const cred = ctx.get('credentials') // 每次现取（服务可能后于本插件激活）
    let id = cfg.id || ''
    let secret = raw.secret || ''
    if (!secret && raw.secretEnv) secret = process.env[raw.secretEnv] || ''
    if (cred) {
      try {
        if (!id) id = (await cred.resolve(CRED_APPID))?.value || ''
        if (!secret) secret = (await cred.resolve(CRED_SECRET))?.value || ''
      } catch (err) {
        log.error('读取凭据失败:', err?.message)
      }
    }
    return { id: String(id).trim(), secret: String(secret).trim() }
  }

  const ensureBot = async (reason) => {
    // 并发守卫：启动 + 凭据更新同时触发时只执行一次（防双 WS 连接）
    if (botStarting) return botStarting
    const run = (async () => {
      const { id, secret } = await resolveCreds()
      if (!id || !secret) {
        if (bot) stopBot()
        log.warn(
          `凭据未就绪（${reason}），机器人未启动——请在「设置 → 插件 → QQ 机器人」填写 AppID / AppSecret，保存后自动生效`,
        )
        return
      }
      const credKey = `${id}|${secret}`
      if (bot) {
        // 凭据已变化（id 或 secret 任一不同）→ 重启机器人；未变化则忽略（防抖）
        if (bot.credKey !== credKey) {
          log.info(`凭据已更新（${reason}），重启机器人: AppID=${bot.appId} → ${id}`)
          stopBot()
        } else {
          return
        }
      }
      const api = new QQApi({ id, secret, sandbox: cfg.sandbox, logger: log, timer: ctx.timer })
      const transport = new QQWebSocketTransport({ qqapi: api, logger: log, timer: ctx.timer, onEvent })
      bot = { qqapi: api, transport, appId: id, credKey }
      qqapi = api
      if (cfg.transport === 'websocket') {
        transport.start().catch((err) => log.error('transport 启动失败:', err?.message))
        log.info(`机器人已启动（${reason}）：AppID=${id} transport=websocket`)
      } else {
        log.warn(`transport=${cfg.transport} 尚未实现（P5 预留），当前仅支持 websocket；机器人未连接，请改为 'websocket'`)
      }
    })()
    botStarting = run
    try {
      return await run
    } finally {
      if (botStarting === run) botStarting = null
    }
  }

  ensureBot('启动').catch((err) => log.error('机器人启动失败:', err?.message))

  // 凭据变化（「设置 → 插件 → QQ 机器人」保存后触发）→ 自动启停机器人，无需重启应用
  ctx.on('credentials/updated', (ref) => {
    if (ref !== CRED_APPID && ref !== CRED_SECRET) return
    ensureBot('凭据已更新').catch((err) => log.error('凭据更新后启动机器人失败:', err?.message))
  })

  // —— 卸载清理（WS 连接 + token 刷新定时器随插件生命周期回收）——
  ctx.effect(() => () => {
    stopBot()
  })
}

/**
 * QQ 消息内嵌键盘（审批按钮）。
 * 按钮回调 INTERACTION_CREATE 的 data.id = 按钮 id（'qq_apv_<n>:<action>'）。
 */
function buildKeyboard(actions) {
  return {
    content: {
      rows: [
        {
          buttons: actions.map((a) => ({
            id: a.id,
            render_data: { label: a.label, style: 1 },
            action: {
              type: 2, // 2 = 回调互动
              data: a.action, // 回调原样返回（与 id 双保险）
              permission: { type: 2 }, // 所有人可点
            },
          })),
        },
      ],
    },
  }
}
