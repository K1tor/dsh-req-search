/**
 * Subagent verification on the real DSH host.
 *
 * This is the part of acceptance test D that a fake context cannot prove: a
 * child agent created through the real `agents.create()` — with the real
 * `Session` header carrying `parentSession`/`origin`/`delegationDepth` — must
 * receive the research context and must not repeat the parent's search.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 "D:\DeepSeek Harness\DeepSeek Harness.exe" test/real-subagent.mjs
 *
 * The install is located by `test/host-env.mjs`; the harness skips with a
 * reason when no DSH install is present rather than failing.
 */
import assert from 'node:assert/strict'

import { hostEnvironment, skip } from './host-env.mjs'

const host = await hostEnvironment()
if (host === undefined) skip('no installed DeepSeek Harness found (set DSH_APP_ROOT to its root directory)')
const { load, pluginEntry } = host

const { Context } = await load('cordis/lib/index.js')
const { SystemPrompt } = await load('dsh-system-prompt/lib/index.js')
const { default: ToolRuntime } = await load('dsh-tools/lib/index.js')
const { default: AgentRegistry } = await load('dsh-agent/lib/index.js')
const { AgentLoop } = await load('dsh-agent-loop/lib/index.js')
const { default: SessionStore } = await load('dsh-session/lib/index.js')
const { default: SessionProjectionRegistry } = await load('dsh-session-projection/lib/index.js')

const results = []
/**
 * Record one check.
 * @param {string} name - the check.
 * @param {() => Promise<void> | void} body - the assertions.
 */
async function check(name, body) {
  try {
    await body()
    results.push({ name, ok: true })
    console.log(`ok   ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.log(`FAIL ${name}\n     ${error.stack?.split('\n').slice(0, 3).join('\n     ') ?? error.message}`)
  }
}

const app = new Context()
app.provide('logger', { warn() {}, info() {}, error() {}, debug() {} })

/** Every query the engine actually sent. */
const searches = []
app.provide('web', {
  async search(request) {
    searches.push(request.query)
    return {
      sources: [{ url: `https://github.com/example/ref-${searches.length}`, title: `Ref ${searches.length}` }],
      truncated: false,
    }
  },
})

function stubStream() {
  const message = { id: 'msg', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }
  return { async *[Symbol.asyncIterator]() {}, async result() { return { kind: 'stop', message } }, abort() {} }
}
app.provide('llm', {
  async prepareCall(config) { return { config, stream: () => stubStream() } },
  stream: () => stubStream(),
})

await app.plugin(SessionStore)
await app.plugin(SessionProjectionRegistry)
await app.plugin(SystemPrompt)
await app.plugin(Object.assign(async (ctx) => { new ToolRuntime(ctx, {}) }, { inject: ['systemPrompt'] }))
await app.plugin(AgentRegistry)
await app.plugin(Object.assign(
  async (ctx) => { new AgentLoop(ctx, { agents: [] }) },
  { inject: ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections'] },
))

const originalFetch = globalThis.fetch
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  async json() {
    return { license: { spdx_id: 'MIT' }, archived: false, pushed_at: new Date().toISOString(), stargazers_count: 900 }
  },
  async text() { return '' },
})

const plugin = await import(pluginEntry)
plugin.apply(app, { blockMs: 8000, maxAngles: 2, maxInflight: 3 })

const agents = app.get('agents')
const ENGINE = app.get('requirementResearch')
const PROMPT = '写一个带鉴权的 REST API 服务'

/**
 * Send one user message to a real agent and wait for the turn to close.
 * @param {object} agent - the live agent.
 * @param {string} id - the message id.
 * @param {string} text - the message text.
 */
async function turn(agent, id, text) {
  agent.send({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, 'next-turn', true)
  await agent.whenIdle()
}

/**
 * Read the briefings a real session actually committed.
 * @param {object} agent - the live agent.
 * @returns {object[]} the injected messages.
 */
function briefings(agent) {
  return agent.session.snapshotEvents()
    .filter((event) => event.type === 'user/message')
    .map((event) => event.data)
    .filter((message) => message?.source?.kind === 'dsh-req-search')
}

await check('the parent turn is researched and committed', async () => {
  const handle = await agents.create({ sessionId: 'parent', agentOptions: { provider: 'stub', model: 'stub' } })
  const parent = handle.agent ?? handle
  await turn(parent, 'p1', PROMPT)
  assert.equal(briefings(parent).length, 1)
  assert.ok(searches.length > 0)
})

await check('a child agent created with parent lineage gets the same context without a second search', async () => {
  const before = searches.length
  const handle = await agents.create({
    sessionId: 'child',
    meta: { parentSession: 'parent', origin: 'subagent', delegationDepth: 1 },
    agentOptions: { provider: 'stub', model: 'stub' },
  })
  const child = handle.agent ?? handle
  assert.equal(child.session.header.parentSession, 'parent')
  assert.equal(child.session.header.origin, 'subagent')
  assert.equal(child.session.header.delegationDepth, 1)

  await turn(child, 'c1', PROMPT)
  assert.equal(briefings(child).length, 1, 'the child received the briefing')
  assert.equal(searches.length, before, 'the child reused the parent research instead of searching again')

  const run = ENGINE.snapshot().recent.find((entry) => entry.agentId === 'child')
  assert.ok(run !== undefined, 'the child delivery has its own record')
  assert.equal(run.origin, 'subagent')
  assert.equal(run.parentId, 'parent')
  assert.equal(run.cached, true)
  assert.equal(run.injected, true)
})

await check('an unrelated child turn is not researched', async () => {
  const before = searches.length
  const handle = await agents.create({
    sessionId: 'child-chat',
    meta: { parentSession: 'parent', origin: 'subagent', delegationDepth: 1 },
    agentOptions: { provider: 'stub', model: 'stub' },
  })
  const child = handle.agent ?? handle
  await turn(child, 'c2', '谢谢你，已经完成了')
  assert.equal(searches.length, before)
  assert.equal(briefings(child).length, 0)
})

await check('two sibling agents researching at once share one retrieval', async () => {
  const before = ENGINE.snapshot().recent.length
  const [leftHandle, rightHandle] = await Promise.all([
    agents.create({ sessionId: 'sib-a', agentOptions: { provider: 'stub', model: 'stub' } }),
    agents.create({ sessionId: 'sib-b', agentOptions: { provider: 'stub', model: 'stub' } }),
  ])
  const left = leftHandle.agent ?? leftHandle
  const right = rightHandle.agent ?? rightHandle
  await Promise.all([
    turn(left, 'a1', '给这个项目加一个导出功能，支持 CSV 和 Excel'),
    turn(right, 'b1', '给这个项目加一个导出功能，支持 CSV 和 Excel'),
  ])
  assert.equal(briefings(left).length, 1)
  assert.equal(briefings(right).length, 1)
  const runs = ENGINE.snapshot().recent.slice(0, ENGINE.snapshot().recent.length - before)
  assert.equal(runs.length, 2, 'both deliveries are recorded')
  assert.ok(
    runs.some((run) => run.duplicateOf !== undefined || run.cached === true),
    'one of them is marked as shared/cached',
  )
})

await check('the panel snapshot exposes exactly what these real turns produced', async () => {
  const snapshot = ENGINE.snapshot()
  assert.ok(snapshot.recent.length >= 4)
  for (const run of snapshot.recent) {
    assert.equal(typeof run.startedAt, 'number')
    assert.equal(typeof run.finishedAt, 'number')
    assert.ok(run.phases.length > 0, `${run.id} has phases`)
    assert.ok(run.plan.angles.length > 0, `${run.id} has a plan`)
  }
  const injected = snapshot.recent.filter((run) => run.injected === true)
  assert.ok(injected.length >= 2, 'injected runs are marked as such')
})

globalThis.fetch = originalFetch
console.log(`\n${results.filter((entry) => entry.ok).length}/${results.length} real-subagent checks passed`)
if (results.some((entry) => entry.ok !== true)) process.exitCode = 1
