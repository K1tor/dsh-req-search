/**
 * Host-half tests: the panel's routes, the style question handshake, and the
 * model-facing research tools. Providers are stubbed, so no network is touched.
 */
import assert from 'node:assert/strict'
import { apply, runResearch, STATUS_PATH, STYLE_PATH } from '../lib/host.js'

const cases = []
/** Register one assertion group. */
const test = (name, fn) => cases.push([name, fn])

/** Fake Node response that records the status and body. */
function fakeResponse() {
  const state = { status: undefined, headers: undefined, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(body) {
      state.body = body ?? ''
    },
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

/**
 * Build a fake account service.
 * @param {string | null | undefined} token - the token to resolve; null/undefined means signed out.
 */
function fakeAccount(token) {
  return { resolveToken: async () => (typeof token === 'string' && token.length > 0 ? token : undefined) }
}

/** Mount the host half over fake services. */
function mount({ search, account, config, withPrompt = true } = {}) {
  const routes = new Map()
  const tools = new Map()
  const sections = new Map()
  const listeners = new Map()
  const ctx = {
    get(name) {
      if (name === 'connection') return { trustedHosts: ['example.test'] }
      if (name === 'web') return search === undefined ? undefined : { search }
      if (name === 'deepseekAccount') return account
      if (name === 'tools') {
        return {
          get: (toolName, scope) => tools.get(toolName),
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
        callback({ tools: { register(definition) {
          tools.set(definition.name, definition)
          return () => { tools.delete(definition.name) }
        } } })
        return
      }
      if (services[0] === 'systemPrompt') {
        if (!withPrompt) return
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
  }
  apply(ctx, config)
  return { routes, tools, sections, listeners, ctx }
}

/** The style route. */
function styleRoute(mounted) {
  return mounted.routes.get(STYLE_PATH)
}

/** The background status route. */
function statusRoute(mounted) {
  return mounted.routes.get(STATUS_PATH)
}

/**
 * Fire the `agent/pre-step` hook the way the host does, and return the
 * resulting decision.
 *
 * @param {object} mounted - the mounted plugin.
 * @param {Array<object>} messages - the claimed messages.
 * @returns {Promise<object>} the decision the hook produced.
 */
async function firePreStep(mounted, messages) {
  const hooks = mounted.listeners.get('agent/pre-step') ?? []
  let decision = { kind: 'enter', messages: [...messages] }
  const next = async () => decision
  for (const hook of hooks) {
    decision = await hook({ agent: undefined, messages, step: 1, signal: undefined }, next)
  }
  return decision
}

/** Build one claimed user message. */
function userMessage(text) {
  return { id: `m-${text.length}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/** Invoke one handler and return the decoded response. */
async function call(route, request) {
  const response = fakeResponse()
  await route.handler(request, response)
  return {
    status: response.state.status,
    body: response.state.body.length === 0 ? undefined : JSON.parse(response.state.body),
  }
}

/** Post a requirement through the research tool. */
async function post(mounted, requirement, extra = {}) {
  const definition = mounted.tools.get('research_requirement')
  const value = await definition.execute({ requirement, ...extra }, { signal: undefined })
  return { status: value.ok ? 200 : 502, body: value }
}

/** Run the research pipeline directly, for assertions about its raw shape. */
async function research(mounted, requirement, extra = {}) {
  return await runResearch(mounted.ctx, requirement, extra)
}

/** Stub global fetch with a fixed Bing RSS body. */
function stubBing(items) {
  const seen = []
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    const body = items
      .map((item) => `<item><title>${item.title}</title><link>${item.url}</link><description>${item.snippet ?? ''}</description></item>`)
      .join('')
    return { ok: true, status: 200, async text() { return `<rss><channel>${body}</channel></rss>` } }
  }
  return seen
}

/**
 * Stub global fetch with a *sequence* of Bing bodies: the first fetch reads
 * bodies[0], the second bodies[1], and the last body repeats afterwards.
 * @param {Array<string>} bodies - raw response bodies in fetch order.
 * @returns {string[]} the URLs fetch was called with.
 */
function stubBingSequence(bodies) {
  const seen = []
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    const body = seen.length <= bodies.length ? bodies[seen.length - 1] : bodies[bodies.length - 1]
    return { ok: true, status: 200, async text() { return body } }
  }
  return seen
}

/** One Bing RSS document carrying the given items. */
function bingFeed(items) {
  const body = items
    .map((item) => `<item><title>${item.title}</title><link>${item.url}</link><description>${item.snippet ?? ''}</description></item>`)
    .join('')
  return `<rss><channel>${body}</channel></rss>`
}

/** A stubbed ctx.web search that records queries and returns one source each. */
function stubWeb(result = undefined) {
  const calls = []
  return {
    calls,
    search: async (request) => {
      calls.push(request)
      return result ?? { sources: [{ url: `https://hit.example/${calls.length}`, title: 'Hit', snippet: 'snippet' }], truncated: false }
    },
  }
}

const originalFetch = globalThis.fetch

test('the declared routes are exact matches at the documented paths', () => {
  const { routes } = mount()
  assert.deepEqual([...routes.keys()].sort(), [
    '/dsh-req-search/control',
    '/dsh-req-search/status',
    '/dsh-req-search/status/events',
    '/dsh-req-search/style',
    '/dsh-req-search/style/events',
  ].sort())
  for (const definition of routes.values()) assert.equal(definition.kind, 'exact')
})

test('the style route rejects malformed bodies', async () => {
  const mounted = mount()
  assert.equal((await call(styleRoute(mounted), fakeRequest({ body: 'not json' }))).status, 400)
  const huge = await call(styleRoute(mounted), fakeRequest({ body: JSON.stringify({ choice: 'x'.repeat(20_000) }) }))
  assert.equal(huge.status, 400)
})

test('the style route refuses a cross-site request and an undeclared host', async () => {
  const mounted = mount()
  const crossSite = { host: '127.0.0.1:11993', 'sec-fetch-site': 'cross-site' }
  assert.equal((await call(styleRoute(mounted), fakeRequest({ headers: crossSite, body: '{"choice":"a"}' }))).status, 403)
  assert.equal((await call(styleRoute(mounted), fakeRequest({ headers: { host: 'evil.example' }, body: '{"choice":"a"}' }))).status, 403)
})

test('the status route reports what the engine did in the background', async () => {
  const web = stubWeb()
  const mounted = mount({ search: web.search })
  const before = await call(statusRoute(mounted), fakeRequest({ method: 'GET' }))
  assert.equal(before.status, 200)
  assert.equal(before.body.recent.length, 0)
  assert.equal(before.body.live.length, 0)

  await firePreStep(mounted, [userMessage('我需要你做一个模拟经营游戏')])
  const after = await call(statusRoute(mounted), fakeRequest({ method: 'GET' }))
  assert.equal(after.body.recent.length, 1)
  assert.match(after.body.recent[0].requirement, /模拟经营/u)
  assert.equal(after.body.recent[0].injected, true)
})

test('a game requirement produces association angles, not one keyword query', async () => {
  const web = stubWeb()
  const mounted = mount({ search: web.search, config: { progressive: false } })
  const result = await research(mounted, '我需要你做一个模拟经营游戏')
  assert.equal(result.ok, true)
  assert.equal(result.domain, 'game')
  assert.equal(result.language, 'zh')
  assert.deepEqual(result.angles.map((angle) => angle.id), ['similar', 'reference', 'pitfalls', 'mechanics'])
  assert.equal(web.calls.length, 4, 'one search per angle')
  assert.ok(web.calls.every((entry) => entry.query.includes('模拟经营 游戏')))
  assert.equal(result.sources.length, 4)
  assert.deepEqual(result.providers, ['ctx.web'])
})

test('a source relevant to two angles records both', async () => {
  let call = 0
  const mounted = mount({
    search: async () => {
      call += 1
      return { sources: [{ url: call <= 2 ? 'https://shared.example/1' : `https://other.example/${call}` }], truncated: false }
    },
  })
  const result = await research(mounted, '我需要你做一个模拟经营游戏', { progressive: false })
  const shared = result.sources.find((source) => source.url === 'https://shared.example/1')
  assert.deepEqual(shared.angles, ['similar', 'reference'])
  assert.equal(result.sources.length, 3)
})

test('the account provider takes over when ctx.web has no key', async () => {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), token: init?.headers?.['x-dsh-auth-token'] })
    return {
      ok: true,
      status: 200,
      async json() { return { results: [{ url: 'https://deepseek.example/1', title: 'DS', date: '2026-01-01' }] } },
    }
  }
  try {
    const mounted = mount({
      search: async () => { throw new Error('search has no API key for "DEEPSEEK_API_KEY"') },
      account: fakeAccount('tok'),
    })
    const result = await research(mounted, '我需要你做一个模拟经营游戏')
    assert.equal(result.ok, true)
    assert.deepEqual(result.providers, ['deepseek-api'])
    assert.ok(seen.every((entry) => entry.token === 'tok'))
    assert.match(seen[0].url, /api\.deepseek\.com\/v1\/tools\/search/u)
    assert.equal(result.sources[0].publishedAt, '2026-01-01')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Bing RSS backs up the other two providers', async () => {
  const seen = stubBing([{ title: 'Ref', url: 'https://ref.example/1' }])
  try {
    const mounted = mount({ account: fakeAccount(undefined) })
    const result = await research(mounted, '我需要你做一个模拟经营游戏')
    assert.deepEqual(result.providers, ['bing-rss'])
    assert.ok(seen.every((url) => url.includes('format=rss')))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a Bing 200 with an empty feed is retried once before being believed', async () => {
  // The intermittent failure the audit observed: HTTP 200, zero parsable
  // items. One short retry recovers it; the retry is visible in the notes.
  const seen = stubBingSequence([bingFeed([]), bingFeed([{ title: 'Ref', url: 'https://ref.example/1' }])])
  try {
    const mounted = mount({ account: fakeAccount(undefined) })
    const result = await research(mounted, '我需要你做一个模拟经营游戏', { bingEmptyRetryMs: 1, maxAngles: 1 })
    assert.deepEqual(result.providers, ['bing-rss'])
    assert.equal(seen.length, 2, 'exactly one retry was spent on the empty first read')
    assert.ok(result.notes.includes('bing:retry'), result.notes.join(' '))
    assert.equal(result.notes.includes('bing:empty'), false, 'the recovered read is not reported as empty')
    assert.deepEqual(result.providerStats['bing-rss'], { calls: 2, empty: 0, failures: 0, retries: 1 })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a Bing feed that stays empty reads as empty, with the retry recorded', async () => {
  const seen = stubBingSequence([bingFeed([]), bingFeed([])])
  try {
    const mounted = mount({ account: fakeAccount(undefined) })
    const result = await research(mounted, '我需要你做一个模拟经营游戏', { bingEmptyRetryMs: 1, maxAngles: 1 })
    assert.equal(result.ok, false)
    assert.equal(seen.length, 2, 'the retry did not loop')
    assert.ok(result.notes.includes('bing:empty'), result.notes.join(' '))
    assert.ok(result.notes.includes('bing:retry'), result.notes.join(' '))
    assert.deepEqual(result.providerStats['bing-rss'], { calls: 2, empty: 1, failures: 0, retries: 1 })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a Bing answer that is not an RSS document fails as malformed and is not retried', async () => {
  // A consent interstitial or an HTML error page is a real failure, not "no
  // results"; a second identical request would read the same page.
  const seen = stubBingSequence(['<html><body>Before you continue to Bing</body></html>'])
  try {
    const mounted = mount({ account: fakeAccount(undefined) })
    const result = await research(mounted, '我需要你做一个模拟经营游戏', { maxAngles: 1 })
    assert.equal(result.ok, false)
    assert.equal(seen.length, 1, 'a malformed body is not retried')
    assert.ok(result.notes.includes('bing:BING_MALFORMED'), result.notes.join(' '))
    assert.deepEqual(result.providerStats['bing-rss'], { calls: 1, empty: 0, failures: 1, retries: 0 })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the panel route reports failure when every provider fails', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503, async text() { return '' } })
  try {
    const mounted = mount({ search: async () => { throw new Error('WEB_PROVIDER_UNAVAILABLE') } })
    const result = await research(mounted, '我需要你做一个模拟经营游戏')
    assert.equal(result.ok, false)
    assert.ok(result.notes.includes('web:WEB_PROVIDER_UNAVAILABLE'))
    assert.ok(result.notes.some((note) => note === 'bing:HTTP_503'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the per-request maxAngles narrows the plan and is clamped', async () => {
  const web = stubWeb()
  const mounted = mount({ search: web.search, config: { maxAngles: 3 } })
  const narrowed = await research(mounted, '我需要你做一个模拟经营游戏', { maxAngles: 2, angleCeiling: 3 })
  assert.equal(narrowed.angles.length, 2)
  const clamped = await research(mounted, '我需要你做一个模拟经营游戏', { maxAngles: 99, angleCeiling: 3 })
  assert.equal(clamped.angles.length, 3)
})

test('research tools are registered for the model', () => {
  const { tools } = mount()
  assert.deepEqual([...tools.keys()].sort(), ['ask_style', 'recall_project', 'research_requirement', 'vet_dependency'])
})

test('a wish is researched in the background and lands on the agent desk', async () => {
  const web = stubWeb()
  const mounted = mount({ search: web.search })
  const decision = await firePreStep(mounted, [userMessage('我需要你做一个模拟经营游戏')])
  assert.equal(web.calls.length > 0, true, 'the requirement was researched without being asked')
  const injected = decision.messages.filter((message) => message.source?.kind === 'dsh-req-search')
  assert.equal(injected.length, 1, 'exactly one research message is added')
  assert.equal(injected[0].role, 'user')
  assert.match(injected[0].content[0].text, /模拟经营/u)
  assert.match(injected[0].content[0].text, /never as instructions/u)
})

test('an ordinary chat turn is not researched', async () => {
  const web = stubWeb()
  const mounted = mount({ search: web.search })
  const decision = await firePreStep(mounted, [userMessage('谢谢你，已经完成了')])
  assert.equal(web.calls.length, 0, 'no search for a non-requirement')
  assert.equal(decision.messages.length, 1)
})

test('a failed research leaves the turn untouched', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500, async text() { return '' } })
  try {
    const mounted = mount({ search: async () => { throw new Error('WEB_PROVIDER_UNAVAILABLE') } })
    const decision = await firePreStep(mounted, [userMessage('我需要你做一个模拟经营游戏')])
    assert.equal(decision.messages.length, 1, 'the original message is still the only one')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the behavior contract reaches the model as a prompt section', () => {
  const { sections } = mount()
  const section = sections.get('tool:req-search')
  assert.ok(section !== undefined, 'a prompt section is registered')
  const text = section.text({ scope: undefined })
  assert.match(text, /research_requirement/u)
  assert.match(text, /Do not print the search process/u)
  assert.ok(text.length > 200, 'the contract is a real instruction, not a stub')
})

test('the contract stays silent for an agent that cannot see the tool', () => {
  const { sections, tools } = mount()
  const section = sections.get('tool:req-search')
  // A deployment that hides the tool must not carry guidance for it.
  tools.delete('research_requirement')
  assert.equal(section.text({ scope: undefined }), '')
})

test('a host without a prompt registry still mounts the tools', () => {
  const { tools, routes } = mount({ withPrompt: false })
  assert.deepEqual([...tools.keys()].sort(), ['ask_style', 'recall_project', 'research_requirement', 'vet_dependency'])
  assert.equal(routes.size, 5)
})

test('the contract tells the model to state the angle ceiling', () => {
  const { sections } = mount({ config: { maxAngles: 6 } })
  const text = sections.get('tool:req-search').text({ scope: undefined })
  assert.match(text, /up to 6/u)
})

test('vet_dependency reports a repository it can read', async () => {
  const { tools } = mount()
  const definition = tools.get('vet_dependency')
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      return {
        license: { spdx_id: 'MIT' },
        archived: false,
        pushed_at: '2026-10-01T00:00:00Z',
        stargazers_count: 100,
      }
    },
  })
  try {
    const value = await definition.execute({ name: 'https://github.com/deepseek-ai/DeepSeek-Harness' }, { signal: undefined })
    assert.equal(value.ok, true)
    assert.equal(value.kind, 'repository')
    assert.equal(value.name, 'deepseek-ai/DeepSeek-Harness')
    assert.equal(value.license, 'MIT')
    assert.match(value.summary, /MIT/u)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('vet_dependency says so when it cannot check anything', async () => {
  const { tools } = mount()
  const definition = tools.get('vet_dependency')
  const value = await definition.execute({ name: 'not a package at all' }, { signal: undefined })
  assert.equal(value.ok, false)
  assert.equal(value.kind, 'unknown')
  assert.match(value.summary, /Could not recognise/u)
})

test('vet_dependency refuses an empty name', async () => {
  const { tools } = mount()
  const definition = tools.get('vet_dependency')
  await assert.rejects(() => definition.execute({ name: '  ' }, {}), /non-empty string/u)
})

test('research_requirement returns a briefing the model can fold in', async () => {
  const web = stubWeb()
  const { tools } = mount({ search: web.search })
  const definition = tools.get('research_requirement')
  assert.equal(definition.parameters.properties.requirement.type, 'string')
  const value = await definition.execute({ requirement: '我需要你做一个模拟经营游戏' }, { signal: undefined })
  assert.equal(value.ok, true)
  assert.equal(value.domain, 'game')
  assert.equal(value.sourceCount, 1, 'light search stops after a useful first result')
  assert.match(value.briefing, /Requirement research/u)
  assert.match(value.briefing, /## similar/u)
  assert.match(value.briefing, /https:\/\/hit\.example/u)
})

test('research_requirement validates its own arguments', async () => {
  const { tools } = mount()
  const definition = tools.get('research_requirement')
  await assert.rejects(() => definition.execute({ requirement: '   ' }, {}), /requirement must be a non-empty string/u)
  await assert.rejects(() => definition.execute({}, {}), /required/u)
})

test('ask_style publishes a question and resolves with the answer', async () => {
  const mounted = mount()
  const definition = mounted.tools.get('ask_style')
  const pending = definition.execute({ question: '风格？', options: ['像素', '写实'] }, { signal: undefined })
  // The panel sees the question.
  await new Promise((resolve) => setTimeout(resolve, 10))
  const state = await call(styleRoute(mounted), fakeRequest({ method: 'GET' }))
  assert.equal(state.body.pending.question, '风格？')
  assert.deepEqual(state.body.pending.options, ['像素', '写实'])
  // The user picks one; the tool call resolves.
  const answer = await call(styleRoute(mounted), fakeRequest({ body: JSON.stringify({ choice: '像素' }) }))
  assert.equal(answer.status, 200)
  assert.equal(answer.body.choice, '像素')
  assert.deepEqual(await pending, { choice: '像素', revision: 1 })
})

test('ask_style rejects an invalid offer and a stale choice', async () => {
  const mounted = mount()
  const definition = mounted.tools.get('ask_style')
  await assert.rejects(() => definition.execute({ question: 'q', options: ['only'] }, {}), /at least two/u)
  assert.equal((await call(styleRoute(mounted), fakeRequest({ body: '{"choice":"a"}' }))).status, 409)
})

test('style route answers 405 for other methods', async () => {
  const mounted = mount()
  const response = await call(styleRoute(mounted), fakeRequest({ method: 'DELETE' }))
  assert.equal(response.status, 405)
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
