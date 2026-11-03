/**
 * Borrowed Device Guard — Client half.
 *
 * A single bar above the composer. It only exists while borrowed-device mode
 * is armed, it says what is still on the machine, and it offers the two
 * actions that matter before leaving: move the API key into memory, or wipe
 * everything. The bar never renders outside a Session (the dock is a
 * session-scoped slot), which is exactly where the reminder is useful.
 */
window.__ModuleLoader__.load({
  id: 'dsh-borrowed-device',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'borrowedDevice'

    const zh = {
      title: '借用设备模式',
      keyOnDisk: '本机磁盘上仍有 API Key',
      keyMemory: '密钥来自环境变量，磁盘上没有副本',
      records: '本机仍保存着登录凭据',
      clean: '离开前只清理你自己的痕迹',
      foreign: '别人的会话',
      wipe: '清理我的',
      confirm: '只删你的数据？',
      trust: '这是我自己的电脑',
      details: '查看',
      hide: '收起',
      busy: '处理中…',
      wiped: '已清理你自己的数据',
      wipedPartial: '已清理你的数据，但部分文件仍被占用',
      trusted: '已记住这台电脑，借用模式关闭',
      trustedHint: '已把本机标记为你自己的电脑，借用模式关闭',
      undo: '撤销',
      armed: '已重新进入借用设备模式',
      empty: '没有发现你的残留',
      error: '清理失败',
      note: '模型提示已生效：不会把密钥写进文件，并会在收尾时提醒你清理。',
      scopeTitle: '将删除这些（只包含你的数据）',
      scopeEmpty: '没有需要删除的你的数据',
      scopeError: '读取清单失败；清理仍会按归属规则执行',
      scopeForeign: '不会动：别人的会话、机主的密钥、共享索引、shell 历史',
      revokeHint: '清理后建议到 platform.deepseek.com 吊销这个 key —— 删本地只防这台机器',
      confirmBtn: '确认删除',
      cancel: '取消',
      loading: '读取中…',
      settingTitle: '借用设备模式',
      settingDesc: '在公用电脑上使用时打开：提醒你清理本机痕迹，并避免把密钥写进磁盘。',
    }

    const en = {
      title: 'Borrowed-device mode',
      keyOnDisk: 'An API key is still stored on this disk',
      keyMemory: 'The key comes from the environment; no copy on disk',
      records: 'A login credential is still stored on this machine',
      clean: 'Clean up your own traces before you leave',
      foreign: "other people's sessions",
      wipe: 'Clean mine',
      confirm: 'Delete only yours?',
      trust: 'This is my own computer',
      details: 'Details',
      hide: 'Hide',
      busy: 'Working…',
      wiped: 'Removed your local data',
      wipedPartial: 'Removed your data, but some files are still in use',
      trusted: 'This computer is remembered; borrowed mode is off',
      trustedHint: 'This machine is marked as yours; borrowed mode is off',
      undo: 'Undo',
      armed: 'Borrowed-device mode is on again',
      empty: 'No traces of yours found',
      error: 'Cleanup failed',
      note: 'The agent now avoids writing secrets to disk and will remind you before you leave.',
      scopeTitle: 'These will be deleted (yours only)',
      scopeEmpty: 'Nothing of yours needs deleting',
      scopeError: 'Could not read the list; the cleanup still follows the ownership rules',
      scopeForeign: "Left alone: other people's sessions, their key, the shared index, shell history",
      revokeHint: 'Afterwards, revoke this key at platform.deepseek.com — deleting locally only protects this machine',
      confirmBtn: 'Delete',
      cancel: 'Cancel',
      loading: 'Loading…',
      settingTitle: 'Borrowed-device mode',
      settingDesc: 'Turn this on when using a public computer: it reminds you to clean up and keeps your key off the disk.',
    }

    const CSS = `
.bdg-bar{display:flex;align-items:center;gap:8px;width:calc(100% - 2 * var(--dsh-composer-side-clearance, 16px));max-width:var(--dsh-composer-card-max-width, 100%);margin:0 auto 8px;padding:7px 10px;box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1.35}
.bdg-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-warn-primary)}
.bdg-dot.risk{background:var(--dsw-alias-state-error-primary)}
.bdg-dot.ok{background:var(--dsw-alias-state-success-primary)}
.bdg-title{flex:none;font-weight:600;white-space:nowrap}
.bdg-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.bdg-btn{flex:none;appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);
  border-radius:7px;padding:3px 9px;font-size:12px;line-height:1.5;cursor:pointer;white-space:nowrap}
.bdg-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.bdg-btn:disabled{opacity:.55;cursor:default}
.bdg-btn.primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.bdg-btn.danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.bdg-flash{flex:none;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.bdg-flash.ok{color:var(--dsw-alias-state-success-primary)}
.bdg-flash.err{color:var(--dsw-alias-state-error-primary)}
.bdg-panel{width:calc(100% - 2 * var(--dsh-composer-side-clearance, 16px));max-width:var(--dsh-composer-card-max-width, 100%);margin:0 auto 8px;box-sizing:border-box;padding:6px 10px 8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.bdg-row{display:flex;gap:7px;padding:3px 0;align-items:baseline}
.bdg-lvl{flex:none;width:54px;font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:var(--dsw-alias-label-secondary)}
.bdg-lvl.critical{color:var(--dsw-alias-state-error-primary)}
.bdg-lvl.high{color:var(--dsw-alias-state-warn-primary)}
.bdg-detail{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bdg-empty{padding:3px 0;color:var(--dsw-alias-label-secondary)}
.bdg-scope-title{font-weight:600;padding:4px 0 2px;color:var(--dsw-alias-label-primary)}
.bdg-scope-note{padding:7px 0 2px;color:var(--dsw-alias-label-secondary)}
.bdg-scope-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:8px}
.bdg-setting{display:flex;align-items:center;gap:16px;width:100%;padding:10px 0;box-sizing:border-box}
.bdg-setting-text{flex:1;min-width:0}
.bdg-setting-title{font-size:13px;line-height:1.4;color:var(--dsw-alias-label-primary)}
.bdg-setting-desc{margin-top:2px;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary)}
.bdg-switch{flex:none;position:relative;width:36px;height:20px;padding:0;border-radius:10px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.bdg-switch.on{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary)}
.bdg-switch:disabled{opacity:.55;cursor:default}
.bdg-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
  background:var(--dsw-alias-label-secondary);transition:left .15s ease}
.bdg-switch.on .bdg-knob{left:18px;background:var(--dsw-alias-bg-base)}
@media (max-width:900px){.bdg-title{display:none}}
@media (max-width:760px){.bdg-flash{max-width:24%}}
`

    async function api(method, body) {
      const response = await fetch('/borrowed/api/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        cache: 'no-store',
        credentials: 'same-origin',
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok || !data || data.ok === false) {
        const message = (data && (data.error || data.summary)) || ('HTTP ' + response.status)
        throw new Error(message)
      }
      return data
    }

    function makeBar(ctx, t) {
      return function BorrowedDeviceBar() {
        const [status, setStatus] = React.useState(null)
        const [details, setDetails] = React.useState(null)
        const [busy, setBusy] = React.useState(null)
        const [confirming, setConfirming] = React.useState(false)
        const [flash, setFlash] = React.useState(null)
        const [justTrusted, setJustTrusted] = React.useState(false)
        const [scope, setScope] = React.useState(null)
        const [scopeError, setScopeError] = React.useState(false)
        const [, bumpLocale] = React.useState(0)

        React.useEffect(() => {
          if (typeof ctx.locale.subscribe !== 'function') return undefined
          return ctx.locale.subscribe(() => bumpLocale((value) => value + 1))
        }, [ctx])

        const refresh = React.useCallback(async () => {
          try {
            const next = await api('status')
            setStatus(next)
          } catch (error) {
            setFlash((current) => current || { kind: 'err', text: String(error.message || error) })
          }
        }, [])

        React.useEffect(() => {
          let alive = true
          void refresh()
          const timer = setInterval(() => {
            if (alive && !busy) void refresh()
          }, 8000)
          return () => {
            alive = false
            clearInterval(timer)
          }
        }, [refresh, busy])

        React.useEffect(() => {
          if (!flash) return undefined
          const timer = setTimeout(() => setFlash(null), 12000)
          return () => clearTimeout(timer)
        }, [flash])

        React.useEffect(() => {
          if (!confirming) return undefined
          const timer = setTimeout(() => setConfirming(false), 6000)
          return () => clearTimeout(timer)
        }, [confirming])

        React.useEffect(() => {
          if (!justTrusted) return undefined
          const timer = setTimeout(() => setJustTrusted(false), 12000)
          return () => clearTimeout(timer)
        }, [justTrusted])

        const run = async (method, body, message, after) => {
          setBusy(method)
          setConfirming(false)
          try {
            const result = await api(method, body)
            setFlash({ kind: 'ok', text: message(result) })
            await refresh()
            if (details) setDetails(null)
            if (after) after()
          } catch (error) {
            setFlash({ kind: 'err', text: t('error') + ': ' + String(error.message || error) })
          } finally {
            setBusy(null)
          }
        }

        const trust = () => {
          void run('trust', {}, () => t('trusted'), () => setJustTrusted(true))
        }

        const undoTrust = () => {
          void run('arm', {}, () => t('armed'), () => setJustTrusted(false))
        }

        const wipe = () => {
          if (!confirming) {
            void startConfirm()
            return
          }
          void run('wipe', { confirm: true }, (result) => {
            const failed = (result.failed || []).length
            return failed > 0 ? t('wipedPartial') : t('wiped')
          })
          setScope(null)
        }

        /** Show exactly what a wipe would delete before anything is touched. */
        const startConfirm = async () => {
          setConfirming(true)
          setScope(null)
          setScopeError(false)
          setBusy('preview')
          try {
            const result = await api('audit')
            setScope(result.findings || [])
          } catch {
            setScopeError(true)
          } finally {
            setBusy(null)
          }
        }

        const toggleDetails = async () => {
          if (details) {
            setDetails(null)
            return
          }
          setBusy('audit')
          try {
            const result = await api('audit')
            setDetails(result.findings || [])
          } catch (error) {
            setFlash({ kind: 'err', text: t('error') + ': ' + String(error.message || error) })
          } finally {
            setBusy(null)
          }
        }

        if (!status) return null

        // Trusting hides the bar, so keep a short-lived undo instead of making
        // a mis-click irreversible.
        if (status.trusted === true && justTrusted) {
          return h(React.Fragment, null,
            h('style', { key: 'style' }, CSS),
            h('div', { className: 'bdg-bar', key: 'bar' },
              h('span', { className: 'bdg-dot ok' }),
              h('span', { className: 'bdg-title' }, t('title')),
              h('span', { className: 'bdg-text' }, t('trustedHint')),
              h('button', {
                type: 'button',
                className: 'bdg-btn',
                disabled: busy !== null,
                onClick: undoTrust,
              }, t('undo')),
            ),
          )
        }

        if (status.armed !== true) return null

        const risky = status.keyOnDisk === true || status.records > 0
        const dotClass = 'bdg-dot' + (risky ? ' risk' : ' ok')
        const base = status.keyInMemory
          ? t('keyMemory')
          : status.keyOnDisk
            ? t('keyOnDisk')
            : status.records > 0
              ? t('records')
              : t('clean')
        const text = status.foreign > 0 ? `${base} · ${t('foreign')} ${status.foreign}` : base

        const rows = (details || []).map((item) => h('div', { className: 'bdg-row', key: item.id },
          h('span', { className: 'bdg-lvl ' + item.level }, item.level),
          h('span', { className: 'bdg-detail', title: item.detail },
            h('strong', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, item.title),
            item.detail ? ' — ' + item.detail : ''),
        ))

        const scopeItems = (scope || []).filter((item) => item.scope === 'mine' && item.id !== 'browser')
        const scopePanel = h('div', { className: 'bdg-panel', key: 'scope' },          h('div', { className: 'bdg-scope-title' }, t('scopeTitle')),
          scopeItems.length > 0
            ? scopeItems.map((item) => h('div', { className: 'bdg-row', key: 'scope-' + item.id },
              h('span', { className: 'bdg-detail', title: item.detail },
                h('strong', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, item.title),
                item.detail ? ' — ' + item.detail : '')))
            : h('div', { className: 'bdg-empty' }, scope === null && !scopeError ? t('loading') : t('scopeEmpty')),
          scopeError ? h('div', { className: 'bdg-empty' }, t('scopeError')) : null,
          h('div', { className: 'bdg-scope-note' }, t('scopeForeign') + (status.foreign > 0 ? `（${t('foreign')} ${status.foreign}）` : '')),
          h('div', { className: 'bdg-scope-note' }, t('revokeHint')),
          h('div', { className: 'bdg-scope-actions' },
            h('button', {
              type: 'button',
              className: 'bdg-btn danger',
              disabled: busy !== null || (scope === null && !scopeError),
              onClick: wipe,
            }, busy === 'wipe' ? t('busy') : t('confirmBtn')),
            h('button', {
              type: 'button',
              className: 'bdg-btn',
              disabled: busy !== null,
              onClick: () => { setConfirming(false); setScope(null); setScopeError(false) },
            }, t('cancel')),
          ),
        )

        return h(React.Fragment, null,
          h('style', { key: 'style' }, CSS),
          h('div', { className: 'bdg-bar', key: 'bar' },
            h('span', { className: dotClass, title: t('title') }),
            h('span', { className: 'bdg-title' }, t('title')),
            h('span', { className: 'bdg-text', title: text }, text),
            flash
              ? h('span', { className: 'bdg-flash ' + flash.kind, title: flash.text }, flash.text)
              : null,
            confirming
              ? null
              : h('button', {
                type: 'button',
                className: 'bdg-btn primary',
                disabled: busy !== null,
                onClick: wipe,
              }, busy === 'wipe' ? t('busy') : t('wipe')),
            h('button', {
              type: 'button',
              className: 'bdg-btn',
              disabled: busy !== null,
              onClick: trust,
            }, t('trust')),
            h('button', {
              type: 'button',
              className: 'bdg-btn',
              disabled: busy !== null,
              onClick: () => { void toggleDetails() },
            }, details ? t('hide') : t('details')),
          ),
          confirming ? scopePanel : null,
          details && !confirming
            ? h('div', { className: 'bdg-panel', key: 'panel' },
              rows.length > 0 ? rows : h('div', { className: 'bdg-empty' }, t('empty')))
            : null,
        )
      }
    }

    function makeSettingRow(ctx, t) {
      return function BorrowedDeviceSetting() {
        const [armed, setArmed] = React.useState(null)
        React.useEffect(() => {
          let alive = true
          void api('status').then((state) => {
            if (alive) setArmed(state.armed === true)
          }).catch(() => {})
          return () => { alive = false }
        }, [])
        const toggle = async () => {
          const next = armed !== true
          try {
            await api(next ? 'arm' : 'trust')
            setArmed(next)
          } catch {
            /* the composer bar reports failures when it is mounted */
          }
        }
        return h('div', { className: 'bdg-setting' },
          h('div', { className: 'bdg-setting-text' },
            h('div', { className: 'bdg-setting-title' }, t('settingTitle')),
            h('div', { className: 'bdg-setting-desc' }, t('settingDesc'))),
          h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': armed === true,
            'aria-label': t('settingTitle'),
            className: 'bdg-switch' + (armed === true ? ' on' : ''),
            disabled: armed === null,
            onClick: () => { void toggle() },
          }, h('span', { className: 'bdg-knob' })),
        )
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const offZh = ctx.locale.register(NS, 'zh', zh)
          const offEn = ctx.locale.register(NS, 'en', en)
          return () => {
            offZh()
            offEn()
          }
        }, 'dsh-borrowed-device: dictionaries')

        const t = (() => {
          try {
            return ctx.locale.bind(NS)
          } catch {
            return (key) => key
          }
        })()
        const Bar = makeBar(ctx, t)
        const Row = makeSettingRow(ctx, t)
        ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'borrowed-device',
          order: 30,
        }, Bar)), 'dsh-borrowed-device: composer dock')
        ctx.effect(() => ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'borrowed-device',
          order: 40,
        }, Row)), 'dsh-borrowed-device: settings row')
      },
    }
  },
})
