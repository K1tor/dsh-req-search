window.__ModuleLoader__.load({
  id: 'dsh-req-search',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    // ── locale ───────────────────────────────────────────────────────────────
    const zh = {
      panel: '项目研究',
      title: '项目研究',
      subtitle: '你说需求，后台自动去找参考并交给 Agent。',
      idle: '等待中。提出一个需求，这里会显示引擎在后台做了什么。',
      receipt: '后台记录',
      sources: '条参考',
      angles: '个角度',
      failed: '这次没查到参考',
      styleTitle: '风格选择',
      styleHint: 'Agent 需要你定个方向，选好后它会继续把项目做完',
      styleAnswered: '已选择',
      styleSubmitting: '提交中…',
      styleNote: '研究在后台自动进行，只有风格这类决策会来问你。',
      footer: '外部搜索结果，仅作参考。',
    }
    const en = {
      panel: 'Project research',
      title: 'Project research',
      subtitle: 'State a requirement; the engine researches it in the background and hands the result to the agent.',
      idle: 'Waiting. State a requirement and this panel shows what the engine did on its own.',
      receipt: 'Background log',
      sources: 'sources',
      angles: 'angles',
      failed: 'No references were found this time',
      styleTitle: 'Style choice',
      styleHint: 'The agent needs a direction from you; it will finish the work once you choose',
      styleAnswered: 'Selected',
      styleSubmitting: 'Submitting…',
      styleNote: 'Research runs in the background on its own; only style decisions come back to you.',
      footer: 'External search results; reference only.',
    }
    const NS = 'dsh-req-search'

    // ── styles ───────────────────────────────────────────────────────────────
    const CSS = `
.drs-root{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;
  padding:calc(28px + var(--dsh-frame-top-clearance,0px)) max(clamp(16px,4vw,48px),calc((100% - 860px)/2)) 24px;
  color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}
.drs-head{display:flex;flex-direction:column;gap:4px;flex:none;padding-bottom:14px}
.drs-title{margin:0;font-size:16px;font-weight:600;line-height:24px}
.drs-sub{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.drs-scroll{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px;padding-bottom:8px}
.drs-style{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:8px;flex:none;margin-bottom:10px}
.drs-styleDone{border-style:dashed;padding:8px 12px}
.drs-styleTitle{font-size:13px;font-weight:600;line-height:20px}
.drs-styleQuestion{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.drs-options{display:flex;flex-wrap:wrap;gap:8px}
.drs-option{height:32px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px}
.drs-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
.drs-btn{height:30px;padding:0 14px;border-radius:var(--dsw-radius-sm);border:1px solid transparent;
  font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.drs-btn:disabled{opacity:.5;cursor:default}
.drs-note{margin:-4px 0 10px}
.drs-meta{color:var(--dsw-alias-label-tertiary);font-size:11px}
.drs-chip{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:var(--dsw-radius-xs);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px}
.drs-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.drs-idle{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.drs-entry{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:4px}
.drs-entryReq{font-size:13px;font-weight:500;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.drs-entryMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.drs-foot{flex:none;padding-top:10px}
`
    const TAG_ID = 'dsh-req-search/panel.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + TAG_ID + '"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-req-search'
      tag.dataset.pluginCss = TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ── panel ────────────────────────────────────────────────────────────────
    const PANEL_ID = 'dsh-req-search'

    /** Read the engine's background activity. */
    async function readStatus() {
      const response = await fetch('/dsh-req-search/status', { cache: 'no-store' })
      if (!response.ok) return undefined
      const body = await response.json()
      return body && body.ok === true ? body : undefined
    }

    /**
     * The panel has no controls: the engine runs on its own, so the only
     * things worth showing are a pending style question and a quiet receipt
     * of what the engine did in the background.
     */
    function ProjectResearchPanel(props) {
      const t = props.t
      // The style question the Agent is waiting on, if any. This is the
      // panel's primary job: research happens in the background, only
      // decisions surface.
      const [styleState, setStyleState] = React.useState(undefined)
      const [styleBusy, setStyleBusy] = React.useState(false)
      // The background receipt: what the engine researched on its own.
      const [activity, setActivity] = React.useState(undefined)

      React.useEffect(() => {
        let closed = false
        const load = async () => {
          try {
            const response = await fetch('/dsh-req-search/style', { cache: 'no-store' })
            if (!response.ok) return
            const body = await response.json()
            if (!closed) setStyleState(body)
          } catch {
            // A host without the route simply has no question to show.
          }
        }
        void load()
        let source
        if (typeof EventSource === 'function') {
          source = new EventSource('/dsh-req-search/style/events')
          source.onmessage = () => { void load() }
          source.onerror = () => { source.close() }
        }
        return () => {
          closed = true
          source?.close()
        }
      }, [])

      // The receipt refreshes on a slow timer: it is a record of what already
      // happened, not a live progress bar.
      React.useEffect(() => {
        let closed = false
        const load = async () => {
          try {
            const status = await readStatus()
            if (!closed) setActivity(status)
          } catch {
            // A host without the route simply has no activity to show.
          }
        }
        void load()
        const timer = setInterval(() => { void load() }, 5000)
        return () => {
          closed = true
          clearInterval(timer)
        }
      }, [])

      const answerStyle = async (choice) => {
        setStyleBusy(true)
        try {
          const response = await fetch('/dsh-req-search/style', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ choice }),
          })
          const body = await response.json()
          setStyleState(body)
        } catch {
          // The question stays pending; the user can try again.
        } finally {
          setStyleBusy(false)
        }
      }

      // The pending question outranks everything else; an answered one becomes
      // a short receipt so the person can see what was sent back.
      const pending = styleState?.pending ?? null
      const answered = styleState?.answered ?? null
      const entries = activity?.entries ?? []

      return h(
        'div',
        { className: 'drs-root' },
        h(
          'header',
          { className: 'drs-head' },
          h('h1', { className: 'drs-title' }, t('title')),
          h('p', { className: 'drs-sub' }, t('subtitle')),
        ),
        pending === null
          ? answered === null
            ? null
            : h(
                'div',
                { className: 'drs-style drs-styleDone' },
                h(
                  'div',
                  { className: 'drs-row' },
                  h('span', { className: 'drs-meta' }, t('styleAnswered')),
                  h('span', { className: 'drs-chip' }, answered.choice),
                ),
              )
          : h(
              'section',
              { className: 'drs-style' },
              h('div', { className: 'drs-styleTitle' }, t('styleTitle')),
              h('p', { className: 'drs-styleQuestion' }, pending.question),
              h('p', { className: 'drs-meta' }, t('styleHint')),
              h(
                'div',
                { className: 'drs-options' },
                ...pending.options.map((option) =>
                  h(
                    'button',
                    {
                      key: option,
                      type: 'button',
                      className: 'drs-btn drs-option',
                      disabled: styleBusy,
                      onClick: () => void answerStyle(option),
                    },
                    option,
                  ),
                ),
              ),
              styleBusy ? h('div', { className: 'drs-meta' }, t('styleSubmitting')) : null,
            ),
        h('div', { className: 'drs-meta drs-note' }, t('styleNote')),
        h(
          'div',
          { className: 'drs-scroll' },
          entries.length === 0
            ? h('div', { className: 'drs-idle' }, t('idle'))
            : h(
                'div',
                { className: 'drs-group' },
                h('div', { className: 'drs-meta' }, t('receipt')),
                ...entries.map((entry, index) =>
                  h(
                    'div',
                    { key: String(index), className: 'drs-entry' },
                    h('div', { className: 'drs-entryReq' }, entry.requirement),
                    h(
                      'div',
                      { className: 'drs-entryMeta' },
                      entry.ok === true
                        ? `${entry.sourceCount} ${t('sources')} · ${(entry.angles ?? []).length} ${t('angles')}`
                        : t('failed'),
                    ),
                  ),
                ),
              ),
        ),
        h('footer', { className: 'drs-foot' }, h('div', { className: 'drs-meta' }, t('footer'))),
      )
    }

    /** Sidebar glyph: a magnifier over a document. */
    function PanelIcon(owner) {
      const size = (owner !== null && owner !== undefined && typeof owner.size === 'number') ? owner.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M14.5 3.5h-8a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h6' }),
        h('path', { d: 'M14.5 3.5 18 7v4' }),
        h('circle', { cx: 16.5, cy: 16.5, r: 3.2 }),
        h('path', { d: 'm19 19 2.2 2.2' }),
        h('path', { d: 'M9 8h3M9 11h2' }),
      )
    }

    // ── plugin body ─────────────────────────────────────────────────────────
    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-req-search: dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 2,
            label: () => t('panel'),
            locale: NS,
          },
          PanelIcon,
        ),
      )

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: () => ({ t }),
          },
          ProjectResearchPanel,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
