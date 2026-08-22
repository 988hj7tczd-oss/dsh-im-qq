# Security Policy / 安全说明

## 支持的版本

| 版本 | 支持 |
|---|---|
| 0.1.x | ✅ 当前版本 |

## 报告漏洞

发现安全漏洞请**不要公开提 issue**。请通过 GitHub 的
[Private vulnerability reporting](https://github.com/988hj7tczd-oss/dsh-im-qq/security/advisories/new)
提交，或发送邮件到仓库维护者邮箱（见 GitHub 主页）。

## 本插件的安全模型

- **白名单 fail-closed**：`allowFrom` / `groupAllowFrom` 为空时**全部拒绝**；`'*'` 需要显式声明。openid 是平台按 bot 哈希的，联调阶段用 `'*'`，上线前必须从真实消息日志里抄 openid 收紧（见 README 前置条件 #4）。
- **凭据不落明文**：AppSecret 通过凭据域（`$DSH_HOME/.credentials.yaml`）或环境变量（`DSH_QQ_SECRET` / `DSH_QQ_APP_ID`）注入，插件运行时解析，不写进 patch 配置。
- **审批护栏**：危险工具触发 dsh 审批时，QQ 内联按钮（✅/⭐/❌）用**发起者本人**的 openid 校验，他人点击被忽略；超时 fail-closed 返回不可用。
- **错误信息不外泄内部细节**：turn 错误时向用户展示兜底文本，不直接透传引擎内部错误。

## 报告时的检查清单

- 插件版本号（`package.json`）与复现步骤。
- 涉及凭据的问题，请先轮换 AppSecret 再报告。