# Changelog

所有重要变更记录（格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)）。

## [0.1.1] - 2026-08-16

### Fixed

- 清理验证文档中的 AppID / openid 示例凭据，避免幻影凭据入库。
- 版本号升至 0.1.1。

## [0.1.0] - 2026-08-16

### Added

- QQ 官方机器人（q.qq.com，公域）接入：私聊 / 群聊 @ / 频道 @ 与完整 agent 对话。
- WS 长连接传输（心跳 / 断线重连 / RESUME / op9 重 identify）。
- 会话隔离：每个用户/群独立 session（`qq:` 前缀），`/new` 开启新会话。
- 完整 agent 能力：工具 / 记忆 / 子代理 / 文件系统，经 `agentPresets.mount` 挂 standard preset。
- 审批桥：QQ 内联按钮（✅ 允许一次 / ⭐ 始终允许 / ❌ 拒绝）+ `/revoke` 撤销，点击者身份校验。
- 斜杠命令：`/help /ping /me /new /approve /always /revoke`。
- 白名单 fail-closed（私聊 / 群组分列）+ 频率限制（30 条/60s 滑动窗口）。
- 出站卫生：回复合并窗口、超长分段、剥离 dsh 内部标签、错误兜底。
- 凭据域集成：凭据写入 dsh 凭据域（不落 patch 明文），监听 `credentials/updated` 自动启动。
- 冒烟测试 `scripts/smoke-test.mjs`（mock dsh 运行时，无真实平台依赖）。