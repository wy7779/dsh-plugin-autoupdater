/**
 * Client half: one Settings page ("插件自动更新") that shows the updater's
 * configuration, triggers a manual run, and lists the last report.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-autoupdater',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-plugin-autoupdater'
    const STATE_PATH = '/dsh-auto-update/state'
    const SETTINGS_PATH = '/dsh-auto-update/settings'
    const RUN_PATH = '/dsh-auto-update/run'

    const CSS = `
.dau-page{padding-top:8px}
.dau-heading{color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px;margin:8px 0 4px}
.dau-intro{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin:0 0 12px}
.dau-row{border-bottom:.5px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:16px;padding:12px 0;display:flex}
.dau-main{min-width:0}
.dau-title{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dau-desc{color:var(--dsw-alias-label-secondary);margin-top:2px;font-size:11px;line-height:16px}
.dau-check{margin:0;accent-color:var(--dsw-alias-brand-primary);flex:none}
.dau-select{box-sizing:border-box;height:26px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px}
.dau-button{box-sizing:border-box;height:26px;padding:0 10px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;cursor:pointer}
.dau-button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dau-button:disabled{cursor:default;opacity:.5}
.dau-primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}
.dau-note{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.dau-ok{color:var(--dsw-alias-state-success-primary);font-size:11px;line-height:16px}
.dau-bad{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}
.dau-report{margin-top:10px;display:flex;flex-direction:column}
.dau-item{border-bottom:.5px solid var(--dsw-alias-border-l2);padding:8px 0;display:flex;flex-direction:column;gap:2px}
.dau-itemHead{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.dau-name{color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;word-break:break-all}
.dau-versions{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;font-family:var(--dsw-font-family-mono, monospace);white-space:nowrap}
.dau-status{font-size:11px;line-height:16px}
.dau-status.updated{color:var(--dsw-alias-state-success-primary)}
.dau-status.failed{color:var(--dsw-alias-state-error-primary)}
.dau-status.available{color:var(--dsw-alias-state-warn-primary)}
.dau-status.skipped,.dau-status.restart-required{color:var(--dsw-alias-label-secondary)}
`

    const zh = {
      'nav': '插件自动更新',
      'title': '插件自动更新',
      'intro': '定期检查已安装的插件有没有新版本，并自动安装；原地更新被拒（已安装）时，自动卸载后重装，失败会恢复旧版本。只处理从 npm 安装的第三方插件，本地 link 插件和官方随 DSH 发布的插件不在此列。',
      'enabled.title': '启用自动检查',
      'enabled.desc': '关闭后只保留手动检查。',
      'autoApply.title': '自动安装更新',
      'autoApply.desc': '关闭时只报告新版本，点「立即检查并更新」才会安装。',
      'autoRemediate.title': '失败时自动卸载重装',
      'autoRemediate.desc': 'DSH 不允许直接原地升级已装插件，卸载重装是官方路径。',
      'interval.title': '检查间隔',
      'interval.desc': '自动检查的周期。',
      'run': '立即检查并更新',
      'running': '正在检查/更新…',
      'lastRun': '上次检查：{time}',
      'never': '还没有检查过',
      'checked': '共检查 {count} 个插件',
      'reportTitle': '最近一次结果',
      'emptyReport': '最近一次检查没有发现可更新的插件。',
      'note': '部分插件更新后需要重启 DSH 才完全生效；更新过程中请勿关闭 DSH。',
      'error': '操作失败：{reason}',
      'status.updated': '已更新',
      'status.restart-required': '已更新（重启后生效）',
      'status.available': '有新版本（未安装）',
      'status.failed': '失败：{reason}',
      'status.skipped': '跳过：{reason}',
      'version': '{current} → {latest}',
    }
    const en = {
      'nav': 'Plugin auto updater',
      'title': 'Plugin auto updater',
      'intro': 'Periodically checks installed plugins for newer releases and installs them; when an in-place update is refused (already installed), it uninstalls and reinstalls, restoring the previous version if that fails. Only third-party npm plugins are handled — local link bundles and official DSH bundles are excluded.',
      'enabled.title': 'Enable automatic checks',
      'enabled.desc': 'Turn off to keep manual checks only.',
      'autoApply.title': 'Install updates automatically',
      'autoApply.desc': 'When off, new versions are only reported until you press the run button.',
      'autoRemediate.title': 'Uninstall + reinstall on refusal',
      'autoRemediate.desc': 'DSH refuses in-place upgrades of installed plugins; uninstall + reinstall is the official path.',
      'interval.title': 'Check interval',
      'interval.desc': 'How often the automatic check runs.',
      'run': 'Check and update now',
      'running': 'Checking / updating…',
      'lastRun': 'Last check: {time}',
      'never': 'Never checked',
      'checked': 'Checked {count} plugins',
      'reportTitle': 'Latest result',
      'emptyReport': 'No updatable plugin found in the last check.',
      'note': 'Some plugins need a DSH restart before the new build is fully active. Do not quit DSH while updating.',
      'error': 'The operation failed: {reason}',
      'status.updated': 'Updated',
      'status.restart-required': 'Updated (takes effect after restart)',
      'status.available': 'New version available (not installed)',
      'status.failed': 'Failed: {reason}',
      'status.skipped': 'Skipped: {reason}',
      'version': '{current} → {latest}',
    }

    /** Fetch one JSON endpoint and surface its error text. */
    async function requestJson(path, options) {
      const response = await fetch(path, options)
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        const reason = data !== null && typeof data === 'object' && typeof data.error === 'string'
          ? data.error
          : `HTTP ${response.status}`
        throw new Error(reason)
      }
      return data
    }

    /** Render the settings page. */
    function createPage(t) {
      return function AutoUpdatePage() {
        const [state, setState] = React.useState({ config: { enabled: true, intervalMinutes: 360, autoApply: true, autoRemediate: true }, report: [], lastRun: undefined, checked: undefined, running: false })
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState(undefined)

        const apply = (data) => {
          if (data === null || typeof data !== 'object') return
          setState({
            config: data.config ?? state.config,
            report: Array.isArray(data.report) ? data.report : [],
            lastRun: typeof data.lastRun === 'number' ? data.lastRun : undefined,
            checked: typeof data.checked === 'number' ? data.checked : undefined,
            running: data.running === true,
          })
        }

        React.useEffect(() => {
          requestJson(STATE_PATH)
            .then(apply)
            .catch((caught) => setError(t('error', { reason: String(caught.message ?? caught) })))
        }, [])

        const save = (patch) => {
          const config = { ...state.config, ...patch }
          setState({ ...state, config })
          requestJson(SETTINGS_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(config),
          })
            .then(apply)
            .catch((caught) => setError(t('error', { reason: String(caught.message ?? caught) })))
        }

        const run = () => {
          if (busy) return
          setBusy(true)
          setError(undefined)
          requestJson(RUN_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apply: true }),
          })
            .then(apply)
            .catch((caught) => setError(t('error', { reason: String(caught.message ?? caught) })))
            .finally(() => setBusy(false))
        }

        const toggleRow = (title, desc, checked, onChange) => h(
          'div',
          { className: 'dau-row' },
          h('div', { className: 'dau-main' }, h('div', { className: 'dau-title' }, title), h('div', { className: 'dau-desc' }, desc)),
          h('input', { type: 'checkbox', className: 'dau-check', checked, onChange }),
        )

        const statusText = (item) => {
          const reason = item.reason === undefined ? '' : String(item.reason)
          switch (item.status) {
            case 'updated': return t('status.updated')
            case 'restart-required': return t('status.restart-required')
            case 'available': return t('status.available')
            case 'failed': return t('status.failed', { reason })
            case 'skipped': return t('status.skipped', { reason })
            default: return String(item.status ?? '')
          }
        }

        const lastRun = state.lastRun === undefined
          ? t('never')
          : t('lastRun', { time: new Date(state.lastRun).toLocaleString() })

        return h(
          'div',
          { className: 'dau-page' },
          h('div', { className: 'dau-heading' }, t('title')),
          h('p', { className: 'dau-intro' }, t('intro')),
          toggleRow(t('enabled.title'), t('enabled.desc'), state.config.enabled, (event) => save({ enabled: event.target.checked })),
          toggleRow(t('autoApply.title'), t('autoApply.desc'), state.config.autoApply, (event) => save({ autoApply: event.target.checked })),
          toggleRow(t('autoRemediate.title'), t('autoRemediate.desc'), state.config.autoRemediate, (event) => save({ autoRemediate: event.target.checked })),
          h(
            'div',
            { className: 'dau-row' },
            h('div', { className: 'dau-main' }, h('div', { className: 'dau-title' }, t('interval.title')), h('div', { className: 'dau-desc' }, t('interval.desc'))),
            h(
              'select',
              {
                className: 'dau-select',
                value: String(state.config.intervalMinutes),
                onChange: (event) => save({ intervalMinutes: Number(event.target.value) }),
              },
              [60, 180, 360, 720, 1440].map((minutes) => h('option', { key: minutes, value: String(minutes) }, `${minutes / 60} 小时`)),
            ),
          ),
          h(
            'div',
            { className: 'dau-foot', style: { marginTop: '12px', display: 'flex', gap: '8px', alignItems: 'center' } },
            h('button', { type: 'button', className: 'dau-button dau-primary', disabled: busy, onClick: run }, busy ? t('running') : t('run')),
            h('span', { className: 'dau-note' }, lastRun),
            state.checked === undefined ? null : h('span', { className: 'dau-note' }, t('checked', { count: String(state.checked) })),
          ),
          error === undefined ? null : h('div', { className: 'dau-bad', style: { marginTop: '8px' } }, error),
          h('div', { className: 'dau-title', style: { marginTop: '16px' } }, t('reportTitle')),
          state.report.length === 0
            ? h('div', { className: 'dau-note', style: { marginTop: '6px' } }, t('emptyReport'))
            : h(
                'div',
                { className: 'dau-report' },
                state.report.map((item, index) =>
                  h(
                    'div',
                    { className: 'dau-item', key: `${item.name}-${index}` },
                    h(
                      'div',
                      { className: 'dau-itemHead' },
                      h('div', { className: 'dau-name' }, item.name),
                      item.latest === undefined ? null : h('div', { className: 'dau-versions' }, t('version', { current: String(item.current ?? '?'), latest: String(item.latest) })),
                    ),
                    h('div', { className: `dau-status ${String(item.status)}` }, statusText(item)),
                  ),
                ),
              ),
          h('div', { className: 'dau-note', style: { marginTop: '16px' } }, t('note')),
        )
      }
    }

    return {
      name: 'dsh-plugin-autoupdater',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {}
          const tag = document.createElement('style')
          tag.dataset.plugin = NS
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => {
            tag.remove()
          }
        }, 'dsh-auto-update: styles')
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-auto-update: dictionaries')
        const t = ctx.locale.bind(NS)
        const Page = createPage(t)
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({
            name: 'settings.section',
            id: 'plugin-auto-updater',
            order: 80,
            label: () => t('nav'),
            locale: NS,
          }, Page),
        )
      },
    }
  },
})
