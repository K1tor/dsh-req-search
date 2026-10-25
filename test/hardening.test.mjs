/**
 * Hardening tests: the security and reliability defects from the 2026-10
 * test report, written as permanent regressions.
 *
 * Each case states the defect it pins shut: credentials that must never
 * reach a provider's query, advisory lookups that must not fake a clean
 * bill of health, deadlines that must hold even against a provider that
 * ignores cancellation, delivery that must happen before it is claimed,
 * and the concurrency boundaries of cache, dedupe and project memory.
 *
 * Providers are stubbed throughout; no network is touched.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createResearchEngine, researchKey } from '../lib/engine.js'
import { classifyMessages, classifyText, sanitizeForResearch, stripSecrets } from '../lib/classify.js'
import { installBackgroundPass, recordInMemory, readProjectFacts } from '../lib/integration.js'
import { memoryTitle, parseMemory } from '../lib/memory.js'
import { outboundQuery, runResearch } from '../lib/providers.js'
import { vetPackage } from '../lib/vet.js'

const cases = []
/** Register one assertion group. */
const test = (name, fn) => cases.push([name, fn])
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Remove one temp directory, tolerating the Windows race where a just-closed
 * file handle keeps the directory busy for a beat. `force` alone does not
 * cover ENOTEMPTY, so a short bounded retry does.
 * @param {string} directory - the temp directory.
 * @returns {Promise<void>} resolves once the directory is gone (or irrecoverable).
 */
async function removeTemp(directory) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 4 || !/ENOTEMPTY|EPERM|EBUSY/u.test(String(error?.code ?? error))) throw error
      await sleep(50)
    }
  }
}

/** Stub the GitHub metadata endpoint so enrichment is deterministic. */
function stubFetch() {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { license: { spdx_id: 'MIT' }, archived: false, pushed_at: new Date().toISOString(), stargazers_count: 10 }
    },
    async text() { return '' },
  })
  return () => { globalThis.fetch = original }
}

/** A ctx whose `web.search` records every query it is asked. */
function recordingWeb(behaviour = {}) {
  const calls = []
  return {
    calls,
    ctx: {
      get(name) {
        if (name !== 'web') return undefined
        return {
          async search(request, signal) {
            calls.push(request.query)
            if (behaviour.hangAfter !== undefined && calls.length > behaviour.hangAfter) {
              if (behaviour.ignoresAbort === true) {
                // Never resolves, never observes the abort: the provider a
                // deadline cannot talk to.
                await new Promise(() => {
                  void signal
                })
              }
              // A provider that honours cancellation: the abort resolves it
              // with nothing, which is the "timeout but partial" shape.
              await new Promise((resolve) => {
                signal?.addEventListener('abort', () => resolve(), { once: true })
              })
              return { sources: [], truncated: false }
            }
            if (behaviour.delayMs !== undefined) await sleep(behaviour.delayMs)
            return {
              sources: [{ url: `https://github.com/example/ref-${calls.length}`, title: `Ref ${calls.length}`, snippet: `about ${request.query}` }],
              truncated: false,
            }
          },
        }
      },
    },
  }
}

// ── credentials never leave the process ──────────────────────────────────────

test('the sanitizer removes the credential shapes the report demonstrated', () => {
  const { text, redacted } = sanitizeForResearch([
    'deploy with AKIAIOSFODNN7EXAMPLE and AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'gitlab token glpat-AbCdEfGhIjKlMnOpQrSt and google key AIzaSyA1234567890abcdefghijklmnopqrstuv',
    'session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ].join('\n'))
  assert.doesNotMatch(text, /AKIAIOSFODNN7EXAMPLE/u)
  assert.doesNotMatch(text, /wJalrXUtnFEMI/u)
  assert.doesNotMatch(text, /glpat-/u)
  assert.doesNotMatch(text, /AIzaSy/u)
  assert.doesNotMatch(text, /eyJhbGciOiJIUzI1NiJ9/u)
  assert.ok(redacted.includes('secret'))
})

test('a high-entropy assignment value is stripped even without a known prefix', () => {
  const { text } = sanitizeForResearch('use service_key=Qf9t2xW7vBn4mK8sLp3zR6yH1jE5uI0oP4aS7dG2fH9kL3 for the api')
  assert.doesNotMatch(text, /Qf9t2xW7vBn4mK8sLp3zR6yH1jE5uI0oP4aS7dG2fH9kL3/u)
})

test('a private key block never survives sanitization', () => {
  const { text } = stripSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7v\n-----END RSA PRIVATE KEY-----\nuse it')
  assert.doesNotMatch(text, /BEGIN RSA PRIVATE KEY/u)
  assert.doesNotMatch(text, /MIIEpAIBAAKCAQEA7v/u)
})

test('ordinary words, versions and identifiers survive sanitization', () => {
  const { text } = sanitizeForResearch('upgrade to react 19.1 and vite 7, add internationalization, port module auth2fa to esm')
  assert.match(text, /react 19\.1/u)
  assert.match(text, /internationalization/u)
  assert.match(text, /auth2fa/u)
})

test('the provider outbound boundary strips secrets from the planned query', async () => {
  assert.equal(outboundQuery('deploy with AKIAIOSFODNN7EXAMPLE please'), 'deploy with please')
  const { calls, ctx } = recordingWeb()
  const restore = stubFetch()
  try {
    await runResearch(ctx, 'build a deployment tool using AKIAIOSFODNN7EXAMPLE', {
      angles: [{ id: 'reference', query: 'deployment tool AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }],
      keywords: ['deployment'], maxAngles: 1, progressive: false, enrich: 0,
    })
    assert.ok(calls.length > 0, 'the provider was called')
    for (const query of calls) {
      assert.doesNotMatch(query, /AKIAIOSFODNN7EXAMPLE/u, `secret reached the provider: ${query}`)
      assert.doesNotMatch(query, /wJalrXUtnFEMI/u, `secret reached the provider: ${query}`)
    }
  } finally {
    restore()
  }
})

// ── advisory lookups are tri-state ───────────────────────────────────────────

test('an OSV timeout reports an unknown vulnerability state, not a clean one', async () => {
  const verdict = await vetPackage('demo', {
    fetchImpl: async (url) => {
      if (String(url).includes('osv.dev')) { throw new Error('aborted') }
      return { ok: true, status: 200, async json() { return { name: 'demo', version: '1.2.3', license: 'MIT' } } }
    },
  })
  assert.equal(verdict.checked, true)
  assert.equal(verdict.advisoriesChecked, false)
  assert.equal(verdict.vulnerable, undefined)
  assert.equal(verdict.advisoryReason, 'timeout')
})

// ── the whole-run deadline is a hard boundary ────────────────────────────────

test('a provider that ignores the abort cannot hold the run past its deadline', async () => {
  const { ctx } = recordingWeb({ hangAfter: 0, ignoresAbort: true })
  const engine = createResearchEngine({
    ctx,
    config: { fallback: false, maxAngles: 1, deadlineMs: 250, timeoutMs: 5000, progressive: false },
    readProjectFacts: async () => ({ files: [], manifest: {} }),
  })
  const started = Date.now()
  const completed = await engine.research({ text: 'build an api', kind: 'feature', domain: 'web', level: 1, project: null })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 2000, `the run closed on time (${elapsed}ms)`)
  assert.equal(completed.status, 'timeout')
  assert.equal(engine.inflightCount, 0, 'the slot was released even though the provider is still hung')
  assert.equal(engine.hasCapacity, true)
})

test('a deadline-cut result with sources is partial and never cached', async () => {
  const web = recordingWeb({ hangAfter: 1 })
  const engine = createResearchEngine({
    ctx: web.ctx,
    // One angle at a time: the first angle returns, the second hangs, and the
    // deadline cuts a run that holds real sources but an unfinished plan.
    config: { fallback: false, maxAngles: 3, deadlineMs: 300, timeoutMs: 5000, progressive: false, concurrency: 1 },
    readProjectFacts: async () => ({ files: [], manifest: {} }),
  })
  const request = { text: 'build a REST API service with auth', kind: 'feature', domain: 'web', level: 2, project: null }
  const first = await engine.research(request)
  assert.equal(first.ok, true, 'the first angle did return sources')
  assert.equal(first.status, 'timeout')
  assert.equal(first.partial, true)
  assert.ok(first.sources.length > 0)
  assert.equal(engine.cache.stats().size, 0, 'a partial result is not cached as a complete one')
  const before = web.calls.length
  await engine.research({ ...request })
  assert.ok(web.calls.length > before, 'the repeat fetched again instead of reading a partial from cache')
})

test('a hanging project-facts read cannot hold the run hostage', async () => {
  const { ctx } = recordingWeb()
  const restore = stubFetch()
  try {
    const engine = createResearchEngine({
      ctx,
      config: { maxAngles: 1, deadlineMs: 300, timeoutMs: 5000 },
      readProjectFacts: () => new Promise(() => {}),
    })
    const started = Date.now()
    const completed = await engine.research({ text: 'build an api', kind: 'feature', domain: 'web', level: 1, project: '/tmp/anywhere' })
    assert.ok(Date.now() - started < 4000, 'the bounded facts read released the run')
    assert.equal(completed.ok, true)
  } finally {
    restore()
  }
})

test('facts the integration layer already read are used, not read again', async () => {
  const { ctx } = recordingWeb()
  const restore = stubFetch()
  let reads = 0
  try {
    const engine = createResearchEngine({
      ctx,
      config: { maxAngles: 1, deadlineMs: 3000 },
      readProjectFacts: async () => {
        reads += 1
        return { files: [], manifest: {} }
      },
    })
    await engine.research({ text: 'build an api', kind: 'feature', domain: 'web', level: 1, project: '/tmp/anywhere', facts: { files: [], manifest: {} } })
    assert.equal(reads, 0, 'the preloaded facts short-circuited the reader')
  } finally {
    restore()
  }
})

// ── budget-aware dedupe and cache ────────────────────────────────────────────

test('a stronger request does not share a weaker in-flight run', async () => {
  const web = recordingWeb({ delayMs: 30 })
  const restore = stubFetch()
  try {
    const engine = createResearchEngine({
      ctx: web.ctx,
      config: { maxAngles: 3, deadlineMs: 4000, maxInflight: 2, progressive: false },
      readProjectFacts: async () => ({ files: [], manifest: {} }),
    })
    const base = { text: 'build a REST API service with auth', kind: 'feature', domain: 'web', level: 2, project: null }
    const [weak, strong] = await Promise.all([
      engine.research({ ...base, maxAngles: 1 }),
      engine.research({ ...base, maxAngles: 3 }),
    ])
    assert.equal(weak.sharedWith, undefined, 'the runs have different budgets, so neither shared')
    assert.equal(strong.sharedWith, undefined)
  } finally {
    restore()
  }
})

test('a cached weak result is re-fetched for a request allowed more angles', async () => {
  const web = recordingWeb()
  const restore = stubFetch()
  try {
    const engine = createResearchEngine({
      ctx: web.ctx,
      config: { maxAngles: 3, deadlineMs: 4000, progressive: false },
      readProjectFacts: async () => ({ files: [], manifest: {} }),
    })
    const base = { text: 'build a REST API service with auth', kind: 'feature', domain: 'web', level: 2, project: null }
    await engine.research({ ...base, maxAngles: 1 })
    const before = web.calls.length
    await engine.research({ ...base, maxAngles: 3 })
    assert.ok(web.calls.length > before, 'the wider request fetched instead of reusing the narrow cache entry')
  } finally {
    restore()
  }
})

test('requirements that share their first 240 characters stay distinct', () => {
  const opening = '我需要你做一个模拟经营游戏，要有存档、交易、随机事件、NPC 好感度、多周目继承与成就系统，'
  assert.notEqual(researchKey(`${opening}美术走像素风`), researchKey(`${opening}美术走写实风`))
  assert.equal(researchKey(`${opening}美术走像素风`), researchKey(`${opening}  美术走像素风`))
})

// ── concurrent memory writes ─────────────────────────────────────────────────

test('concurrent research in one project preserves every memory entry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-req-search-hardening-'))
  try {
    const outcomes = await Promise.all(Array.from({ length: 12 }, (_, index) => recordInMemory(directory, {
      ok: true,
      domain: 'test',
      angles: [{ id: 'reference', sources: [{ url: `https://example.com/${index}`, title: `Reference ${index}` }] }],
    }, `distinct requirement ${index}`)))
    const body = await readFile(join(directory, '.dsh/req-search-memory.md'), 'utf8')
    assert.equal(parseMemory(body).length, 12, 'no write was lost to a read-merge-overwrite race')
    assert.ok(outcomes.every((outcome) => outcome === true))
    const left = await readdir(directory, { recursive: true })
    assert.ok(left.every((entry) => !entry.endsWith('.tmp')), 'no temp file was left behind')
  } finally {
    await removeTemp(directory)
  }
})

test('long requirements that open alike get distinct memory entries', () => {
  const opening = '我需要你做一个模拟经营游戏，要有存档、交易、随机事件、NPC 好感度、多周目继承与成就系统，'
  const first = memoryTitle(`${opening}美术走像素风，参考星露谷物语`)
  const second = memoryTitle(`${opening}美术走写实风，参考纪元1800`)
  assert.notEqual(first, second)
  assert.equal(memoryTitle(`${opening}美术走像素风，参考星露谷物语`), first, 'the same requirement keeps its entry replaceable')
  assert.equal(memoryTitle('short requirement'), 'short requirement')
})

// ── delivery is claimed only after it happened ───────────────────────────────

test('a late result for an idle agent is delivered, not marked injected, and retryable', async () => {
  let release
  let deferred
  let researchCount = 0
  const messages = []
  const marks = []
  const engine = {
    limits: {},
    hasCapacity: true,
    classify: () => ({ shouldResearch: true, sanitized: 'build an api', text: 'build an api', kind: 'feature', label: 'feature', domain: 'web', reasons: [], redacted: [] }),
    researchInto: () => {
      researchCount += 1
      return new Promise((resolve) => {
        release = () => resolve({ message: { role: 'user', content: [] }, run: { runId: 'late-run' } })
      })
    },
    registry: { mark: (...args) => marks.push(args) },
  }
  const listeners = []
  const ctx = { on: (_name, listener) => { listeners.push(listener); return () => {} }, get: () => undefined }
  installBackgroundPass(ctx, engine, { blockMs: 250, onDeferred: (promise) => { deferred = promise } })
  const agent = {
    status: 'idle',
    session: { id: 'idle-agent', header: {} },
    inject: (message) => messages.push(message),
    steer: (message) => messages.push(message),
  }
  const request = { role: 'user', content: [{ type: 'text', text: 'build an api' }] }
  const hook = (extra = {}) => listeners[0](
    { agent, messages: [request], signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [request] }),
    extra,
  )
  await hook()
  release()
  await deferred
  await sleep(10)
  assert.equal(messages.length, 1, 'the late result was actually delivered')
  assert.equal(marks.length, 0, 'an unconfirmed steer is never recorded as injected')
  await hook()
  assert.equal(researchCount, 2, 'an unconfirmed late delivery is retryable (from cache, not the network)')
})

// ── classification guards ────────────────────────────────────────────────────

test('a bare cancellation in the newest message wins over an older task', () => {
  const classified = classifyMessages([
    { role: 'user', content: [{ type: 'text', text: '我需要你做一个模拟经营游戏' }] },
    { role: 'user', content: [{ type: 'text', text: '取消' }] },
  ])
  assert.equal(classified.shouldResearch, false)
  assert.ok(classified.reasons.includes('cancel-intent'))
  // A message that cancels *and* states the next requirement is read normally.
  const replacement = classifyMessages([
    { role: 'user', content: [{ type: 'text', text: '我需要你做一个模拟经营游戏' }] },
    { role: 'user', content: [{ type: 'text', text: '取消刚才的，改成做一个塔防游戏' }] },
  ])
  assert.equal(replacement.shouldResearch, true)
})

test('a long message with a pasted log is a task, not documentation', () => {
  const log = Array.from({ length: 120 }, (_, index) => `2026-10-25T10:${String(index % 60).padStart(2, '0')}:11.123Z ERROR worker failed batch ${index}`).join('\n')
  const classified = classifyText(`修复导出功能，下面是日志：${log}导出的 CSV 少了表头，请修复`)
  assert.notEqual(classified.kind, 'docs')
})

test('translation wording wins over error vocabulary, but building a translator does not', () => {
  assert.equal(classifyText('把这段报错翻译成英文').kind, 'translation')
  assert.equal(classifyText('修复翻译功能报错').kind, 'bug')
  assert.equal(classifyText('写一个文档管理工具').kind, 'feature')
  assert.equal(classifyText('给项目补充 README 和使用文档').kind, 'docs')
})

// ── fragment variants stay attached to their angles ──────────────────────────

test('a fragment-only URL variant does not disappear from its angle', async () => {
  const calls = []
  const ctx = {
    get: (name) => name === 'web'
      ? {
          search: async ({ query }) => {
            calls.push(query)
            return { sources: [{ url: `https://example.com/reference#${calls.length}`, title: 'Reference' }] }
          },
        }
      : undefined,
  }
  const result = await runResearch(ctx, 'build an api', {
    angles: [{ id: 'one', query: 'one' }, { id: 'two', query: 'two' }],
    keywords: ['api'], maxAngles: 2, progressive: false, enrich: 0,
  })
  assert.equal(result.sources.length, 1, 'both fragments are one document')
  assert.equal(result.angles.find((angle) => angle.id === 'two').sources.length, 1)
  assert.deepEqual(result.angles.find((angle) => angle.id === 'two').sources[0].angles, ['one', 'two'])
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
