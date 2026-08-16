# dsh-im-qq 验收记录

> 状态：**真实环境联调通过（私聊 C2C 全链路）**——安装、配置卡片、入站、agent、回复、重启恢复均已实机验证。
> 依据设计文档 §10（分阶段）与 §12（验收清单）。

## 〇、真实环境联调记录（2026-08-16，沙箱）

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | WS 连接 + token | ✅ | 真实 AppID `1905******` token 获取成功 |
| 2 | 私聊入站 → 建会话 | ✅ | 会话 `qq:user:FBBDB6******FF94` 创建，openid 从真实消息抄取 |
| 3 | agent 生成回复 | ✅ | 会话日志：`assistant/message` + `turn/end completed`（deepseek-v4-flash） |
| 4 | 发回 QQ | ✅ | 主动测试消息送达；被动回复修复后正常 |
| 5 | 重启恢复（resume） | ✅ | 修复 `agentOptions` 缺失后，重启 → 首条消息 resume → 正常回复（此前 `{{model}}` 无值报错 → 兜底文本） |
| 6 | 错误兜底 | ✅ | `turn/end error` → "服务暂时不可用"被动发出（实测触发过） |
| 7 | 设置卡片 | ✅ | `/plugins/dsh-im-qq/client.js` HTTP 200；`credentials.describe/set` 通路可用 |
| 8 | 平台限制实测 | ✅ | `msg_type: 0` 纯文本正确；主动消息真实可发 |

**联调期实测发现的平台硬限制（已按官方文档修复）**：
- C2C/群 `msg_type: 0=纯文本`（原写死 1 → 40034127 无markdown模板权限）
- 被动回复 `msg_id` 取事件 **`d.id`**（原取 `d.msg_id`）
- `session/event` 事件负载在 **`event.data`**（原读顶层字段 → 回复静默丢失）
- 按钮回调按钮 id 在 **`data.resolved.button_id`**、点击者在 `user_openid`/`group_member_openid`（原解析字段错误）
- 互动事件须 `PUT /interactions/{id}` 回应（已加 `ackInteraction`）
- 主动消息每月限 4 条/人/群（出站已全走被动回复）

**待实测项（需更多真实场景）**：群聊 @机器人通路、4009 周期断连自动恢复（跑满 30min）、审批按钮实点（点击者字段最终确认）、>4000 字节长回复分段。

## 一、API 签名实锤核对（rc.6 源码逐行对照，2026-08 复核）

| # | 依赖 | 实锤签名 | 使用位置 |
|---|---|---|---|
| 1 | `agents.create` | `create(options: CreateAgentOptions): Promise<AgentHandle>`；`CreateAgentOptions = {sessionId, meta?: {cwd, parentSession?, seedLength?, origin?, delegationDepth?, agentPreset?}, seed?, agentOptions?: {provider?, model?, maxTokens?}, setup?: AgentSetup}` | `core/session-map.js#create` |
| 2 | `agents.resume` | `resume(options: ResumeAgentOptions): Promise<AgentHandle>`；`{resumeSessionId, agentOptions?, signal?, setup?}` | `core/session-map.js#resume` |
| 3 | `agent.followup` | `followup(message: UserMessage): void`（**无 id 字段**，content 是 ContentBlock[]） | `core/session-map.js#deliverCore` |
| 4 | `createUserMessage` | 从 `@deepseek-ai/dsh-llm` 导出；`createUserMessage({content, source})`；plugin source = `{kind:'plugin', plugin:string}` | `core/session-map.js` |
| 5 | `agentPresets.mount` | `mount(agentCtx: Context, id?: string): Promise<AgentPreset>`——**必须在工厂 setup(agentCtx) 回调里调**；agent-loop 工厂**不自动消费** meta.agentPreset（源码 grep 证实），显式 mount 是必要步骤 | `core/session-map.js#create/resume` |
| 6 | `session/event` | `ctx.on('session/event', (session, event) => …)` 两参数，第一参是 Session（用 `session.id` 前缀过滤）；`assistant/message` 事件 `{turn, step, message, usage?}` | `core/outbound.js` |
| 7 | `turn/end` | `{turn, reason: TurnEndReason}`；`reason.kind === 'error'` 时带结构化 LlmError → 错误兜底 | `core/outbound.js` |
| 8 | `approval/request` | waterfall：`(req, next) => Promise<ApprovalOutcome>`；`ApprovalOutcome = 'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'`（**无 'always'**）；`ApprovalRequest = {agent, toolName, callId?, reason?, …}`；无 answerer 时 dsh fail-closed 返回 'unavailable' | `core/approval.js` |
| 9 | `approval.setPolicy` | `setPolicy(agent, policy)`，policy = `'ask' \| 'never'`——「始终允许」= policy 切 `'never'`（可撤销） | `core/approval.js` |
| 10 | `workspaceRegistry` | `create(path, title?)` / `resolveByPath(path)`；agents.create 前必须显式注册 workspace（否则 `workspace-not-found`） | `core/session-map.js#create` |
| 11 | `SessionId` | 从 `@deepseek-ai/dsh-session` 导出（identity cast），`sessionId` 任意字符串（本插件用 `qq:` 前缀） | `core/session-map.js` |
| 12 | 服务名 | `ctx.agents` / `ctx.agentPresets` / `ctx.workspaceRegistry` / `ctx.sessionPersistence` / `ctx.approval` / `ctx.timer` / `ctx.sessions` 均确认 | `index.js` inject |

## 二、设计文档 §12 验收清单状态

- [x] **前置核对文档**：公域/测试人员/openid 前置已在 README 首部列出（需用户在 q.qq.com 操作，代码无法代办）
- [x] 私聊 @机器人 文本收发通过 —— ✅ **真实联调通过**（2026-08-16 沙箱）
- [ ] 群聊 @机器人 收发通过、会话互不干扰 —— 代码完成（`workspaceIsolation` 子目录隔离），**群聊通路待实测**
- [x] 白名单 fail-closed 验证：空配置 = 全拒；`'*'` = 放行 —— 代码完成（`core/acl.js`），配置空列表即可验证
- [ ] 断连恢复：WS 自动 RESUME / 重 identify + 指数退避 —— 代码完成，**「连续 2 小时不断连」需真实环境跑**
- [x] 错误兜底：LLM 报错回"服务暂时不可用" —— ✅ **真实触发验证**（`turn/end error` → 被动发出）
- [ ] 长回复分段：>4000 字节分段发出 —— 代码完成（`chunkText` 按 UTF-8 字节切），**超长回复待实测**
- [x] `session/event` 事件名与 payload 形状按**真实事件流**实测确认 —— ✅ **实测确认**：负载在 `event.data`（`{type,seq,time,data}`），outbound 已适配
- [x] `/revoke` 撤销"始终允许" —— 代码完成（`approval.setPolicy(agent,'ask')`）
- [x] troubleshooting：DNS fake-ip 场景可定位 —— README 首条

## 三、代码级检查（本机完成）

- [x] `node --check` 全部 10 个 JS 文件通过（node v26.4.0）
- [x] `bash -n` install.sh / uninstall.sh 通过
- [x] **冒烟测试 58 断言全过**（`node scripts/smoke-test.mjs`，mock dsh 服务）：
      router 事件路由（C2C/群@/频道@/按钮回调含官方字段 button_id/点击者）13 项、
      acl fail-closed 4 项、util 清洗/字节分段 4 项、qqapi URL/seq 5 项、
      session-map 生命周期 12 项（create→live 复用→/new→重启恢复→懒 resume→
      handle 写回→/new dispose 断言）、outbound 合并/被动/兜底 4 项、
      approval 桥 11 项（⭐→setPolicy(never)、超时 fail-closed、非 qq: 放行、
      他人点击被忽略/发起者生效/无点击者兼容）、slash 5 项
- [x] 插件入口装配验证：Config 默认值合并、secret/secretEnv 互斥、缺凭据报错、apply 无异常
- [x] `msg_seq`：三处 POST（user/group/channel）均带自增 `msg_seq`，非固定值
- [x] 频控 50015014：指数退避 5s→10s→20s→30s→60s 重试
- [x] 11255 永久性错误：不重试，日志明示原因
- [x] token：仅内存 + 提前 60s 定时刷新（`ctx.timer` 生命周期内自动清理）
- [x] 出站卫生：剥离 `<think>` / `<system-reminder>` 等内部标签
- [x] 被动回复限额：`replyPassiveLimit`（默认 4）次后自动转主动消息
- [x] 审批桥：answerer 模式（waterfall），按钮回调与消息路由分离，超时 fail-closed `'unavailable'`
- [x] 会话恢复：`.qq-sessions.json` 持久化 + `agents.get` live 复用 + `agents.resume` 懒恢复（onStart 幂等）
- [x] 卸载清理：transport.stop()（关 WS + 清心跳/重连定时器）+ qqapi.stop()（停 token 刷新）

### 开发期修复记录

| 问题 | 修复 |
|---|---|
| `ctx.agents.get(id)` 返回 **agent 本身**（非 handle）与 create/resume 返回 `AgentHandle {agent, dispose}` 形状混用 → 复用 live agent 时 `handle.agent` undefined | deliverCore 统一为 agent 对象；resume 分支同步回写 entry.handle |
| `beginTurn` 时缓冲尚未创建，被动 msg_id 预算丢失 | 改为 `pendingPassive` 预置，buffer 创建时消费 |
| `/new` 后重启丢失 generation，可能复用旧 sessionId 与磁盘日志冲突 | reset 置 sessionId=null 并持久化 generation；restore 支持 null sessionId |
| resume 失败（持久化损坏）直接崩 | 失败落回新建会话（generation+1） |
| transport 启动失败（网络/凭据）无恢复 | start 失败 30s 后自动重试 |

## 四、待真实环境联调项（需要用户配合）

1. **q.qq.com 创建公域机器人**，拿到 AppID/AppSecret → 配置 `id` + `secretEnv`（或 secret）
2. **测试人员管理**添加测试 QQ 号；`sandbox: true` 起步
3. 私聊发"你好"→ 观察日志：
   - WS READY（session_id）出现
   - 入站事件类型与 payload 字段与 `router.js` 解析是否一致（openid 字段名等）
   - 从日志抄下真实 openid → 收紧白名单
4. 群聊 @机器人 → 验证 `/v2/groups/{group_openid}/messages` 通路
5. 按钮回调：触发审批 → 点 ✅/⭐/❌ → 核对 `INTERACTION_CREATE` 的 data.id 解析（若字段不同，改 `router.js#routeInteraction` 一行）
6. 断网拔线 → 观察自动 RESUME / 重 identify；持续跑 2 小时验证 4009 周期断连自动恢复

## 五、修订记录

- 2026-08-16 v0.1：P0–P4 核心代码完成（WS transport / router / qqapi / session-map / outbound / approval / acl / slash / install 脚本 / 文档），API 全部按 rc.6 源码实锤。
- 2026-08-16 v0.1.1：脱敏联调记录中的 AppID / openid（隐私清理），仓库历史重写。
- 2026-08-16 v0.2（联调期修复）：真实环境联调通过（私聊 C2C 全链路）。修复清单：
  - 致命：`session/event` 负载在 `event.data`（outbound 读顶层字段 → 回复静默丢失）
  - 致命：C2C/群 `msg_type` 应为 `0`（写死 1 → 40034127）
  - 致命：被动回复 `msg_id` 取 `d.id`（原取 `d.msg_id`）
  - 致命：`agents.resume` 不带 `agentOptions` → 重启后 `{{model}}` 无值 → 兜底文本
  - 审查：resume 后 handle 未写回映射（`/new` 泄漏 / `/always` 失效）；凭据更新救不了失败 bot（改 credKey 对比重建 + 并发守卫）；审批按钮点击者身份校验（官方字段实锤：`data.resolved.button_id` / `user_openid` / `group_member_openid`）；互动事件 `PUT /interactions/{id}` 回应；HTTP 10s 超时；分段串行 + 全被动回复（主动消息月度配额）；`chunkText` 按 UTF-8 字节切；安装/卸载/文档完善。
  - 冒烟测试 47 → 58 断言。
