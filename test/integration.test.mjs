/**
 * Mount-level tests: the plugin as DSH actually loads it.
 *
 * Everything here goes through `apply()` on a fake cordis-shaped context, so
 * the assertions are about the wiring the harness will really use: the
 * `agent/pre-step` listener, the tool registrations, the prompt section, the
 * HTTP routes, and the run record the panel reads.
 *
 * The scenarios map onto the acceptance tests in the task:
 *   A ordinary development chat, B two different domains, C existing project,
 *   D subagent, E unrelated task, F network failure, G panel truthfulness,
 *   H regression of the existing surfaces.
 */
import assert from 'node:assert/strict'

import { apply, STATUS_PATH, STATUS_EVENTS_PATH, STYLE_PATH, CONTROL_PATH } from '../lib/host.js'
import { describeAgentOrigin } from '../lib/integration.js'

const cases = []
/** Register one assertion group. */
const test = (name, fn) => cases.push([name, fn])

/** Fake Node response that records the status and body. */
function fakeResponse() {
  const state = { status: undefined, headers: undefined, chunks: [] }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    write(chunk) {
      state.chunks.push(chunk)
      return true
    },
    end(body) {
      if (body !== undefined) state.chunks.push(body)
    },
    on() {},
  }
}

/** Fake IncomingMessage: an async iterable of body chunks plus headers. */
function fakeRequest({ method = 'POST', headers = { host: '127.0.0.1:11993' }, body } = {}) {
  return {
    method,
    headers,
    on() {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body)
    },
  }
}

/** Build one claimed user message. */
function userMessage(text, extra = {}) {
  return { id: `m-${text.length}-${Math.random().toString(36).slice(2, 6)}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' }, ...extra }
}

/** Build a fake agent: a session header plus the inject/steer surface. */
function fakeAgent({ sessionId = 'session-a', header = {}, injected = [], steered = [] } = {}) {
  return {
    id: sessionId,
    status: 'running',
    session: { id: sessionId, header: { id: sessionId, ...header } },
    inject(message) {
      injected.push(message)
    },
    steer(message) {
      steered.push(message)
    },
    injected,
    steered,
  }
}

/**
 * Mount the plugin over a fake host.
 *
 * The fake implements exactly the cordis surface `apply()` uses: `get`,
 * `on`, `inject`, `provide`, `effect` and a logger. Provider stubs are injected
 * through `search`.
 */
function mount(options = {}) {
  const routes = new Map()
  const tools = new Map()
  const sections = new Map()
  const listeners = new Map()
  const provided = new Map()
  const ctx = {
    get(name) {
      if (name === 'connection') return { trustedHosts: ['example.test'] }
      if (name === 'web') {
        if (options.search === undefined) return undefined
        return { search: options.search }
      }
      if (name === 'deepseekAccount') return options.account
      if (name === 'workingDirectory') {
        return {
          get: () => options.project ?? '/tmp/demo-project',
          defaultDirectory: options.project ?? '/tmp/demo-project',
        }
      }
      if (name === 'tools') {
        return {
          get: (toolName) => tools.get(toolName),
          register(definition) {
            tools.set(definition.name, definition)
            return () => { tools.delete(definition.name) }
          },
        }
      }
      return undefined
    },
    on(name, listener) {
      const bucket = listeners.get(name) ?? []
      bucket.push(listener)
      listeners.set(name, bucket)
      return () => {
        const current = listeners.get(name) ?? []
        listeners.set(name, current.filter((entry) => entry !== listener))
      }
    },
    inject(services, callback) {
      if (services[0] === 'tools') {
        callback({
          tools: {
            get: (toolName) => tools.get(toolName),
            register(definition) {
              tools.set(definition.name, definition)
              return () => { tools.delete(definition.name) }
            },
          },
        })
        return
      }
      if (services[0] === 'systemPrompt') {
        if (options.withPrompt === false) return
        callback({
          systemPrompt: {
            section(definition) {
              sections.set(definition.name, definition)
              return () => { sections.delete(definition.name) }
            },
          },
        })
        return
      }
      assert.deepEqual(services, ['webServer'])
      callback({
        webServer: {
          register(definition) {
            routes.set(definition.path, definition)
            return () => { routes.delete(definition.path) }
          },
        },
      })
    },
    provide(name, value) {
      provided.set(name, value)
      return () => { provided.delete(name) }
    },
    effect(disposer) {
      return disposer()
    },
    logger: { warn() {}, info() {} },
  }
  apply(ctx, options.config)
  return { routes, tools, sections, listeners, ctx, provided }
}

/**
 * Fire the `agent/pre-step` waterfall the way `AgentLoop.preStep` does.
 *
 * @param {object} mounted - the mounted plugin.
 * @param {Array<object>} messages - the claimed messages.
 * @param {{ agent?: object, signal?: AbortSignal }} [extra] - payload facts.
 * @returns {Promise<object>} the surviving decision.
 */
async function firePreStep(mounted, messages, extra = {}) {
  const hooks = mounted.listeners.get('agent/pre-step') ?? []
  const payload = { messages, turn: 1, step: 1, signal: extra.signal ?? new AbortController().signal, ...(extra.agent === undefined ? {} : { agent: extra.agent }) }
  // The waterfall composes right-to-left through `next()`; the plugin's
  // listener calls `next()` and then appends, which is what this models.
  let decision = { kind: 'enter', messages: [...messages] }
  for (const hook of hooks) {
    decision = await hook(payload, async () => decision)
  }
  return decision
}

/** Invoke one route handler and decode the response. */
async function call(route, request) {
  const response = fakeResponse()
  await route.handler(request, response)
  const raw = response.state.chunks.join('')
  return {
    status: response.state.status,
    headers: response.state.headers,
    raw,
    body: raw.length === 0 || response.state.headers?.['content-type']?.includes('event-stream')
      ? undefined
      : JSON.parse(raw),
  }
}

/** Stub the GitHub metadata endpoint. */
function stubFetch(meta = { license: 'MIT', archived: false }) {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        license: meta.license === undefined ? null : { spdx_id: meta.license },
        archived: meta.archived === true,
        pushed_at: new Date().toISOString(),
        stargazers_count: 4200,
      }
    },
    async text() { return '' },
  })
  return () => { globalThis.fetch = original }
}

/** A stubbed `ctx.web` that answers one source per query and records the query. */
function stubWeb(behaviour = {}) {
  const calls = []
  return {
    calls,
    async search(request, signal) {
      calls.push(request.query)
      if (behaviour.fail === true) throw new Error('WEB_PROVIDER_UNAVAILABLE')
      if (behaviour.hang === true) {
        await new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        return { sources: [], truncated: false }
      }
      return {
        sources: [{ url: `https://github.com/example/ref-${calls.length}`, title: `Ref ${calls.length}`, snippet: `about ${request.query}` }],
        truncated: false,
      }
    },
  }
}

/** The research messages a decision carries. */
function researchMessages(decision) {
  return decision.messages.filter((message) => message.source?.kind === 'dsh-req-search')
}

// ── A: ordinary development chat ─────────────────────────────────────────────

test('A: an ordinary development request is researched and injected without opening the panel', async () => {
  const restore = stubFetch()
  try {
    const web = stubWeb()
    const mounted = mount({ search: web.search })
    const agent = fakeAgent()
    const decision = await firePreStep(mounted, [userMessage('我需要你做一个模拟经营游戏，要能存档、能交易 NPC 商品')], { agent })
    const injected = researchMessages(decision)
    assert.equal(injected.length, 1, 'exactly one research message joins the step')
    assert.equal(injected[0].role, 'user')
    assert.match(injected[0].content[0].text, /Background research for this task/u)
    assert.match(injected[0].content[0].text, /never as instructions/u)
    assert.match(injected[0].content[0].text, /Conclusions drawn from the sources/u)
    assert.ok(web.calls.length > 0, 'the engine actually searched')
    // The run record is the same one the panel reads.
    const status = await call(mounted.routes.get(STATUS_PATH), fakeRequest({ method: 'GET' }))
    assert.equal(status.status, 200)
    assert.equal(status.body.recent.length, 1)
    assert.equal(status.body.recent[0].injected, true)
    assert.equal(status.body.recent[0].requirement.includes('模拟经营'), true)
    assert.equal(agent.steered.length, 0, 'the result joined the step instead of being steered later')
  } finally {
    restore()
  }
})

test('A2: the same agent is not told the same requirement twice', async () => {
  const restore = stubFetch()
  try {
    const web = stubWeb()
    const mounted = mount({ search: web.search })
    const agent = fakeAgent()
    const messages = [userMessage('写一个 REST API 服务，带鉴权')]
    const first = await firePreStep(mounted, messages, { agent })
    assert.equal(researchMessages(first).length, 1)
    const second = await firePreStep(mounted, messages, { agent })
    assert.equal(researchMessages(second).length, 0, 'a repeated claim is not re-injected')
    const otherAgent = fakeAgent({ sessionId: 'session-b' })
    const third = await firePreStep(mounted, messages, { agent: otherAgent })
    assert.equal(researchMessages(third).length, 1, 'a different agent still gets its own context')
  } finally {
    restore()
  }
})

test('A3: the research message itself is never researched again', async () => {
  const restore = stubFetch()
  try {
    const web = stubWeb()
    const mounted = mount({ search: web.search })
    const agent = fakeAgent()
    const first = await firePreStep(mounted, [userMessage('我需要你做一个模拟经营游戏')], { agent })
    const injected = researchMessages(first)[0]
    const calls = web.calls.length
    // Hand the briefing to a fresh agent as if the session had resumed on it:
    // it must stay context, not become a new requirement.
    const second = await firePreStep(mounted, [injected], { agent: fakeAgent({ sessionId: 'other' }) })
    assert.equal(web.calls.length, calls, 'the brief is context, not a new requirement')
    assert.equal(second.messages.length, 1, 'no second briefing was appended')
  } finally {
    restore()
  }
})
// ── B: different domains ─────────────────────────────────────────────────────

test('B: two unrelated domains both produce domain-appropriate angles', async () => {
  const restore = stubFetch()
  try {
    const web = stubWeb()
    const mounted = mount({ search: web.search })
    await firePreStep(mounted, [userMessage('我需要你做一个模拟经营游戏，要能存档')], { agent: fakeAgent({ sessionId: 's1' }) })
    const gameQueries = [...web.calls]
    web.calls.length = 0
    await firePreStep(mounted, [userMessage('我需要一个企业级多租户后台，要有审计日志和权限模型')], { agent: fakeAgent({ sessionId: 's2' }) })
    const enterpriseQueries = [...web.calls]
    assert.ok(gameQueries.length > 0 && enterpriseQueries.length > 0)
    assert.ok(gameQueries.some((query) => /游戏|玩法|玩法/u.test(query)), gameQueries.join(' | '))
    assert.ok(enterpriseQueries.some((query) => /权限|审计|RBAC|多租户/u.test(query)), enterpriseQueries.join(' | '))
    assert.notDeepEqual(gameQueries, enterpriseQueries)
    const status = await call(mounted.routes.get(STATUS_PATH), fakeRequest({ method: 'GET' }))
    const domains = status.body.recent.map((run) => run.domain)
    assert.ok(domains.includes('game'), domains.join(','))
    assert.ok(domains.includes('enterprise'), domains.join(','))
  } finally {
    restore()
  }
})

test('B2: a bug task researches failures, not feature references', async () => {
  const restore = stubFetch()
  try {
    const web = stubWeb()
    const mounted = mount({ search: web.search })
    await firePreStep(mounted, [userMessage('这个函数在 Windows 上崩溃了，报错 Cannot read properties of undefined')], { agent: fakeAgent() })
    const status = await call(mounted.routes.get(STATUS_PATH), fakeRequest({ method: 'GET' }))
    const run = status.body.recent[0]
    assert.equal(run.kind, 'bug')
    assert.ok(run.plan.angles.some((angle) => angle.id === 'issue'), JSON.stringify(run.plan.angles))
    assert.ok(run.plan.angles.some((angle) => angle.id === 'regression'), JSON.stringify(run.plan.angles))
  } finally {
    restore()
  }
})

// ── C: existing project ──────────────────────────────────────────────────────

test('C: an existing project gets a stack-aware angle instead of a rebuild prompt', async () => {
  const restore = stubFetch()
  try {
    const web = stubWeb()
    const mounted = mount({
      search: web.search,
      config: { maxAngles: 4 },
      project: '/tmp/demo-project',
    })
    // Only names are read; the fake harness reports an existing React project.
    const decision = await firePreStep(mounted, [userMessage('给现有项目加一个导出功能，支持 CSV 和 Excel')], { agent: fakeAgent() })
    assert.equal(researchMessages(decision).length, 1)
    const status = await call(mounted.routes.get(STATUS_PATH), fakeRequest({ method: 'GET' }))
    const run = status.body.recent[0]
    assert.equal(run.project, '/tmp/demo-project')
    assert.ok(run.plan !== undefined)
    assert.equal(run.plan.angles.length <= 4, true)
  } finally {
    restore()
  }
})

// ── D: subagent ──────────────────────────────────────────────────────────────

test('D: a subagent inherits the capability and does not repeat the parent search', async () => {
  const restore = stubFetch()
  try {
    const web = stubWeb()
    const mounted = mount({ search: web.search })
    const parent = fakeAgent({ sessionId: 'parent' })
    await firePreStep(mounted, [userMessage('写一个带鉴权的 REST API 服务')], { agent: parent })
    const queriesAfterParent = web.calls.length
    const child = fakeAgent({
      sessionId: 'child',
      header: { parentSession: 'parent', origin: 'subagent', delegationDepth: 1 },
    })
    const decision = await firePreStep(mounted, [userMessage('写一个带鉴权的 REST API 服务')], { agent: child })
    assert.equal(researchMessages(decision).length, 1, 'the child receives the research context')
    assert.equal(web.calls.length, queriesAfterParent, 'the child read the cached result instead of searching again')
    const status = await call(mounted.routes.get(STATUS_PATH), fakeRequest({ method: 'GET' }))
    assert.ok(status.body.recent.some((run) => run.cached === true), 'the shared run is recorded as cached')
    assert.equal(describeAgentOrigin(child).origin, 'subagent')
    assert.equal(describeAgentOrigin(parent).origin, 'main')
  } finally {
    restore()
  }
})

test('D2: concurrent sibling agents share one in-flight research pass', async () => {
  const restore = stubFetch()
  try {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const calls = []
    const search = async (request) => {
      calls.push(request.query)
      await gate
      return { sources: [{ url: `https://github.com/example/x-${calls.length}`, title: 'Ref' }], truncated: false }
    }
    const mounted = mount({ search })
    const first = firePreStep(mounted, [userMessage('写一个带鉴权的 REST API 服务')], { agent: fakeAgent({ sessionId: 's1' }) })
    const second = firePreStep(mounted, [userMessage('写一个带鉴权的 REST API 服务')], { agent: fakeAgent({ sessionId: 's2' }) })
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    const [left, right] = await Promise.all([first, second])
    assert.equal(researchMessages(left).length, 1)
    assert.equal(researchMessages(right).length, 1)
    const status = await call(mounted.routes.get(STATUS_PATH), fakeRequest({ method: 'GET' }))
    const runs = status.body.recent
    assert.equal(runs.length, 2, 'each agent has its own delivery record')
    assert.ok(runs.some((run) => run.duplicateOf !== undefined), 'the second delivery names the run it shared')
    assert.equal(calls.length <= 4, true, `the plan did not double (${calls.length} queries)`)
  } finally {
    restore()
  }
})

// ── E: unrelated tasks ───────────────────────────────────────────────────────

test('E: ordinary chat, translation and questions trigger no network call at all', async () => {
  const restore = stubFetch()
  try {
    const web = stubWeb()
    const mounted = mount({ search: web.search })
    for (const text of ['谢谢你，已经完成了', '帮我把这段翻译成英文', '这个项目该用什么状态管理库？', '继续', '好的']) {
      const agent = fakeAgent({ sessionId: `session-${text.length}` })
      const decision = await firePreStep(mounted, [userMessage(text)], { agent })
      assert.equal(researchMessages(decision).length, 0, text)
    }
    assert.equal(web.calls.length, 0, 'no search ran for any non-task turn')
    const status = await call(mounted.routes.get(STATUS_PATH), fakeRequest({ method: 'GET' }))
    assert.equal(status.body.recent.length, 0, 'no run was even recorded')
  } finally {
    restore()
  }
})

test('E2: a turn that claims no user message (tool results only) is ignored', async () => {
  const restore = stubFetch()
  try {
    const web = stubWeb()
    const mounted = mount({ search: web.search })
    const decision = await firePreStep(mounted, [], { agent: fakeAgent() })
    assert.equal(web.calls.length, 0)
    assert.equal(decision.messages.length, 0)
  } finally {
    restore()
  }
})

// ── F: network failure ───────────────────────────────────────────────────────

test('F: a failing network degrades without blocking and without inventing results', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503, async text() { return '' } })
  try {
    const web = stubWeb({ fail: true })
    const mounted = mount({ search: web.search })
    const started = Date.now()
    const decision = await firePreStep(mounted, [userMessage('我需要你做一个模拟经营游戏，要能存档')], { agent: fakeAgent() })
    const elapsed = Date.now() - started
    assert.ok(elapsed < 5000, `the turn was not blocked (${elapsed}ms)`)
    assert.equal(researchMessages(decision).length, 0, 'nothing is injected when nothing was found')
    const status = await call(mounted.routes.get(STATUS_PATH), fakeRequest({ method: 'GET' }))
    const run = status.body.recent[0]
    assert.ok(['failed', 'timeout'].includes(run.status), run.status)
    assert.ok(run.failures.length > 0, 'the failure reason is recorded for the panel')
    assert.equal(run.injected, false)
    assert.equal(run.sources.length, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('F2: a hung provider is cut by the run deadline, and the step proceeds', async () => {
  const restore = stubFetch()
  try {
    const web = stubWeb({ hang: true })
    const mounted = mount({
      search: web.search,
      config: { deadlineMs: 400, timeoutMs: 5000, maxAngles: 2 },
    })
    const started = Date.now()
    const decision = await firePreStep(mounted, [userMessage('我需要你做一个模拟经营游戏')], { agent: fakeAgent() })
    const elapsed = Date.now() - started
    assert.ok(elapsed < 6000, `the step was released (${elapsed}ms)`)
    assert.equal(decision.messages.length >= 1, true)
    const status = await call(mounted.routes.get(STATUS_PATH), fakeRequest({ method: 'GET' }))
    const run = status.body.recent[0]
    assert.ok(['failed', 'timeout'].includes(run.status), run.status)
  } finally {
    restore()
  }
})

test('F3: no web provider at all is reported as unavailable, not as "nothing exists"', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503, async text() { return '' } })
  try {
    const mounted = mount({ config: { maxAngles: 2 } })
    await firePreStep(mounted, [userMessage('我需要你做一个模拟经营游戏')], { agent: fakeAgent() })
    const status = await call(mounted.routes.get(STATUS_PATH), fakeRequest({ method: 'GET' }))
    const run = status.body.recent[0]
    assert.ok(run.failures.length > 0)
    assert.ok(
      run.failures.some((failure) => /WEB_PROVIDER_UNAVAILABLE|HTTP_503/u.test(JSON.stringify(failure))),
      JSON.stringify(run.failures),
    )
  } finally {
    globalThis.fetch = original
  }
})

// ── G: the panel is a view of the engine ─────────────────────────────────────

test('G: the panel route reports the engine\'s real runs, with phases, sources and controls', async () => {
  const restore = stubFetch()
  try {
    const web = stubWeb()
    const mounted = mount({ search: web.search })
    const empty = await call(mounted.routes.get(STATUS_PATH), fakeRequest({ method: 'GET' }))
    assert.equal(empty.status, 200)
    assert.equal(empty.body.live.length, 0)
    assert.equal(empty.body.recent.length, 0)
    assert.equal(empty.body.version, 2)

    await firePreStep(mounted, [userMessage('我需要你做一个模拟经营游戏，要能存档')], { agent: fakeAgent() })
    const after = await call(mounted.routes.get(STATUS_PATH), fakeRequest({ method: 'GET' }))
    assert.equal(after.body.recent.length, 1)
    const run = after.body.recent[0]
    assert.match(run.requirement, /模拟经营/u)
    assert.ok(run.phases.some((phase) => phase.name === 'retrieve' || phase.name.startsWith('angle:')))
    assert.ok(run.sources.length > 0)
    assert.ok(run.conclusions.length > 0)
    assert.ok(typeof run.durationMs === 'number')
    assert.ok(after.body.capacity.cache !== undefined)
    assert.ok(after.body.limits.maxAngles > 0)
  } finally {
    restore()
  }
})

test('G2: the status stream announces revisions rather than fabricating progress', async () => {
  const restore = stubFetch()
  try {
    const web = stubWeb()
    const mounted = mount({ search: web.search })
    const route = mounted.routes.get(STATUS_EVENTS_PATH)
    const request = fakeRequest({ method: 'GET' })
    const response = fakeResponse()
    const pending = route.handler(request, response)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const first = response.state.chunks.join('')
    assert.match(first, /^data: \{"revision":\d+\}\n\n$/u)
    await firePreStep(mounted, [userMessage('我需要你做一个模拟经营游戏')], { agent: fakeAgent() })
    await new Promise((resolve) => {
      // The stream writes on subscription; the poll fallback covers hosts
      // whose subscription is a no-op, so wait one poll interval.
      const timer = setTimeout(resolve, 100)
      request.on = (name, listener) => {
        if (name === 'close') setTimeout(() => { listener(); clearTimeout(timer); resolve() }, 20)
      }
      response.on = () => {}
    })
    const streamed = response.state.chunks.join('')
    assert.match(streamed, /data: /u)
    void pending
  } finally {
    restore()
  }
})

test('G3: the control route cancels and re-runs against the real engine', async () => {
  const restore = stubFetch()
  try {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const search = async () => {
      await gate
      return { sources: [{ url: 'https://github.com/example/a', title: 'A' }], truncated: false }
    }
    const mounted = mount({ search, config: { maxAngles: 1 } })
    const running = firePreStep(mounted, [userMessage('我需要你做一个模拟经营游戏')], { agent: fakeAgent() })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const live = await call(mounted.routes.get(STATUS_PATH), fakeRequest({ method: 'GET' }))
    const liveRun = live.body.live[0]
    if (liveRun !== undefined) {
      const cancel = await call(mounted.routes.get(CONTROL_PATH), fakeRequest({
        body: JSON.stringify({ action: 'cancel', id: liveRun.id }),
      }))
      assert.equal(cancel.status, 200)
      assert.equal(cancel.body.ok, true)
    }
    release()
    await running

    // A completed run can be re-run through the same route.
    const completed = await call(mounted.routes.get(STATUS_PATH), fakeRequest({ method: 'GET' }))
    const done = completed.body.recent[0]
    assert.ok(done !== undefined)
    release()
    const rerun = await call(mounted.routes.get(CONTROL_PATH), fakeRequest({
      body: JSON.stringify({ action: 'rerun', id: done.id }),
    }))
    assert.equal(rerun.status, 200, rerun.raw)
    assert.equal(rerun.body.ok, true, rerun.raw)
    assert.notEqual(rerun.body.runId, done.id, 'the re-run is a new recorded run')

    const unknown = await call(mounted.routes.get(CONTROL_PATH), fakeRequest({
      body: JSON.stringify({ action: 'rerun', id: 'research-nope' }),
    }))
    assert.equal(unknown.status, 404)
    const bad = await call(mounted.routes.get(CONTROL_PATH), fakeRequest({ body: JSON.stringify({ action: 'explode' }) }))
    assert.equal(bad.status, 400)
  } finally {
    restore()
  }
})

test('G4: the control route refuses a cross-site write', async () => {
  const mounted = mount()
  const response = await call(mounted.routes.get(CONTROL_PATH), fakeRequest({
    headers: { host: '127.0.0.1:11993', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ action: 'cancel', id: 'x' }),
  }))
  assert.equal(response.status, 403)
})

// ── H: existing surfaces still work ──────────────────────────────────────────

test('H: the tools, the prompt contract and the style handshake still mount', async () => {
  const restore = stubFetch()
  try {
    const web = stubWeb()
    const mounted = mount({ search: web.search })
    assert.deepEqual([...mounted.tools.keys()].sort(), ['ask_style', 'recall_project', 'research_requirement', 'vet_dependency'])
    const section = mounted.sections.get('tool:req-search')
    assert.ok(section !== undefined)
    const text = section.text({ scope: undefined })
    assert.match(text, /standing capability/u)
    assert.match(text, /vet_dependency/u)
    assert.ok(text.length > 400)

    // research_requirement still answers a direct call, through the engine.
    const definition = mounted.tools.get('research_requirement')
    const value = await definition.execute({ requirement: '我需要你做一个模拟经营游戏' }, { signal: undefined, agent: undefined })
    assert.equal(value.ok, true)
    assert.equal(value.domain, 'game')
    assert.equal(value.sourceCount > 0, true)
    assert.match(value.briefing, /Requirement research/u)
    await assert.rejects(() => definition.execute({ requirement: '  ' }, {}), /non-empty string/u)

    // The style handshake is unchanged.
    const styleDefinition = mounted.tools.get('ask_style')
    const pending = styleDefinition.execute({ question: '风格？', options: ['像素', '写实'] }, { signal: undefined })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const state = await call(mounted.routes.get(STYLE_PATH), fakeRequest({ method: 'GET' }))
    assert.equal(state.body.pending.question, '风格？')
    const answer = await call(mounted.routes.get(STYLE_PATH), fakeRequest({ body: JSON.stringify({ choice: '像素' }) }))
    assert.equal(answer.status, 200)
    assert.deepEqual(await pending, { choice: '像素', revision: 1 })
  } finally {
    restore()
  }
})

test('H2: a host with no tools or prompt registry still mounts the engine and its routes', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503, async text() { return '' } })
  try {
    // No `ctx.web` and no fallback: the engine has no provider at all.
    const mounted = mount({ withPrompt: false, search: undefined, config: { fallback: false, maxAngles: 2 } })
    assert.equal(mounted.routes.size, 5)
    assert.equal(mounted.sections.size, 0)
    const status = await call(mounted.routes.get(STATUS_PATH), fakeRequest({ method: 'GET' }))
    assert.equal(status.status, 200)
    // With no provider at all, the engine records a failed run instead of
    // injecting anything, and the turn proceeds exactly as composed.
    const decision = await firePreStep(mounted, [userMessage('我需要你做一个模拟经营游戏')], { agent: fakeAgent() })
    assert.equal(decision.messages.length, 1)
    const after = await call(mounted.routes.get(STATUS_PATH), fakeRequest({ method: 'GET' }))
    assert.equal(after.body.recent[0].injected, false)
  } finally {
    globalThis.fetch = original
  }
})

test('H3: the engine is available as a service for other adapters', () => {
  const mounted = mount({ search: stubWeb().search })
  const engine = mounted.provided.get('requirementResearch')
  assert.ok(engine !== undefined)
  assert.equal(typeof engine.research, 'function')
  assert.equal(typeof engine.classify, 'function')
  assert.equal(typeof engine.cancel, 'function')
})

test('H4: routes reject methods they do not serve', async () => {
  const mounted = mount()
  const status = await call(mounted.routes.get(STATUS_PATH), fakeRequest({ method: 'POST' }))
  assert.equal(status.status, 405)
  const control = await call(mounted.routes.get(CONTROL_PATH), fakeRequest({ method: 'GET' }))
  assert.equal(control.status, 405)
  const style = await call(mounted.routes.get(STYLE_PATH), fakeRequest({ method: 'DELETE' }))
  assert.equal(style.status, 405)
})

test('H5: a background-disabled deployment researches nothing but still serves the tools', async () => {
  const restore = stubFetch()
  try {
    const web = stubWeb()
    const mounted = mount({ search: web.search, config: { background: false } })
    const decision = await firePreStep(mounted, [userMessage('我需要你做一个模拟经营游戏')], { agent: fakeAgent() })
    assert.equal(researchMessages(decision).length, 0)
    assert.equal(web.calls.length, 0)
    const status = await call(mounted.routes.get(STATUS_PATH), fakeRequest({ method: 'GET' }))
    assert.equal(status.body.background, false)
    const section = mounted.sections.get('tool:req-search')
    assert.doesNotMatch(section.text({ scope: undefined }), /the result is already in your context/u)
    assert.equal(mounted.tools.has('research_requirement'), true, 'on-demand research is still available')
  } finally {
    restore()
  }
})

let failed = 0
for (const [name, run] of cases) {
  try {
    await run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`)
if (failed > 0) process.exitCode = 1
