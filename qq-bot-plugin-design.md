# dsh-im-qq —— QQ Bot 接入插件设计文档

> 状态：**v0.3（API 签名已按 rc.6 源码实锤修正，待复审）**
> 日期：2026-08-16
> 审核人：用户
> 系列命名：`dsh-im-*`（IM 平台接入插件族，一个平台一个插件）
> 修订记录：v0.1 草案 → v0.2 审核意见（6 硬伤 + 8 完善）→ v0.3 API 签名实锤修正（4 处），见 §13

---

## 1. 项目概述

### 1.1 是什么

`dsh-im-qq` 是 DeepSeek Harness 的一个 **Cordis 插件包**，为 harness 接入 **QQ 官方机器人**（QQ 开放平台 / q.qq.com）的消息收发能力，让用户通过 QQ（私聊 / 群聊 / 频道 @机器人）直接与 harness 的完整 agent 对话——包括工具调用、记忆、子代理、文件系统与安全护栏，与 Web UI 完全同源。

### 1.2 核心理念

> **harness 是载体，一个消息平台 = 一个插件，可灵活插拔更换。**

QQ、微信、飞书、钉钉各自是独立插件（`dsh-im-qq` / `dsh-im-wechat` / `dsh-im-feishu` / `dsh-im-dingtalk`），共享同一套插件骨架（im-core），仅"平台适配层"不同。对 harness 不满意某平台，直接拔掉对应插件换上另一个，harness 本体零改动。

### 1.3 安装形态（与 dsh-computer-use 同模式）

- `cordis.patch.yml`：通过 insert 注入 profile
- 插件目录 symlink 到 `$DSH_HOME/profiles/web/node_modules/<插件名>`
- `install.sh` / `uninstall.sh` 一键安装/卸载
- 配置写在 `cordis.patch.yml` 的 `config` 段（AppID/AppSecret/白名单/模型/工作区等）

---

## 2. 腾讯官方 SDK 调研结论（2026-08 核实）

| SDK | 语言 | 结论 |
|---|---|---|
| [bot-node-sdk](https://github.com/tencent-connect/bot-node-sdk)（qq-guild-bot） | Node | ⚠️ 参考价值有限：偏"频道"方向、框架化封装重，官方已将能力迁往 qq-guild-bot-es。**不采用**，仅作协议细节参考 |
| [botpy](https://github.com/tencent-connect/botpy) | Python | ❌ 语言栈不符（插件是 Node ESM）。**不采用** |
| [botgo](https://github.com/tencent-connect/botgo) | Go | ❌ 代码无直接帮助，但其 README 揭示了**关键官方动向**（见 §3）。**不采用** |

**结论**：三个官方 SDK 都不直接依赖。代码实现以社区验证过的纯 WS 实现（dsh-qqbot-community / dsh-plugin-adapter-qq，均 MIT）为蓝本自研，保证完整理解协议细节，且不受第三方框架约束。

---

## 3. 平台现状核实（影响架构的关键决策）

### 3.1 官方动向

**botgo 官方 README 声明**：

> "WebSocket 事件推送链路将在 24 年年底前逐步下线，官方不再维护；新的 **Webhook 事件回调链路**在灰度验证……QQ 机器人需要配置 **IP 白名单**，仅白名单内服务器/容器可访问 OpenAPI"

### 3.2 最新现状（2026-08 Koishi 社区核实）

> "2026.8 目前腾讯开放平台**已经支持切换 websocket、webhook，不再强制 webhook**。"

### 3.3 对架构的推论

| 模式 | 状态 | 要求 |
|---|---|---|
| **WebSocket** | ✅ 当前可用，社区插件（含 dsh-qqbot-community）仍在正常使用 | 无需公网地址，适合桌面端 |
| **Webhook** | ⚠️ 官方长期方向，未来可能强制 | 需要**公网可达的 HTTPS 回调地址 + IP 白名单**，桌面端需中转（云函数/服务器/内网穿透） |

**架构决策：transport 必须抽象成双模式（WebSocket / Webhook），可配置切换。** 当前用 WS 立即可用；未来官方强制 Webhook 时只换 transport 层，会话映射、出站管线、审批、白名单等核心逻辑零改动。

### 3.4 ⚠️ 前置条件（P0 必须核对，缺一不可）

| # | 前置条件 | 说明 | 不满足的后果 |
|---|---|---|---|
| 1 | **机器人类型选「公域」** | q.qq.com 创建 bot 时必须选**公域机器人** | 私域机器人无法用 `/v2/groups/` 发群消息，**永久报错 11255**，代码无法绕过 |
| 2 | **测试人员加入沙箱** | q.qq.com → 开发设置 → **测试人员管理**，添加自己的 QQ 号 | 沙箱外人员发消息 11255，且是**永久性错误**（不是重试能过的），排查浪费一整天 |
| 3 | **沙箱 / 正式环境区分** | 配置 `sandbox: true` 先验证，稳定后改 false | 环境混用导致 token/endpoint 不匹配 |
| 4 | **openid 获取方式** | openid / group_openid 是平台按 bot 维度哈希，**无法提前预知**，只能从真实收到的入站消息里抄 | 白名单 openid 填错 = 全部拒绝 |

---

## 4. 插件目录结构

```
dsh-im-qq/
├── package.json              # name: dsh-im-qq; dsh.bundle.patch 声明; type: module
├── cordis.patch.yml          # insert: - id: dsh-im-qq, name: dsh-im-qq, config: {...}
├── index.js                  # 插件入口：inject ['agents','agentPresets','workspaceRegistry','sessionPersistence']
├── core/                     # ← 平台无关骨架（未来其它 dsh-im-* 插件复制复用）
│   ├── session-map.js        #   聊天对象 ↔ dsh sessionId 映射与生命周期（含 onStart 幂等恢复）
│   ├── outbound.js           #   回复合并/分段/去内部标签/频控/主动降级/错误兜底
│   ├── approval.js           #   审批策略桥（映射 dsh approval 服务，含撤销命令）
│   ├── acl.js                #   白名单（C2C/群）、频率限制（fail-closed）
│   └── slash.js              #   /help /ping /new /approve /revoke 等斜杠命令
├── platform/                 # ← QQ 平台专属
│   ├── transport/
│   │   ├── websocket.js      #   WS 网关：token 刷新、连接、心跳、重连、RESUME（当前默认）
│   │   └── webhook.js        #   Webhook 回调服务（未来官方强制时启用）
│   ├── router.js             #   事件路由：频道@/群@/单聊/按钮回调 → 标准消息对象
│   └── qqapi.js              #   QQ OpenAPI 封装：token / gateway / 发消息（含 msg_seq、错误重试）
├── install.sh                # symlink + patch 注入 + 依赖安装
├── uninstall.sh              # 反向卸载
├── README.md                 # 用户文档（含 troubleshooting：fake-ip DNS 等）
├── VERIFICATION.md           # 验收记录（延续 dsh-computer-use 质量标准）
└── qq-bot-plugin-design.md   # 本文档
```

**换平台 = 换 platform 目录，core 复用**（例如飞书插件 = dsh-im-feishu，platform/ 换成飞书开放平台 SDK 适配，core/ 原样复用）。

---

## 5. 核心数据流

```
QQ 开放平台（transport/websocket.js 长连接）
  │  收到事件：AT_MESSAGE_CREATE(频道@) / GROUP_AT_MESSAGE_CREATE(群@)
  │           / C2C_MESSAGE_CREATE(单聊) / INTERACTION_CREATE(按钮回调)
  ▼
router.js → 标准消息对象 { id, chat:{kind,id,name}, content:[{type:'text',text}], replyTo }
  │  事件路由表：
  │    AT_MESSAGE_CREATE       → channel 会话
  │    GROUP_AT_MESSAGE_CREATE → group 会话
  │    C2C_MESSAGE_CREATE      → user 会话
  │    INTERACTION_CREATE      → 审批按钮回调（✅/⭐/❌ 决策），与消息路由分开处理
  ▼
session-map：按 chat 标识查/建 dsh session
  ├─ qq:channel:<guildId>:<channelId>   频道会话
  ├─ qq:group:<group_openid>            群会话   ⚠️ 见 §5.1 key 设计
  └─ qq:c2c:<openid>                    单聊会话（每人独立）
  ▼
agent-pool：
  ├─ 首条消息 → workspace 显式注册（§7）→ ctx.agents.create({ sessionId, agentOptions, meta:{cwd, agentPreset} })
  │            + setup 回调里 agentPresets.mount(agentCtx, 'standard')   ← 获得与 Web UI 相同的工具集（§7 签名实锤）
  └─ 已有     → ctx.agents.resume({ resumeSessionId })
  ▼
agent.followup(createUserMessage({ content, source })) → 引擎跑完整 agent 管线（§7 签名实锤）
  ▼
outbound.js：监听 ctx.on('session/event')（session.id 前缀 'qq:'）
  → 合并同轮多条回复 / 超长分段（默认 4000 字）/ 剥离 <think>、<system-reminder> 等内部标签
  → 错误兜底：agent 报错时回"服务暂时不可用，请稍后重试"+ 错误日志（不能静默无响应）
  ▼
qqapi.js 发回 QQ（三处 POST 均必带 msg_seq，§7）：
  ├─ 单聊  POST /v2/users/{openid}/messages（带 msg_id 被动回复，限 4 次/消息）
  ├─ 群    POST /v2/groups/{group_openid}/messages
  └─ 频道  POST /channels/{channelid}/messages
```

### 5.1 ⚠️ 会话 key 设计（实现时以真实事件字段定案）

- **openid 是 bot 维度隔离的**：同一 QQ 用户对 A bot 和 B bot 的 openid 完全不同。影响：
  1. 白名单 openid **无法提前填**，只能从真实收到的消息里抄（§3.4 前置 #4）
  2. 群聊事件里是 `group_openid`（平台哈希），**不是群号**，不能假设它就是群标识
- 群会话 key 用 `group_openid` 还是"群内首个触达者"等派生标识，**取决于真实事件 payload 里有哪些稳定字段**——设计阶段标注为**待实测确认**，P1 联调时用真实事件流抓取后定案，不留想当然的假设。

---

## 6. 标准消息对象契约（core ↔ platform 的唯一接口）

```js
// 平台消息 → core（inbound）
{
  id: '平台消息id',
  chat: { kind: 'user' | 'group' | 'channel', id: 'openid/group_openid/channelid', name: '昵称' },
  content: [{ type: 'text' | 'image' | 'file', ... }],  // 平台 → dsh 统一格式
  replyTo: { chatId: 'xxx', messageId: 'xxx' },         // 回复引用
  interaction?: { type: 'approval', action: 'allow-once'|'always'|'reject', payload } // 按钮回调
}

// core → 平台（outbound）
{
  chat: { kind, id },
  blocks: [{ type: 'text' | 'image' | 'file', ... }],   // 已合并/分段/去标签的回复
  passive: boolean,                                      // 是否带 msg_id 被动回复
  error?: string                                         // 错误兜底文本
}
```

---

## 7. 关键技术点（已核实 + 踩坑修正）

| 环节 | 实现 |
|---|---|
| 获取 token | `POST https://bots.qq.com/app/getAppAccessToken`，body `{appId, clientSecret}` → `access_token` + `expires_in`；**提前 60s 定时刷新** |
| 网关地址 | `GET {endpoint}/gateway`；沙箱 `https://sandbox.api.sgroup.qq.com`，正式 `https://api.sgroup.qq.com` |
| WS 握手 | op10(hello) 收 `heartbeat_interval` → op2 identify `{token:'QQBot xxx', intents, shard:[0,1]}` → 心跳 op1 携带 `last_sequence` |
| 断线重连 | **op7**（可 RESUME：带 session_id+seq 恢复）；**op9**（session 失效：**必须全新 identify，不能带 session_id**）；指数退避重连 |
| 30min 断连周期 | QQ 服务器约每 30min 主动关 WS（code **4009 "Session timed out"**），这是**正常行为**不是 bug——文档/日志标注，避免误判 |
| intents | `PUBLIC_GUILD_MESSAGES(1<<30) + USER_MESSAGE(1<<25) + INTERACTION_CREATE(1<<26)`，覆盖频道/群/单聊/按钮回调 |
| 发消息 msg_seq | **三处 POST 均必带 `msg_seq`**（防重放，缺失直接 500）；用**自增计数或时间戳生成**，**不用固定值 1** |
| 频控错误码 | **50015014「系统繁忙」**= 平台频控：指数退避重试（5s → 10s → 上限），写进 qqapi.js 统一错误处理 |
| 消息清洗 | 群聊文本去 `<@!openid>` 提及标记后再投给 agent；机器人自身提及剔除 |
| 会话隔离 | 每个 openid / group 独立 session，前缀 `qq:` 与 Web UI 会话天然隔离，互不串话 |
| agent preset | ⚠️ 签名实锤：`agentPresets.mount(agentCtx: Context, id?: string)`（`dsh-agent-presets/lib/types/index.d.ts` L159）。**必须在 agent 工厂的 `setup(agentCtx)` 回调里调用**，第一个参数是 agent 的 scoped context，不是 preset id。推荐：`ctx.agents.create({ ..., meta: { cwd, agentPreset: 'standard' }, setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'standard') } })`（meta.agentPreset 会写入 session header，但 factory 是否自动消费未实证，稳妥起见 setup 里显式 mount）；恢复会话沿用 header 记录的 preset |
| ⚠️ followup 签名 | 实锤：`agent.followup(message: UserMessage): void`（`dsh-agent/lib/types/runtime-types.d.ts` L115）——**没有 `id` 字段**（id 由工厂自动生成），content 是 `ContentBlock[]` 不是字符串。正确姿势：`import { createUserMessage } from '@deepseek-ai/dsh-llm'`（dsh-llm/lib/index.js L176 导出），`agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-im-qq' } }))` |
| ⚠️ workspace 前置注册 | `cwd` 存在 ≠ workspace 已注册。**显式两步**：① `workspaceRegistry` 先 resolve/create 对应 workspace（`dsh-workspace` 的 `create(path)` / `resolveByPath(path)` 均先 realpathNormalize）→ ② 再 `ctx.agents.create({ meta: { cwd } })`，否则报 `workspace-not-found` |
| ⚠️ 引擎重启幂等 | 插件随 dsh 引擎子进程跑，app 升级/崩溃/重启后：session-map 需从 `sessionPersistence` **恢复**、事件需**重新订阅**、WS 需重连。`onStart` 必须**幂等可重入**（此规范同时适用于整个 im-* 系列） |
| ⚠️ 事件名实测 | 实锤：`ctx.on('session/event', (session, event) => ...)`（`dsh-session-persistence/lib/index.js` L1155）——**监听签名是 `(session, event)` 两个参数**，第一个是 Session 对象（用 `session.id` 前缀 `'qq:'` 过滤），第二个是 `SessionEvent`；outbound 过滤 `assistant/message` 事件提取文本（事件序列实测：`turn/start → user/message → step/start → assistant/message → step/end → turn/end`）。事件名与 payload 形状仍以真实事件流抓取复核为准 |

---

## 8. 配置 Schema（cordis.patch.yml）

```yaml
- id: dsh-im-qq
  name: dsh-im-qq
  config:
    id: '你的AppID'                 # 必须加引号（避免 YAML 数字解析）
    secret: '你的AppSecret'        # 二选一：secret 明文 或 secretEnv 引用
    secretEnv: 'DSH_QQ_SECRET'     # 优先推荐：从环境变量读，配置只存引用（与 dsh 凭证哲学一致）
                                   # secret 与 secretEnv 同时给则报错（互斥，不留歧义）
    sandbox: true                   # 先沙箱验证，稳定后改 false
    transport: 'websocket'          # websocket | webhook（未来切换）
    provider: 'deepseek-official'
    model: 'deepseek-v4-flash'
    agentPreset: 'standard'         # standard / code / minimal / cordis / 自定义
    cwd: '/Users/xxx/qq-workspace'  # 独立工作区（如 ~/qq-workspace），必须真实存在
    workspaceIsolation: true        # 默认 true：每个会话用 <cwd>/<chatKey>/ 子目录，防并发文件互踩；可关
    allowFrom: ['*']                # C2C 白名单：空=全拒（fail-closed），'*'=显式放行
    groupAllowFrom: ['*']           # 群白名单：同上，空=全拒
    markdown: false                 # msg_type 2，需平台开通 markdown 权限
    typing: true                    # C2C 输入中指示（社区已实现，P4 前实测确认）
    streaming: true                 # C2C 流式回复（社区已实现 stream_messages，P4 前实测确认）
    streamThrottleMs: 1200
    deliverWindowMs: 900            # 轮内回复合并窗口
    deliverMaxWaitMs: 6000          # 合并最大等待
    textChunkLimit: 4000            # 单条静态回复上限
    replyPassiveLimit: 4            # 每条消息被动回复上限
    approval: true                  # 审批桥（QQ 内联按钮，走 INTERACTION_CREATE 事件）
    approvalTimeoutMs: 300000
    slashCommands: true             # /help /ping /me /new /approve /revoke /always
    debug: false
    # webhook 模式专用（启用时必填）：
    # webhookPath: '/qqbot'
    # webhookHost: '0.0.0.0'        # 需公网可达 + 平台配置 IP 白名单
    # webhookPort: 8080
```

> 注：`streaming` / `typing` 标注"社区已实现（dsh-qqbot-community 已实用 stream_messages 与 typing 上报），但接口存在性以 P4 前实测为准"——不把二期计划建立在纯假设上。

---

## 9. 安全与护栏

1. **白名单 fail-closed**：`allowFrom` / `groupAllowFrom` **空 = 全拒**（默认拒绝一切），`'*'` = 显式放行。⚠️ 本插件背后是带 bash/文件/子代理的全量 agent，**绝不允许空配置放行**（裸奔即灾难）
2. **审批策略（answerer 模式）**：⚠️ 签名实锤：`ApprovalService.request()` 的 JSDoc 明确**必须在 open turn 内调用**，否则抛 `approval.request() outside an open turn`（`dsh-user-approval/lib/index.js` L189 实锤 `ctx.waterfall(..., "approval/request", req, ...)`）。而 **QQ 按钮回调（INTERACTION_CREATE）发生在 turn 之外**，不能直接调 `request()`。正确做法：插件注册为 **answerer**（waterfall 中间件 `ctx.on('approval/request', (req, next) => ...)`），把审批请求变成 QQ 按钮消息，等回调后返回 `ApprovalOutcome`；**无 answerer 时 fail-closed**（返回 `'unavailable'`）。QQ 内联按钮审批（✅ 允许一次 / ⭐ 始终允许 / ❌ 拒绝）；**"始终允许"必须可撤销**——提供 `/revoke`（或 `/always clear`）命令，误点一次也能收回
3. **出站卫生**：剥离 `<think>` / `<system-reminder>` 内部标签；同轮回复合并；超长分段；被动回复限额 + 主动降级
4. **错误兜底**：LLM API 异常时**必须回错误文本**给用户（"服务暂时不可用，请稍后重试"）+ 记录日志，不能静默无响应
5. **凭据安全**：AppSecret 优先走 `secretEnv` 环境变量引用（配置只存引用）；明文 secret 仅作兜底；token 仅存内存定期刷新
6. **媒体隔离**：附件下载到 `<cwd>/.qq-media/`（不落系统目录）；图片经 dsh attachment 服务持久化（模型可见），服务不可用时回退路径注入
7. **并发隔离**：多会话共享 cwd 时默认 `<cwd>/<chatKey>/` 子目录（`workspaceIsolation: true`），防工具写文件互踩

---

## 10. 分阶段实施计划

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P0** | 前置核对（公域类型/测试人员/沙箱）+ 插件骨架 + install.sh/uninstall.sh + patch 注入 | `dsh --dump-config` 可见插件行；harness 启动无报错；bot 类型核对完成 |
| **P1** | transport/websocket + router + **单聊文本收发** + session-map 骨架（session key 用真实字段定案） | 沙箱私聊 @机器人 能收到回复；从真实消息抓取 openid 验证 |
| **P2** | **群聊 + 会话隔离 + agentPreset 挂载 + 白名单（fail-closed）** | 多群/多人会话互不干扰，工具可用；群消息经 `/v2/groups/{group_openid}/` 发出 |
| **P3** | outbound 管线 + 断线重连（op7 RESUME / op9 重 identify）+ 主动降级 + 错误兜底 | 长回复正常分段；断网自动恢复；**连续 2 小时不断连**；LLM 报错有兜底文本 |
| **P4** | 图片收发 / 流式 / typing（先实测确认接口）/ 审批桥（INTERACTION_CREATE）+ README/VERIFICATION | 常规场景可用，文档齐备；验收清单（§12）全过 |
| **P5** | transport/webhook 模式（官方强制时启用） | 配置切换后功能一致 |

---

## 11. 风险与边界（诚实标注）

| 项 | 风险/限制 | 对策 |
|---|---|---|
| 平台演进 | 官方长期弃用 WS、可能强制 Webhook | transport 双模式抽象，切换只改配置 |
| Webhook 公网门槛 | 桌面端无公网地址 | 保持 WS 为主；Webhook 需中转（云函数/服务器/内网穿透），列为 P5 |
| 平台审核 | 沙箱→正式需平台审核；群消息需@机器人；主动消息有频控 | 沙箱先行；文档说明边界 |
| 私域机器人 | 群消息永久 11255 | **P0 前置核对公域类型**（§3.4） |
| 30min 断连 | 服务器主动关 WS（4009），正常行为 | 日志标注；RESUME/重连自动恢复；验收标准明确"连续 2 小时" |
| 生命周期 | 插件随引擎子进程（桌面 app）启停，app 退出即离线 | 托盘常驻 = 7×24；onStart 幂等；如需脱离桌面，后续可做 headless 部署版 |
| 依赖社区实现 | 借鉴 MIT 代码存在上游漂移 | 锁版本拷贝进本仓库，不直接 npm 依赖 |
| 本机网络环境 | Shadowrocket TUN 模式 fake-ip DNS 会让 `bots.qq.com` 解析成 198.18.x → 连接被拦 | README troubleshooting 首条：连不上先查 DNS 解析是否 fake-ip |

---

## 12. 验收清单（VERIFICATION.md 必含）

- [ ] **前置**：q.qq.com → 开发设置 → 测试人员管理，已添加测试 QQ 号（否则 11255 永久性错误）
- [ ] **前置**：机器人类型为公域（否则群聊无法实现）
- [ ] openid / group_openid 从**真实收到的入站消息**里抄取（先发"你好"给 bot，看日志），不手工臆造
- [ ] 沙箱内：私聊 @机器人 文本收发通过
- [ ] 沙箱内：群聊 @机器人 收发通过，会话互不干扰
- [ ] 白名单 fail-closed 验证：空配置 = 全部拒绝；'*' = 放行
- [ ] 断连恢复：**连续 2 小时不断连**；kill WS 后自动 RESUME / 重 identify
- [ ] 错误兜底：断开 LLM 后发消息，收到"服务暂时不可用"而非无响应
- [ ] 长回复分段：>4000 字回复正确分段发出
- [ ] `session/event` 事件名与 payload 形状按**真实事件流**实测确认（e2e 手册方法），不按猜的写
- [ ] `/revoke` 撤销"始终允许"生效
- [ ] troubleshooting：DNS fake-ip 场景可定位（README 首条）

---

## 13. 修订记录

### v0.2 → v0.3：API 签名实锤修正（4 处，均已在本机 rc.6 源码逐行对照验证）

| # | 修正 | 源码实锤 |
|---|---|---|
| 1 | `agentPresets.mount('standard')` → `mount(agentCtx: Context, id?)`，**必须在工厂 `setup(agentCtx)` 回调里调**，第一参是 agent scoped context | `dsh-agent-presets/lib/types/index.d.ts` L159 `mount(agentCtx, id?)` |
| 2 | `agent.followup({ id, content, source })` → `followup(createUserMessage({ content, source }))`，**无 id 字段**、content 是 ContentBlock[]、source 是判别联合；`createUserMessage` 从 `@deepseek-ai/dsh-llm` 导入 | `dsh-agent/lib/types/runtime-types.d.ts` L115；`dsh-llm/lib/index.js` L176 |
| 3 | `session/event` 监听签名是 **`(session, event)` 两参数**，第一参是 Session 对象（`session.id` 前缀过滤），第二参是 SessionEvent；outbound 过滤 `assistant/message` | `dsh-session-persistence/lib/index.js` L1155 |
| 4 | approval 桥改 **answerer 模式**（`ctx.on('approval/request', (req, next) => ...)` waterfall 中间件），不能直接调 `request()`（必须在 open turn 内）；无 answerer fail-closed | `dsh-user-approval/lib/index.js` L189 `ctx.waterfall(..., "approval/request", ...)` |

> 注：`meta.agentPreset` 会写入 session header，但 agent-loop 工厂是否自动消费未实证——设计采取稳妥方案（setup 里显式 mount），一次做对。

### v0.1 → v0.2：审核意见（6 硬伤 + 8 完善）

#### 合入的硬伤修正（6 条）

1. **私域 vs 公域机器人** → §3.4 前置条件 #1：建 bot 必须选公域，否则群消息永久 11255
2. **openid bot 隔离** → §5.1 会话 key 设计：openid/group_openid 为 bot 维度哈希，白名单无法预填；群会话 key 标注待真实字段实测定案
3. **发消息缺 msg_seq** → §7：三处 POST 必带 msg_seq，自增/时间戳生成，不用固定值
4. **workspace 前置注册** → §7：显式两步（workspace 注册 → create agent），避免 workspace-not-found
5. **白名单 fail-open 危险** → §9.1：空=全拒（fail-closed），'*'=显式放行
6. **INTERACTION_CREATE 缺路由** → §5 路由表：按钮回调单独路由，与消息路由分开处理

#### 合入的完善建议（8 条）

1. **30min 断连周期** → §7/§11：4009 为正常行为；op9 必须重 identify；P3 验收"连续 2 小时"
2. **50015014 频控重试** → §7：指数退避（5s→10s→上限）写进 qqapi.js
3. **引擎重启幂等** → §7：onStart 幂等重入（session-map 恢复 + 事件重订阅），im-* 系列通用规范
4. **cwd 子目录隔离** → §8 `workspaceIsolation: true` 默认隔离，可关
5. **凭据 secretEnv** → §8：secret / secretEnv 二选一互斥，优先环境变量引用
6. **流式/typing 可行性** → §8 注：社区已实现（stream_messages/typing），P4 前实测确认
7. **"始终允许"可撤销** → §9.2：`/revoke`（或 `/always clear`）
8. **错误兜底** → §5/§9.4：agent 报错必须回错误文本，不静默

#### 合入的验收清单与决策点

- 验收清单（§12）：测试人员管理、openid 从真实消息抄、连续 2 小时、事件名实测、/revoke、fake-ip troubleshooting
- 决策点定案：① 命名 `dsh-im-qq`（npm/GitHub 均空，安全）② 自研 MIT 蓝本锁版本 ③ **P1+P2 一起做**（session-map 是骨架，晚做不如早做）④ transport 双模式 WS 先行 + webhook 预留 ⑤ cwd 默认 `~/qq-workspace` 独立目录 + agentPreset `standard`

---

*文档状态：v0.3 API 签名已全部实锤修正，代码尚未开工。审核通过后按 §10 分阶段实施。*
