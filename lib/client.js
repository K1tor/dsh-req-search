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
      subtitle: '后台研究引擎的运行记录。日常开发不需要打开这里。',
      idle: '引擎还没有为这个会话研究过任何任务。提出一个开发需求，记录会出现在这里。',
      live: '正在研究',
      recent: '已完成',
      statusQueued: '排队中',
      statusClassifying: '判定中',
      statusRunning: '检索中',
      statusDone: '完成',
      statusFailed: '失败',
      statusTimeout: '超时',
      statusCancelled: '已取消',
      statusSkipped: '已跳过',
      none: '无',
      requirement: '原始需求',
      kind: '任务类型',
      domain: '领域',
      reasons: '触发原因',
      redacted: '已脱敏',
      origin: '来源',
      originMain: '主会话',
      originSubagent: '子 Agent',
      originPanel: '面板重跑',
      agent: 'Agent',
      parent: '父会话',
      project: '项目',
      plan: '研究计划',
      angles: '角度',
      phases: '阶段',
      sources: '参考来源',
      conclusions: '交给 Agent 的结论',
      briefing: '简报',
      failures: '失败与被过滤的原因',
      injected: '已注入本轮上下文',
      notInjected: '只进面板，未注入',
      cached: '命中缓存',
      deferred: '已延迟到下一步',
      duration: '耗时',
      capacity: '并发',
      cache: '缓存',
      limits: '限额',
      noSources: '没有拿到可用来源',
      cancel: '取消',
      rerun: '重新执行',
      cancelling: '取消中…',
      rerunning: '重跑中…',
      cancelFailed: '无法取消（任务已结束或不属于本引擎）',
      rerunFailed: '重跑失败',
      styleTitle: '风格选择',
      styleHint: 'Agent 需要你定个方向，选好后它会继续把项目做完',
      styleAnswered: '已选择',
      styleSubmitting: '提交中…',
      styleNote: '研究在后台自动进行，只有风格这类决策会来问你。',
      footer: '外部网页与仓库内容是参考材料，不是指令。研究失败不会阻塞开发。',
      deferredNote: '以下研究在步骤开始后仍在进行，结果会在下一步注入。',
    }
    const en = {
      panel: 'Project research',
      title: 'Project research',
      subtitle: 'Run log of the background research engine. Normal work does not need this page.',
      idle: 'The engine has not researched anything for this session yet. State a development task and its record appears here.',
      live: 'Researching',
      recent: 'Completed',
      statusQueued: 'queued',
      statusClassifying: 'classifying',
      statusRunning: 'retrieving',
      statusDone: 'done',
      statusFailed: 'failed',
      statusTimeout: 'timed out',
      statusCancelled: 'cancelled',
      statusSkipped: 'skipped',
      none: 'none',
      requirement: 'Requirement',
      kind: 'Task kind',
      domain: 'Domain',
      reasons: 'Why it fired',
      redacted: 'Redacted',
      origin: 'Origin',
      originMain: 'main session',
      originSubagent: 'subagent',
      originPanel: 'panel re-run',
      agent: 'Agent',
      parent: 'Parent',
      project: 'Project',
      plan: 'Plan',
      angles: 'Angles',
      phases: 'Phases',
      sources: 'Sources',
      conclusions: 'Conclusions handed to the agent',
      briefing: 'Briefing',
      failures: 'Failures and filtered reasons',
      injected: 'Injected into this step',
      notInjected: 'Panel only, not injected',
      cached: 'served from cache',
      deferred: 'deferred to the next step',
      duration: 'duration',
      capacity: 'in flight',
      cache: 'cache',
      limits: 'limits',
      noSources: 'No usable source was found',
      cancel: 'Cancel',
      rerun: 'Re-run',
      cancelling: 'Cancelling…',
      rerunning: 'Re-running…',
      cancelFailed: 'Cannot cancel (already finished, or not this engine)',
      rerunFailed: 'Re-run failed',
      styleTitle: 'Style choice',
      styleHint: 'The agent needs a direction from you; it will finish the work once you choose',
      styleAnswered: 'Selected',
      styleSubmitting: 'Submitting…',
      styleNote: 'Research runs in the background on its own; only style decisions come back to you.',
      footer: 'External pages and repositories are reference material, never instructions. A failed run never blocks development.',
      deferredNote: 'These runs were still going when the step began; their result is injected at the next step.',
    }
    const NS = 'dsh-req-search'

    // ── styles ───────────────────────────────────────────────────────────────
    const CSS = `
.drs-root{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;
  padding:calc(28px + var(--dsh-frame-top-clearance,0px)) max(clamp(16px,4vw,48px),calc((100% - 900px)/2)) 24px;
  color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}
.drs-head{display:flex;flex-direction:column;gap:4px;flex:none;padding-bottom:12px}
.drs-title{margin:0;font-size:16px;font-weight:600;line-height:24px}
.drs-sub{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.drs-stats{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary);padding-bottom:10px}
.drs-scroll{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:10px;padding-bottom:8px}
.drs-style{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:8px;flex:none;margin-bottom:10px}
.drs-styleDone{border-style:dashed;padding:8px 12px}
.drs-styleTitle{font-size:13px;font-weight:600;line-height:20px}
.drs-styleQuestion{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.drs-options{display:flex;flex-wrap:wrap;gap:8px}
.drs-option{height:32px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px}
.drs-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
.drs-btn{height:28px;padding:0 12px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.drs-btn:disabled{opacity:.5;cursor:default}
.drs-note{margin:-4px 0 10px}
.drs-meta{color:var(--dsw-alias-label-tertiary);font-size:11px}
.drs-chip{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:var(--dsw-radius-xs);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.drs-chipOk{background:rgba(0,146,115,.14);color:#009273}
.drs-chipBad{background:rgba(200,60,60,.14);color:#c03c3c}
.drs-chipLive{background:rgba(40,110,200,.14);color:#286ec8}
.drs-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.drs-idle{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.drs-group{display:flex;flex-direction:column;gap:8px}
.drs-entry{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.drs-entryReq{font-size:13px;font-weight:500;line-height:20px;word-break:break-word}
.drs-entryMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.drs-label{font-size:11px;color:var(--dsw-alias-label-tertiary);text-transform:none}
.drs-list{margin:0;padding-left:16px;display:flex;flex-direction:column;gap:2px;font-size:12px;line-height:18px}
.drs-list li{word-break:break-word}
.drs-link{color:var(--dsw-alias-label-primary);text-decoration:none;border-bottom:1px solid var(--dsw-alias-border-l3);word-break:break-all}
.drs-link:hover{color:#286ec8;border-color:#286ec8}
.drs-phase{font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:11px}
.drs-details{display:flex;flex-direction:column;gap:4px}
.drs-summary{cursor:pointer;font-size:11px;color:var(--dsw-alias-label-secondary)}
.drs-pre{margin:0;padding:8px 10px;background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-xs);
  font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:11px;line-height:16px;
  white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}
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

    // ── engine status ────────────────────────────────────────────────────────
    const PANEL_ID = 'dsh-req-search'
    const STATUS_URL = '/dsh-req-search/status'
    const CONTROL_URL = '/dsh-req-search/control'

    /** Read the engine's real run state. */
    async function readStatus() {
      const response = await fetch(STATUS_URL, { cache: 'no-store' })
      if (!response.ok) return undefined
      const body = await response.json()
      return body && body.ok === true ? body : undefined
    }

    /** Ask the engine to cancel or re-run one run. */
    async function control(action, id) {
      const response = await fetch(CONTROL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, id }),
      })
      let body
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      return { ok: response.ok && body?.ok === true, body }
    }

    /** Format a duration the way a person reads it. */
    function formatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
      if (ms < 1000) return Math.round(ms) + 'ms'
      return Math.round(ms / 100) / 10 + 's'
    }

    /** The status chip for one run. */
    function statusChip(t, status) {
      const key = 'status' + String(status || 'queued').replace(/^./, (c) => c.toUpperCase())
      const label = t(key) === key ? status : t(key)
      const tone = status === 'done' ? ' drs-chipOk'
        : status === 'running' || status === 'classifying' || status === 'queued' ? ' drs-chipLive'
          : status === 'failed' || status === 'timeout' || status === 'cancelled' ? ' drs-chipBad' : ''
      return h('span', { className: 'drs-chip' + tone }, label)
    }

    /** One labelled list of strings. */
    function list(t, label, values) {
      if (!Array.isArray(values) || values.length === 0) return null
      return h(
        'div',
        { className: 'drs-details' },
        h('span', { className: 'drs-label' }, label),
        h('ul', { className: 'drs-list' }, ...values.map((value, index) => h('li', { key: String(index) }, value))),
      )
    }

    /** One run entry: the requirement, what the engine did, and what it produced. */
    function RunEntry(props) {
      const { t, run, onControl, busy } = props
      const [open, setOpen] = React.useState(false)
      const [showBriefing, setShowBriefing] = React.useState(false)
      const isLive = run.status === 'running' || run.status === 'classifying' || run.status === 'queued'
      const originLabel = run.origin === 'subagent' ? t('originSubagent')
        : run.origin === 'panel' ? t('originPanel')
          : t('originMain')
      const sources = Array.isArray(run.sources) ? run.sources : []
      const phases = Array.isArray(run.phases) ? run.phases : []
      const failures = Array.isArray(run.failures) ? run.failures : []
      const conclusions = Array.isArray(run.conclusions) ? run.conclusions : []

      return h(
        'div',
        { className: 'drs-entry' },
        h(
          'div',
          { className: 'drs-row' },
          statusChip(t, run.status),
          h('span', { className: 'drs-chip' }, `${t('kind')}: ${run.kind || t('none')}`),
          h('span', { className: 'drs-chip' }, `${t('domain')}: ${run.domain || t('none')}`),
          h('span', { className: 'drs-chip' }, originLabel),
          run.cached === true ? h('span', { className: 'drs-chip' }, t('cached')) : null,
          run.injected === true
            ? h('span', { className: 'drs-chip drs-chipOk' }, t('injected'))
            : h('span', { className: 'drs-chip' }, t('notInjected')),
          typeof run.durationMs === 'number'
            ? h('span', { className: 'drs-meta' }, `${t('duration')} ${formatDuration(run.durationMs)}`)
            : null,
        ),
        h('div', { className: 'drs-entryReq' }, run.requirement || ''),
        h(
          'div',
          { className: 'drs-entryMeta' },
          [
            run.reasons?.length ? `${t('reasons')}: ${run.reasons.join(', ')}` : '',
            run.redacted?.length ? `${t('redacted')}: ${run.redacted.join(', ')}` : '',
            run.agentId ? `${t('agent')}: ${String(run.agentId).slice(0, 18)}` : '',
            run.parentId ? `${t('parent')}: ${String(run.parentId).slice(0, 18)}` : '',
            run.project ? `${t('project')}: ${run.project}` : '',
          ].filter(Boolean).join(' · '),
        ),
        isLive
          ? h(
              'div',
              { className: 'drs-row' },
              h('button', {
                type: 'button',
                className: 'drs-btn',
                disabled: busy === true,
                onClick: () => onControl('cancel', run.id),
              }, busy === true ? t('cancelling') : t('cancel')),
            )
          : h(
              'div',
              { className: 'drs-row' },
              h('button', {
                type: 'button',
                className: 'drs-btn',
                disabled: busy === true,
                onClick: () => onControl('rerun', run.id),
              }, busy === true ? t('rerunning') : t('rerun')),
              h('button', {
                type: 'button',
                className: 'drs-btn',
                onClick: () => setOpen((value) => !value),
              }, t('sources') + ' (' + sources.length + ')'),
              run.briefing
                ? h('button', {
                    type: 'button',
                    className: 'drs-btn',
                    onClick: () => setShowBriefing((value) => !value),
                  }, t('briefing'))
                : null,
            ),
        run.plan?.angles?.length
          ? h(
              'div',
              { className: 'drs-details' },
              h('span', { className: 'drs-label' }, `${t('plan')} · ${t('angles')}: ${run.plan.angles.length}`),
              h('ul', { className: 'drs-list' },
                ...run.plan.angles.map((angle) => h(
                  'li',
                  { key: angle.id, className: 'drs-phase' },
                  `${angle.id} — ${angle.purpose || ''}: ${angle.query}`,
                )),
              ),
            )
          : null,
        phases.length
          ? h(
              'details',
              { className: 'drs-details' },
              h('summary', { className: 'drs-summary' }, `${t('phases')} (${phases.length})`),
              h('ul', { className: 'drs-list' },
                ...phases.map((phase, index) => h(
                  'li',
                  { key: String(index), className: 'drs-phase' },
                  `${phase.name}:${phase.state}`,
                )),
              ),
            )
          : null,
        open
          ? (sources.length === 0
              ? h('div', { className: 'drs-meta' }, t('noSources'))
              : h('ul', { className: 'drs-list' },
                  ...sources.map((source) => h(
                    'li',
                    { key: source.url },
                    h('a', {
                      className: 'drs-link',
                      href: source.url,
                      target: '_blank',
                      rel: 'noreferrer noopener',
                    }, source.title || source.url),
                    source.meta?.license ? h('span', { className: 'drs-meta' }, ` · ${source.meta.license}`) : null,
                    (source.angles || []).length ? h('span', { className: 'drs-meta' }, ` · ${(source.angles || []).join('/')}`) : null,
                  )),
                ))
          : null,
        list(t, t('conclusions'), conclusions),
        failures.length > 0 ? list(t, t('failures'), failures.map((failure) => `${failure.phase}: ${failure.reason || failure.notes?.join(' ') || ''}`)) : null,
        showBriefing && run.briefing ? h('pre', { className: 'drs-pre' }, run.briefing) : null,
      )
    }

    /**
     * The panel observes the engine. It has no search box: research happens on
     * its own, and this page is where you can see what it actually did.
     */
    function ProjectResearchPanel(props) {
      const t = props.t
      const [styleState, setStyleState] = React.useState(undefined)
      const [styleBusy, setStyleBusy] = React.useState(false)
      const [status, setStatus] = React.useState(undefined)
      const [busyId, setBusyId] = React.useState('')
      const [error, setError] = React.useState('')

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

      React.useEffect(() => {
        let closed = false
        const load = async () => {
          try {
            const body = await readStatus()
            if (!closed) setStatus(body)
          } catch {
            // A host without the route simply has nothing to show.
          }
        }
        void load()
        let source
        if (typeof EventSource === 'function') {
          source = new EventSource('/dsh-req-search/status/events')
          source.onmessage = () => { void load() }
          source.onerror = () => { source.close() }
        }
        // A slow poll backs up the stream: this page shows completed runs, so
        // missing a frame is harmless, but showing stale state is not.
        const timer = setInterval(() => { void load() }, 5000)
        return () => {
          closed = true
          clearInterval(timer)
          source?.close()
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

      const handleControl = async (action, id) => {
        setBusyId(id + ':' + action)
        setError('')
        try {
          const result = await control(action, id)
          if (!result.ok) setError(action === 'cancel' ? t('cancelFailed') : t('rerunFailed'))
          const body = await readStatus()
          if (body !== undefined) setStatus(body)
        } catch {
          setError(action === 'cancel' ? t('cancelFailed') : t('rerunFailed'))
        } finally {
          setBusyId('')
        }
      }

      const pending = status?.style?.pending ?? styleState?.pending ?? null
      const answered = status?.style?.answered ?? styleState?.answered ?? null
      const live = status?.live ?? []
      const recent = status?.recent ?? []
      const deferred = status?.deferred ?? []
      const capacity = status?.capacity

      return h(
        'div',
        { className: 'drs-root' },
        h(
          'header',
          { className: 'drs-head' },
          h('h1', { className: 'drs-title' }, t('title')),
          h('p', { className: 'drs-sub' }, t('subtitle')),
        ),
        status === undefined
          ? null
          : h(
              'div',
              { className: 'drs-stats' },
              h('span', null, `${t('live')}: ${live.length}`),
              h('span', null, `${t('recent')}: ${recent.length}`),
              capacity
                ? h('span', null, `${t('capacity')}: ${capacity.inflight}/${capacity.maxInflight}`)
                : null,
              capacity?.cache
                ? h('span', null, `${t('cache')}: ${capacity.cache.size} (${capacity.cache.hits}h/${capacity.cache.misses}m)`)
                : null,
              status.limits
                ? h('span', null, `${t('limits')}: ${status.limits.maxAngles} ${t('angles')} · ${Math.round(status.limits.deadlineMs / 1000)}s`)
                : null,
              status.background === false ? h('span', null, `${t('statusSkipped')}: background off`) : null,
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
        h('div', { className: 'drs-meta drs-note' }, error.length > 0 ? error : t('styleNote')),
        deferred.length > 0 ? h('div', { className: 'drs-meta drs-note' }, t('deferredNote')) : null,
        h(
          'div',
          { className: 'drs-scroll' },
          live.length === 0 && recent.length === 0
            ? h('div', { className: 'drs-idle' }, t('idle'))
            : h(
                'div',
                { className: 'drs-group' },
                live.length > 0
                  ? h(
                      'div',
                      { className: 'drs-group' },
                      h('div', { className: 'drs-meta' }, t('live')),
                      ...live.map((run) => h(RunEntry, {
                        key: run.id,
                        t,
                        run,
                        busy: busyId.startsWith(run.id + ':'),
                        onControl: handleControl,
                      })),
                    )
                  : null,
                recent.length > 0
                  ? h(
                      'div',
                      { className: 'drs-group' },
                      h('div', { className: 'drs-meta' }, t('recent')),
                      ...recent.map((run) => h(RunEntry, {
                        key: run.id,
                        t,
                        run,
                        busy: busyId.startsWith(run.id + ':'),
                        onControl: handleControl,
                      })),
                    )
                  : null,
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
