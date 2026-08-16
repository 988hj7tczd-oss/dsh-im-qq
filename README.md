# dsh-im-qq

让 **DeepSeek Harness** 接入 **QQ 官方机器人**（q.qq.com）——通过 QQ（私聊 / 群聊 / 频道 @）直接与 harness 的完整 agent 对话：工具调用、记忆、子代理、文件系统与安全护栏，**与 Web UI 完全同源**。

> 设计文档：`qq-bot-plugin-design.md`（v0.3，API 签名已按 rc.6 源码实锤），完整设计见 GitHub 仓库
> 系列：`dsh-im-*`（一个 IM 平台一个插件，`core/` 平台无关可复用）

## 功能

| 能力 | 状态 |
|---|---|
| 私聊（C2C）文本收发 | ✅ 已实现 |
| 群聊 @机器人 / 频道 @机器人 | ✅ 已实现 |
| 会话隔离（每人/每群独立 session，`qq:` 前缀） | ✅ 已实现 |
| 完整 agent 能力（工具/记忆/子代理/文件系统） | ✅ 经 `agentPresets.mount` 挂 standard preset |
| WS 长连接（心跳 / 断线重连 / RESUME / op9 重 identify） | ✅ 已实现 |
| 回复合并 / 超长分段 / 去内部标签 / 错误兜底 | ✅ 已实现 |
| 白名单 fail-closed + 频控 | ✅ 已实现 |
| 审批桥（QQ 内联按钮 ✅/⭐/❌）+ `/revoke` 撤销 | ✅ 已实现 |
| 斜杠命令 `/help /ping /me /new /approve /always /revoke` | ✅ 已实现 |
| Webhook transport（官方强制时启用） | ⏳ P5 预留，未实现 |
| 图片收发 / 流式回复 / typing | ⏳ P4，接口需实测确认后实现 |

## 前置条件（P0 必须核对，缺一不可）

1. **机器人类型选「公域」**：q.qq.com 创建 bot 时必须选**公域机器人**——私域机器人无法用 `/v2/groups/` 发群消息，**永久报错 11255**，代码无法绕过。
2. **测试人员加入沙箱**：q.qq.com → 开发设置 → **测试人员管理**，添加自己的 QQ 号——沙箱外人员发消息报 11255，且是永久性错误。
3. **沙箱先行**：`sandbox: true` 先验证，稳定后改 `false` 切正式环境（正式环境需平台审核）。
4. **openid 只能从真实消息抄**：openid / group_openid 是平台按 bot 维度哈希的，无法提前预知——白名单联调期用 `'*'` 放行，上线前从真实收到的消息日志里抄 openid 收紧。

## 安装

```bash
# 0. 环境变量（推荐）或直接在 patch 配置里写 secret 明文
export DSH_QQ_SECRET='你的AppSecret'

# 1. 编辑本目录 cordis.patch.yml，把 id 改成你的 AppID（必须加引号）
# 2. 一键安装（symlink + home 级 patch 注册）
./install.sh

# 3. 重启 harness-desktop
```

卸载：`./uninstall.sh`（同样需要重启生效）。

安装后 `$DSH_HOME/cordis.patch.yml` 会追加一行 `dsh-im-qq` 注册块，插件包 symlink 到 `profiles/web/node_modules/dsh-im-qq`。可 `dsh --dump-config` 验证插件行可见。

## 配置方式

### 方式A（推荐）：桌面端「设置 → 插件 → QQ 机器人」

安装后重启 harness-desktop，打开 **设置 → 插件 → 插件配置**，找到 **QQ 机器人** 卡片：

1. 填入 AppID 与 AppSecret
2. 点 **保存并启动** —— 凭据写入 dsh 凭据域（`$DSH_HOME/.credentials.yaml`，不落 patch 文件），
   插件监听 `credentials/updated` 事件**自动启动机器人，无需重启应用**

> 凭据 ref：`QQ_BOT_APP_ID` / `QQ_BOT_APP_SECRET`（与凭据域既有命名对齐，已有值会直接复用并显示"已配置"）。

### 方式B（手动）：编辑 `$DSH_HOME/cordis.patch.yml`

```yaml
- insert:
    - id: dsh-im-qq
      name: dsh-im-qq
      config:
        id: '你的AppID'            # 必须加引号（防 YAML 数字解析）
        secret: '你的AppSecret'    # 明文；或 secretEnv: 'DSH_QQ_SECRET'（环境变量）
        sandbox: true
        transport: 'websocket'     # websocket（当前）| webhook（P5）
        provider: 'deepseek-official'
        model: 'deepseek-v4-flash'
        agentPreset: 'standard'    # standard / code / minimal / cordis / 自定义
        cwd: '~/qq-workspace'      # 独立工作区（自动创建）
        workspaceIsolation: true   # 每会话 <cwd>/<chatKey>/ 子目录
        allowFrom: ['*']           # 私聊白名单：空=全拒（fail-closed）
        groupAllowFrom: ['*']      # 群/频道白名单
        deliverWindowMs: 900       # 回复合并窗口
        deliverMaxWaitMs: 6000
        textChunkLimit: 4000       # 超长分段
        replyPassiveLimit: 4       # 被动回复上限（超限转主动）
        approval: true             # 审批桥（QQ 内联按钮）
        approvalTimeoutMs: 300000
        slashCommands: true
        debug: false
```

凭据优先级：row 配置 `id`/`secret` → 环境变量 `secretEnv` → 凭据域（方式A写入）。
修改后需重启 harness-desktop（或热加载）生效。

> ⚠️ 安全：本插件背后是带 bash/文件/子代理的全量 agent。白名单**空 = 全部拒绝**（fail-closed），`'*'` 是显式放行。联调用 `'*'`，上线务必收紧。

## 使用

- 私聊：直接给机器人发消息（沙箱内需为测试人员）
- 群聊 / 频道：@机器人 后跟消息
- 斜杠命令：`/help` `/ping` `/me` `/new` `/approve` `/always` `/revoke`
- 审批：agent 需要高权限操作时，会在 QQ 里弹出内联按钮——**✅ 允许一次** / **⭐ 始终允许** / **❌ 拒绝**；⭐ 可随时用 `/revoke` 撤销

## 架构

```
QQ 开放平台
  │  WS 长连接（transport/websocket.js：token/心跳/重连/RESUME）
  ▼
router.js → 标准消息对象 { id, chat, chatKey, content, replyTo }
  │   路由：AT_MESSAGE_CREATE→channel / GROUP_AT_MESSAGE_CREATE→group
  │         C2C_MESSAGE_CREATE→user / INTERACTION_CREATE→审批回调（分流）
  ▼
acl.js（fail-closed 白名单 + 频控）→ slash.js（命令拦截）→ session-map.js
  │   create: workspaceRegistry.create(cwd) → agents.create({sessionId, meta:{cwd, agentPreset},
  │           agentOptions:{provider,model}, setup: agentCtx => agentPresets.mount(agentCtx, preset)})
  │   resume: agents.resume({resumeSessionId, setup: mount})（懒恢复，映射持久化 .qq-sessions.json）
  ▼
agent.followup(createUserMessage({content, source:{kind:'plugin', plugin:'dsh-im-qq'}}))
  ▼
outbound.js：监听 session/event（过滤 qq: 前缀）→ 合并/去标签/分段/被动限额/错误兜底
  ▼
qqapi.js 发回 QQ（三处 POST 均带 msg_seq 防重放；50015014 频控指数退避）
```

换平台 = 换 `platform/` 目录（如飞书 = dsh-im-feishu 换平台适配层），`core/` 原样复用。

## Troubleshooting

1. **连不上 / 收不到消息，先查 DNS**：Shadowrocket 等代理的 TUN 模式 fake-ip DNS 会把 `bots.qq.com` 解析成 `198.18.x.x` 导致连接被拦。检查：`nslookup bots.qq.com`，若返回 `198.18.x.x` 即为 fake-ip，需在代理规则里放行 `bots.qq.com`、`api.sgroup.qq.com`、`sandbox.api.sgroup.qq.com`。
2. **发消息永久报 11255**：私域机器人 或 发送者不在测试人员名单 → 回 q.qq.com 核对机器人类型（公域）+ 测试人员管理。
3. **群消息发不出 / 私聊正常**：确认机器人是公域类型；群消息需 @机器人（GROUP_AT_MESSAGE_CREATE）。
4. **日志里 periodic WS close code=4009**：正常行为（QQ 服务器约每 30min 主动断连），插件会自动 RESUME/重连，无需处理。
5. **插件加载报"缺少凭据"**：`id` 或 secret 没配置。检查 patch 里 `id` 是否被 YAML 解析成数字（必须加引号），secretEnv 指向的环境变量是否已 export。
6. **消息回复慢/没回复**：`debug: true` 打开日志，看入站管线是否被 acl 拒绝、agent turn 是否报错（报错会有"服务暂时不可用"兜底文本）。
7. **回复里带 URL 发送失败**：QQ 平台要求消息中的 URL 先在 q.qq.com 后台 → 开发设置 → **消息URL配置** 里预先配置，否则整条消息发送失败。
8. **主动消息配额**：官方限制主动消息每月 4 条/人/群。插件回复默认全走**被动回复**（msg_id 有效期内），正常对话不消耗配额；超长回复超过被动上限（默认 4 条/消息）后才会落主动。
9. **审批按钮点了没反应 / 一直 loading**：插件已按官方要求 `PUT /interactions/{id}` 回应按钮回调；若仍异常，确认平台侧按钮互动事件已订阅（intent 1<<26）。

## 已知边界（诚实标注）

- **WS 下线风险**：官方长期方向是 Webhook（需公网 HTTPS + IP 白名单）。当前 WS 可用（2026-08 核实），架构已抽象双模式，官方强制时仅需实现 `platform/transport/webhook.js`（P5）。
- **图片/流式/typing**：接口存在性需真实环境实测（P4）；配置项已留，代码未实现调用。
- **主动消息频控**：QQ 对主动消息有限频，超限会收到 50015014，插件已做指数退避重试，但高频主动推送仍可能被平台限制。

## License

MIT
