/**
 * dsh-im-qq 客户端半边 —— 「设置 → 插件 → QQ 机器人」配置卡片。
 *
 * 由 dsh-client-modules 扫描 package.json 的 dsh.client 声明后，作为
 * /plugins/dsh-im-qq/client.js 提供给浏览器（window.__ModuleLoader__.load 契约）。
 *
 * 凭据读写全部走 harness 内置的 credentials 远程域（web-search 卡片同款，稳定）：
 *   - 读状态：api.credentials.describe({ refs: [QQ_BOT_APP_ID, QQ_BOT_APP_SECRET] })
 *   - 保存：  api.credentials.set({ ref, value }) × 2
 * 宿主插件监听 credentials/updated 事件自动启动机器人（无需重启应用）。
 *
 * ⚠️ 不要在这里 inject / 依赖任何自定义 remote 服务（如 remote.qqConfig）：
 *   harness 客户端的 remote face 只能由编译期生成的 typert 描述符注册，第三方
 *   运行时无法挂载；注入一个永不出现的服务会让本插件条目 pending，触发 web boot
 *   fail-loud 审计，整个桌面端打不开。
 *
 * 本文件是经典脚本（无 import/export），只允许 require 平台 seed 词（react）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-im-qq',
  factory: (require) => {
    var React = require('react')
    var module = { exports: {} }
    var exports = module.exports

    var NS = 'dshImQq.settings'

    /** 与宿主 index.js 的 CRED_APPID / CRED_SECRET 保持一致。 */
    var REF_APPID = 'QQ_BOT_APP_ID'
    var REF_SECRET = 'QQ_BOT_APP_SECRET'

    var zh = {
      cardLabel: 'QQ 机器人',
      title: 'QQ 机器人（dsh-im-qq）',
      description:
        '通过 QQ（私聊 / 群聊 / 频道 @）直接与 harness 对话（工具 / 记忆 / 子代理与 Web UI 同源）。填写机器人凭据后保存即自动生效，无需重启。',
      appid: 'AppID',
      appidHint: 'q.qq.com 开放平台的应用 ID',
      secret: 'AppSecret',
      secretHint: '应用密钥；保存后不回显，仅存本机凭据库',
      statusConfigured: '已配置',
      statusUnconfigured: '未配置',
      save: '保存并启动',
      saving: '保存中…',
      saved: '✅ 已保存，机器人已启动',
      saveFailed: '保存失败',
      empty: 'AppID 与 AppSecret 不能为空',
      readError: '读取配置失败，请刷新后重试',
      configuredHint: '凭据已存在（保存可更新）。',
    }

    var en = {
      cardLabel: 'QQ Bot',
      title: 'QQ Bot (dsh-im-qq)',
      description:
        'Chat with the full harness agent through QQ (private / group / channel @), same tools, memory and subagents as the Web UI. Fill in the bot credentials and save — it applies immediately, no restart needed.',
      appid: 'AppID',
      appidHint: 'App ID from q.qq.com',
      secret: 'AppSecret',
      secretHint: 'Secret; never echoed back, stored in the local credential store',
      statusConfigured: 'Configured',
      statusUnconfigured: 'Not configured',
      save: 'Save & start',
      saving: 'Saving…',
      saved: '✅ Saved, bot started',
      saveFailed: 'Save failed',
      empty: 'AppID and AppSecret are required',
      readError: 'Failed to read config, please refresh',
      configuredHint: 'Credentials already present (saving updates them).',
    }

    // —— 内联样式（主题 CSS 变量，与内置卡片观感一致）——
    var card = {
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-3)',
      borderRadius: '10px',
      overflow: 'hidden',
      minWidth: 0,
    }
    var header = {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: '12px',
      padding: '12px 14px',
    }
    var title = {
      margin: 0,
      fontSize: '14px',
      fontWeight: 600,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-primary)',
    }
    var desc = {
      margin: '2px 0 0',
      fontSize: '12px',
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-tertiary)',
    }
    var badge = {
      flex: 'none',
      fontSize: '11px',
      lineHeight: '16px',
      borderRadius: '5px',
      padding: '1px 6px',
      color: 'var(--dsw-alias-label-secondary)',
      background: 'var(--dsw-alias-bg-layer-1)',
    }
    var badgeOk = Object.assign({}, badge, {
      color: 'var(--dsw-alias-state-success-primary)',
      background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)',
    })
    var body = {
      borderTop: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-module-platform)',
      padding: '10px 14px 12px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    }
    var row = { display: 'flex', flexDirection: 'column', gap: '4px' }
    var label = {
      fontSize: '11px',
      lineHeight: '17px',
      color: 'var(--dsw-alias-label-tertiary)',
    }
    var input = {
      boxSizing: 'border-box',
      width: '100%',
      height: '32px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: '13px',
      font: 'inherit',
      padding: '0 10px',
      outline: 'none',
    }
    var button = {
      alignSelf: 'flex-start',
      border: '1px solid var(--dsw-alias-border-l2)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      cursor: 'pointer',
      background: 'var(--dsw-alias-bg-layer-1)',
      borderRadius: '6px',
      padding: '5px 14px',
      fontSize: '13px',
    }
    var statusLine = {
      fontSize: '12px',
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary)',
    }
    var okLine = {
      fontSize: '12px',
      lineHeight: '18px',
      color: 'var(--dsw-alias-state-success-primary)',
    }
    var errLine = {
      fontSize: '12px',
      lineHeight: '18px',
      color: 'var(--dsw-alias-state-error-primary)',
    }

    /** 配置卡片：AppID + AppSecret → 保存（写凭据域，宿主自动启动机器人）。 */
    function QQConfigCard(props) {
      var t = props.t
      var [appid, setAppid] = React.useState('')
      var [secret, setSecret] = React.useState('')
      var [configured, setConfigured] = React.useState(false)
      var [busy, setBusy] = React.useState(false)
      var [message, setMessage] = React.useState('')
      var [error, setError] = React.useState('')

      var refresh = React.useCallback(function () {
        props
          .describe()
          .then(function (resp) {
            var creds =
              resp && resp.result && resp.result.value && resp.result.value.credentials
                ? resp.result.value.credentials
                : null
            var appidOk = creds ? !!creds[REF_APPID] && !!creds[REF_APPID].configured : false
            var secretOk = creds ? !!creds[REF_SECRET] && !!creds[REF_SECRET].configured : false
            setConfigured(appidOk && secretOk)
          })
          .catch(function () {
            setError(t('readError'))
          })
      }, [])

      React.useEffect(function () {
        refresh()
      }, [])

      var onSave = function () {
        if (!appid.trim() || !secret.trim()) {
          setError(t('empty'))
          return
        }
        setError('')
        setMessage('')
        setBusy(true)
        props
          .save({ appid: appid.trim(), secret: secret.trim() })
          .then(function () {
            setBusy(false)
            setSecret('')
            setConfigured(true)
            setMessage(t('saved'))
            refresh()
          })
          .catch(function (e) {
            setBusy(false)
            setError(String((e && e.message) || t('saveFailed')))
          })
      }

      return React.createElement(
        'div',
        { style: card },
        React.createElement(
          'div',
          { style: header },
          React.createElement(
            'div',
            null,
            React.createElement('div', { style: title }, t('title')),
            React.createElement('div', { style: desc }, t('description')),
          ),
          React.createElement(
            'span',
            { style: configured ? badgeOk : badge },
            configured ? t('statusConfigured') : t('statusUnconfigured'),
          ),
        ),
        React.createElement(
          'div',
          { style: body },
          React.createElement(
            'div',
            { style: row },
            React.createElement('label', { style: label }, t('appid')),
            React.createElement('input', {
              style: input,
              value: appid,
              placeholder: t('appidHint'),
              spellCheck: false,
              onChange: function (ev) {
                setAppid(ev.target.value)
              },
            }),
          ),
          React.createElement(
            'div',
            { style: row },
            React.createElement('label', { style: label }, t('secret')),
            React.createElement('input', {
              style: input,
              type: 'password',
              value: secret,
              placeholder: t('secretHint'),
              spellCheck: false,
              onChange: function (ev) {
                setSecret(ev.target.value)
              },
            }),
          ),
          React.createElement('div', { style: statusLine }, configured ? t('configuredHint') : t('statusUnconfigured')),
          message ? React.createElement('div', { style: okLine }, message) : null,
          error ? React.createElement('div', { style: errLine }, error) : null,
          React.createElement(
            'button',
            { style: button, disabled: busy, onClick: onSave },
            busy ? t('saving') : t('save'),
          ),
        ),
      )
    }

    function apply(ctx) {
      ctx.effect(
        function () {
          return ctx.locale.register(NS, { zh: zh, en: en })
        },
        'dsh-im-qq: settings dictionaries',
      )
      var t = ctx.locale.bind(NS)
      var api = ctx.get('connection') ? ctx.get('connection').api : null

      // 凭据变化（保存后）→ 刷新卡片状态
      ctx.effect(function () {
        return ctx.remote.$on('credentials/updated', function () {
          // 卡片组件内部状态由 describe 刷新；这里通过触发一次订阅驱动不可行时忽略
        })
      }, 'dsh-im-qq: credential invalidation listener')

      // 注册「设置 → 插件 → 插件配置」分区里的 QQ 机器人卡片
      ctx.slots.inject('settings.plugin.item', function () {
        return ctx.slots.register(
          {
            name: 'settings.plugin.item',
            id: 'dsh-im-qq',
            order: 30,
            locale: NS,
            inject: function () {
              return {
                describe: function () {
                  return api.credentials.describe({ refs: [REF_APPID, REF_SECRET] })
                },
                save: function (value) {
                  return api.credentials
                    .set({ ref: REF_APPID, value: value.appid })
                    .then(function () {
                      return api.credentials.set({ ref: REF_SECRET, value: value.secret })
                    })
                },
              }
            },
          },
          QQConfigCard,
        )
      })
    }

    exports.NS = NS
    exports.apply = apply
    exports.inject = ['slots', 'locale', 'connection', 'remote']
    return module.exports
  },
})
