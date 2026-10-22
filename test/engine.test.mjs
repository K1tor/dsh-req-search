/**
 * Tests for the engine: classification, planning, caching, cancellation,
 * degradation and the observable run record.
 *
 * Providers are stubbed throughout, so no network is touched and every
 * assertion is about behaviour the code actually owns.
 */
import assert from 'node:assert/strict'

import { createResearchEngine, createResultCache, deriveConclusions, researchKey } from '../lib/engine.js'
import { classifyMessages, classifyText, sanitizeForResearch, inferProjectProfile } from '../lib/classify.js'
import { buildPlan, describePlan } from '../lib/strategy.js'

const cases = []
/** Register one assertion group. */
const test = (name, fn) => cases.push([name, fn])

/** Build one claimed user message. */
function message(text) {
  return { id: `m-${text.length}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/** A stubbed ctx whose `ctx.web` returns one source per query. */
function stubCtx(behaviour = {}) {
  const calls = []
  const ctx = {
    calls,
    get(name) {
      if (name !== 'web') return undefined
      return {
        async search(request, signal) {
          calls.push(request.query)
          if (behaviour.fail === true) throw new Error('WEB_PROVIDER_UNAVAILABLE')
          if (behaviour.delayMs !== undefined) {
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, behaviour.delayMs)
              signal?.addEventListener('abort', () => {
                clearTimeout(timer)
                resolve()
              }, { once: true })
            })
          }
          return {
            sources: [{
              url: `https://github.com/example/reference-${calls.length}`,
              title: `Reference ${calls.length}`,
              snippet: `snippet for ${request.query}`,
            }],
            truncated: false,
          }
        },
      }
    },
  }
  return ctx
}

/** Stub the GitHub metadata endpoint so enrichment is deterministic. */
function stubFetch(meta = { license: { spdx_id: 'MIT' }, archived: false, stars: 1200 }) {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        license: meta.license ?? null,
        archived: meta.archived === true,
        pushed_at: new Date().toISOString(),
        stargazers_count: meta.stars ?? 0,
      }
    },
    async text() { return '' },
  })
  return () => { globalThis.fetch = original }
}

/** A project-facts reader that reports an existing React project. */
const existingProject = async () => ({
  files: ['package.json', 'src', 'README.md', '.git'],
  manifest: { name: 'demo', dependencies: { react: '^19.0.0' } },
  dependencyNames: ['react'],
  version: 'stamp-1',
})

/** Build one engine over stubs. */
function engineFor(overrides = {}) {
  return createResearchEngine({
    ctx: overrides.ctx ?? stubCtx(),
    config: { maxAngles: 3, deadlineMs: 4000, ...overrides.config },
    readProjectFacts: overrides.readProjectFacts ?? existingProject,
  })
}

/** Build the request object the integration layer would send. */
function request(text, extra = {}) {
  const classified = classifyMessages([message(text)])
  return {
    text: classified.sanitized,
    requirement: text,
    kind: classified.kind === 'chat' ? 'feature' : classified.kind,
    label: classified.label,
    domain: classified.kind,
    reasons: classified.reasons,
    redacted: classified.redacted,
    project: '/tmp/demo-project',
    ...extra,
  }
}

test('a development request is classified as work; chat and translation are not', () => {
  const yes = [
    '我需要你做一个模拟经营游戏，要能存档、能交易 NPC 商品',
    '写一个 REST API 服务，带鉴权',
    '这个函数在 Windows 上崩溃了，报错 Cannot read properties of undefined',
    '优化一下首页加载性能，现在很卡',
    '升级一下依赖，加一个 date library',
    '给这个项目写单测，覆盖边界情况',
    'Add a subagent that reviews PRs',
  ]
  for (const text of yes) {
    assert.equal(classifyMessages([message(text)]).shouldResearch, true, text)
  }
  const no = [
    '谢谢你，已经完成了',
    '帮我把这段翻译成英文',
    '这个项目该用什么状态管理库？',
    '继续',
    '好的',
    'What does this function do?',
    '把这段文字总结成三点',
    '改一下那个按钮的颜色就行',
  ]
  for (const text of no) {
    assert.equal(classifyMessages([message(text)]).shouldResearch, false, text)
  }
})

test('classification names the task kind, so the research can differ by kind', () => {
  assert.equal(classifyText('这个函数崩溃了，报错 undefined is not a function').kind, 'bug')
  assert.equal(classifyText('优化一下启动性能，现在特别慢').kind, 'performance')
  assert.equal(classifyText('帮我重构这个模块，拆成两个包').kind, 'refactor')
  assert.equal(classifyText('写个单测覆盖边界情况').kind, 'test')
  assert.equal(classifyText('升级依赖，加一个 date library').kind, 'dependency')
  assert.equal(classifyText('帮我先把这段翻译一下').kind, 'translation')
})

test('the sanitizer removes secrets, paths and code before anything leaves the machine', () => {
  const raw = [
    '给这个项目加一个导出功能，我的 key=sk_live_abcdefghijklmnop',
    '路径是 C:\\Users\\ZT\\secret-project\\src\\app.ts',
    '```js\nconst token = "ghp_aaaaaaaaaaaaaaaaaaaa"\n```',
    '用 Bearer abcdefghijklmnopqrstuvwxyz 调接口',
  ].join('\n')
  const result = sanitizeForResearch(raw)
  assert.match(result.text, /导出功能/u, 'the task itself survives')
  assert.doesNotMatch(result.text, /sk_live_/u)
  assert.doesNotMatch(result.text, /ghp_/u)
  assert.doesNotMatch(result.text, /C:\\Users/u)
  assert.doesNotMatch(result.text, /abcdefghijklmnopqrstuvwxyz/u)
  assert.ok(result.redacted.includes('secret'))
  assert.ok(result.redacted.includes('local-path'))
  assert.ok(result.redacted.includes('code-block'))
})

test('a sanitized requirement that is empty is not researched', () => {
  const classified = classifyMessages([message('sk_live_abcdefghijklmnop')])
  assert.equal(classified.shouldResearch, false)
})

test('the plan adapts to the task kind and to the project stack', () => {
  const bugPlan = buildPlan({ kind: 'bug', domain: 'web', keywords: ['next', 'hydration'], language: 'en' }, { maxAngles: 4 })
  assert.deepEqual(bugPlan.angles.map((angle) => angle.id).slice(0, 3), ['issue', 'patch', 'regression'])
  assert.match(describePlan(bugPlan), /bug/u)

  const planned = buildPlan(
    { kind: 'feature', domain: 'game', keywords: ['模拟经营', '存档'], language: 'zh', project: { existingProject: true, stack: ['godot'] } },
    { maxAngles: 4 },
  )
  assert.equal(planned.angles[0].id, 'similar')
  assert.ok(planned.angles.some((angle) => angle.id === 'stack'), 'an existing project gets a stack-aware angle')
  const stackAngle = planned.angles.find((angle) => angle.id === 'stack')
  assert.match(stackAngle.query, /godot/u)
  for (const angle of planned.angles) {
    assert.ok(angle.query.length <= 110, angle.query)
    assert.ok(angularPurpose(angle), angle.id)
  }
})

/** Every angle must state what question it answers. */
function angularPurpose(angle) {
  return typeof angle.purpose === 'string' && angle.purpose.length > 0
}

test('a research run produces angles, sources, conclusions and a briefing', async () => {
  const restore = stubFetch()
  try {
    const ctx = stubCtx()
    const engine = engineFor({ ctx })
    const completed = await engine.research(request('我需要你做一个模拟经营游戏，要能存档'))
    assert.equal(completed.ok, true)
    assert.equal(completed.status, 'done')
    assert.equal(completed.angles.length, 3)
    assert.equal(ctx.calls.length, 3, 'one search per angle')
    assert.equal(completed.sources.length, 3)
    assert.ok(completed.conclusions.length > 0, 'conclusions are derived, not left to the model')
    assert.ok(completed.conclusions.some((line) => /Adoptable|Borrow/u.test(line)))
    assert.match(completed.briefing, /Requirement research/u)
    assert.equal(typeof completed.runId, 'string')
  } finally {
    restore()
  }
})

test('the run record is real: phases, sources and the injected flag', async () => {
  const restore = stubFetch()
  try {
    const engine = engineFor()
    const completed = await engine.research(request('写一个 REST API 服务，带鉴权'))
    engine.registry.mark(completed.runId, { injected: true })
    const snapshot = engine.snapshot()
    assert.equal(snapshot.live.length, 0)
    assert.equal(snapshot.recent.length, 1)
    const run = snapshot.recent[0]
    assert.equal(run.id, completed.runId)
    assert.equal(run.injected, true)
    const phaseNames = run.phases.map((phase) => phase.name)
    assert.ok(phaseNames.includes('classify'))
    assert.ok(phaseNames.includes('plan'))
    assert.ok(phaseNames.includes('conclude'))
    assert.ok(run.phases.every((phase) => typeof phase.at === 'number'), 'every phase carries a timestamp')
    assert.ok(run.plan.angles.length > 0)
    assert.equal(run.sources.length, completed.sources.length)
    assert.equal(typeof run.startedAt, 'number')
    assert.equal(typeof run.finishedAt, 'number')
  } finally {
    restore()
  }
})

test('the same task in the same project is served from the cache', async () => {
  const restore = stubFetch()
  try {
    const ctx = stubCtx()
    const engine = engineFor({ ctx })
    const first = await engine.research(request('写一个带鉴权的 REST API 服务'))
    const before = ctx.calls.length
    const second = await engine.research(request('写一个带鉴权的 REST API 服务'))
    assert.equal(second.cached, true)
    assert.equal(ctx.calls.length, before, 'no new search for an identical task')
    assert.notEqual(first.runId, second.runId, 'the second run still has its own record')
    const run = engine.snapshot().recent[0]
    assert.equal(run.cached, true)
    assert.ok(run.phases.some((phase) => phase.name === 'cache' && phase.state === 'done'))
  } finally {
    restore()
  }
})

test('a changed project version invalidates the cache', async () => {
  const restore = stubFetch()
  try {
    let version = 'stamp-1'
    const ctx = stubCtx()
    const engine = createResearchEngine({
      ctx,
      config: { maxAngles: 2, deadlineMs: 4000 },
      readProjectFacts: async () => ({ ...(await existingProject()), version }),
    })
    await engine.research(request('写一个带鉴权的 REST API 服务'))
    const before = ctx.calls.length
    version = 'stamp-2'
    const second = await engine.research(request('写一个带鉴权的 REST API 服务'))
    assert.equal(second.cached, undefined)
    assert.ok(ctx.calls.length > before, 'changed project files force a fresh search')
  } finally {
    restore()
  }
})

test('identical runs in flight share one research pass', async () => {
  const restore = stubFetch()
  try {
    const ctx = stubCtx({ delayMs: 40 })
    const engine = engineFor({ ctx })
    const text = '写一个带鉴权的 REST API 服务'
    const [left, right] = await Promise.all([
      engine.research(request(text)),
      engine.research(request(text)),
    ])
    assert.equal(ctx.calls.length, 3, 'the plan ran once, not twice')
    // Each agent still gets its own recorded delivery; the second names the run
    // whose retrieval it shared, which is what the panel shows.
    assert.notEqual(left.runId, right.runId)
    assert.equal(right.sharedWith, 'inflight')
    assert.equal(right.duplicateOf, left.runId)
    const runs = engine.snapshot().recent
    assert.equal(runs.length, 2)
    assert.ok(runs.some((run) => run.duplicateOf === left.runId))
  } finally {
    restore()
  }
})

test('a failed search degrades: no sources, notes recorded, the task is not blocked', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503, async text() { return '' } })
  try {
    const ctx = stubCtx({ fail: true })
    const engine = engineFor({ ctx })
    const completed = await engine.research(request('写一个带鉴权的 REST API 服务'))
    assert.equal(completed.ok, false)
    assert.notEqual(completed.status, 'done')
    assert.ok(completed.notes.some((note) => note.includes('WEB_PROVIDER_UNAVAILABLE')))
    const run = engine.snapshot().recent[0]
    assert.equal(run.status, 'failed')
    assert.ok(run.phases.some((phase) => phase.name === 'degrade'))
    assert.ok(run.failures.length > 0, 'the reason is recorded, not hidden')
    assert.equal(run.injected, false)
  } finally {
    globalThis.fetch = original
  }
})

test('a hung search is cut by the run deadline instead of blocking forever', async () => {
  const restore = stubFetch()
  try {
    const ctx = {
      calls: [],
      get(name) {
        if (name !== 'web') return undefined
        return {
          search: (_request, signal) => new Promise((resolve) => {
            // Never answers; only the deadline can end this.
            signal?.addEventListener('abort', () => resolve({ sources: [], truncated: false }), { once: true })
          }),
        }
      },
    }
    const engine = createResearchEngine({
      ctx,
      config: { maxAngles: 2, deadlineMs: 300, timeoutMs: 5000 },
      readProjectFacts: existingProject,
    })
    const started = Date.now()
    const completed = await engine.research(request('写一个带鉴权的 REST API 服务'))
    const elapsed = Date.now() - started
    assert.ok(elapsed < 3000, `deadline honoured (${elapsed}ms)`)
    assert.equal(completed.ok, false)
    const run = engine.snapshot().recent[0]
    assert.ok(['failed', 'timeout'].includes(run.status))
  } finally {
    restore()
  }
})

test('cancelling a run is recorded and stops the search', async () => {
  const restore = stubFetch()
  try {
    const ctx = stubCtx({ delayMs: 200 })
    const engine = engineFor({ ctx })
    const pending = engine.research(request('写一个带鉴权的 REST API 服务'))
    // Let the run reach its running phase before cancelling it.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const live = engine.snapshot().live
    assert.equal(live.length, 1)
    assert.equal(engine.cancel(live[0].id), true)
    const completed = await pending
    assert.equal(completed.cancelled, true)
    assert.equal(engine.cancel('research-not-a-run'), false)
  } finally {
    restore()
  }
})

test('an abort signal from the step ends the run cleanly', async () => {
  const restore = stubFetch()
  try {
    const controller = new AbortController()
    const engine = engineFor({ ctx: stubCtx({ delayMs: 200 }) })
    const pending = engine.research(request('写一个带鉴权的 REST API 服务', { signal: controller.signal }))
    controller.abort(new Error('user stopped the turn'))
    const completed = await pending
    assert.equal(completed.ok, false)
    assert.equal(completed.cancelled, true)
  } finally {
    restore()
  }
})

test('one dead angle does not take the whole run down', async () => {
  const restore = stubFetch()
  try {
    let calls = 0
    const ctx = {
      get(name) {
        if (name !== 'web') return undefined
        return {
          async search(request) {
            calls += 1
            if (calls === 2) throw new Error('WEB_PROVIDER_ERROR')
            return { sources: [{ url: `https://ok.example/${calls}`, title: 'ok' }], truncated: false }
          },
        }
      },
    }
    const engine = createResearchEngine({
      ctx,
      config: { maxAngles: 3, deadlineMs: 4000, fallback: false },
      readProjectFacts: existingProject,
    })
    const completed = await engine.research(request('写一个带鉴权的 REST API 服务'))
    assert.equal(completed.ok, true)
    assert.equal(completed.angles.filter((angle) => angle.sources.length > 0).length, 2)
    assert.ok(completed.notes.some((note) => note.includes('WEB_PROVIDER_ERROR')))
  } finally {
    restore()
  }
})

test('capacity limits how many runs may be in flight', async () => {
  const restore = stubFetch()
  try {
    const engine = engineFor({ ctx: stubCtx({ delayMs: 60 }), config: { maxAngles: 1, maxInflight: 1, deadlineMs: 4000 } })
    const first = engine.research(request('写一个带鉴权的 REST API 服务'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(engine.hasCapacity, false)
    const second = await engine.research(request('做一个管理后台的网页界面'))
    assert.equal(second.ok, true, 'the second run still completes')
    await first
    assert.equal(engine.hasCapacity, true)
  } finally {
    restore()
  }
})

test('conclusions separate adoptable code from borrow-only material', () => {
  const result = {
    ok: true,
    sources: [
      { url: 'https://a.example/1', title: 'MIT project', angles: ['similar'], meta: { license: 'MIT' } },
      { url: 'https://b.example/2', title: 'AGPL project', angles: ['reference'], meta: { license: 'AGPL-3.0' } },
      { url: 'https://c.example/3', title: 'Dead project', angles: ['pitfalls'], meta: { license: 'MIT', archived: true } },
    ],
    angles: [],
    notes: [],
  }
  const conclusions = deriveConclusions(result)
  assert.ok(conclusions.some((line) => /Adoptable/u.test(line) && /MIT project/u.test(line)))
  assert.ok(conclusions.some((line) => /Borrow the design/u.test(line) && /AGPL project/u.test(line)))
  assert.ok(conclusions.some((line) => /Archived/u.test(line)))
})

test('a failed run yields no conclusions (nothing is invented)', () => {
  assert.deepEqual(deriveConclusions({ ok: false, sources: [], angles: [], notes: [] }), [])
})

test('the cache evicts the oldest entry and reports its statistics', () => {
  const cache = createResultCache({ limit: 2 })
  cache.store('p', 'a', { id: 'a' }, { now: 1000 })
  cache.store('p', 'b', { id: 'b' }, { now: 1001 })
  // Reading 'a' refreshes it, so 'b' is now the oldest entry.
  assert.equal(cache.lookup('p', 'a', { ttlMs: 10_000, now: 1002 }).run.id, 'a')
  cache.store('p', 'c', { id: 'c' }, { now: 1003 })
  assert.equal(cache.lookup('p', 'b', { ttlMs: 10_000, now: 1004 }), undefined, 'the oldest entry was evicted')
  assert.equal(cache.lookup('p', 'a', { ttlMs: 10_000, now: 1005 }).run.id, 'a')
  assert.equal(cache.stats().size, 2)
  assert.equal(cache.stats().hits, 2)
})

test('the research key ignores case, punctuation and spacing', () => {
  assert.equal(researchKey('Build an Auth Service!'), researchKey('build   an auth service'))
  assert.equal(researchKey('做一个 管理后台'), researchKey('做一个管理后台'))
})

test('project facts are inferred from names only', () => {
  const profile = inferProjectProfile({
    files: ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', '.git'],
    manifest: { dependencies: { react: '19', electron: '33' } },
    dependencyNames: ['@deepseek-ai/cordis'],
  })
  assert.equal(profile.existingProject, true)
  assert.ok(profile.stack.includes('react'))
  assert.ok(profile.stack.includes('dsh-plugin'))
  assert.ok(profile.languages.includes('Python'))
  assert.ok(profile.languages.includes('Rust'))
  assert.ok(profile.signals.includes('existing-project'))
})

test('classification reads the claimed batch, not only the last message', () => {
  const batch = [message('我需要你做一个模拟经营游戏'), message('继续')]
  const classified = classifyMessages(batch)
  assert.equal(classified.shouldResearch, true)
  assert.match(classified.text, /模拟经营/u)
})

test('an empty claim batch researches nothing', () => {
  const classified = classifyMessages([])
  assert.equal(classified.shouldResearch, false)
  assert.equal(classified.kind, 'chat')
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
