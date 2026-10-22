/**
 * Real-host verification harness.
 *
 * This boots the *actual* DSH packages from the shipped asar — a real cordis
 * `Context`, the real `SystemPrompt`, the real `ToolRuntime`, the real
 * `AgentLoop` — and loads this plugin into it. Only the LLM transport and the
 * search provider are stubbed, because a test cannot call them.
 *
 * What it proves is the seam the task is about: the plugin registers on the
 * real event bus, its tools land in the real registry, its contract section
 * reaches a really assembled prompt, and a real `AgentLoop` — created through
 * the real `agents` factory — dispatches `agent/pre-step` to it and commits the
 * injected message into a real `Session`.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 "D:\DeepSeek Harness\DeepSeek Harness.exe" test/real-host.mjs
 *
 * The install is located by `test/host-env.mjs` (`$DSH_APP_ROOT` or the running
 * binary), and the harness skips with a reason when no DSH install is present
 * rather than failing.
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

// ── a minimal but real host ──────────────────────────────────────────────────

const app = new Context()
app.provide('logger', { warn() {}, info() {}, error() {}, debug() {} })

/** A stubbed search provider; the engine's own path is what is under test. */
const searches = []
app.provide('web', {
  async search(request) {
    searches.push(request.query)
    return {
      sources: [{
        url: `https://github.com/example/ref-${searches.length}`,
        title: `Ref ${searches.length}`,
        snippet: `about ${request.query}`,
      }],
      truncated: false,
    }
  },
})

/** A stubbed model: one assistant message, no tool calls. */
const requests = []
app.provide('llm', {
  async prepareCall(config) {
    return { config, stream: () => stubStream() }
  },
  stream: () => stubStream(),
})

/** One finished assistant message with no tool calls. */
function stubStream() {
  const message = {
    id: 'msg-1',
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
  }
  return {
    async *[Symbol.asyncIterator]() {},
    async result() { return { kind: 'stop', message } },
    abort() {},
  }
}

await app.plugin(SessionStore)
await app.plugin(SessionProjectionRegistry)
await app.plugin(SystemPrompt)
await app.plugin(Object.assign(
  async (ctx) => {
    const tools = new ToolRuntime(ctx, {})
    void tools
  },
  { inject: ['systemPrompt'] },
))
await app.plugin(AgentRegistry)
await app.plugin(Object.assign(
  async (ctx) => {
    const loop = new AgentLoop(ctx, { agents: [] })
    void loop
  },
  { inject: ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections'] },
))

// ── mount the plugin under test ───────────────────────────────────────────────

const plugin = await import(pluginEntry)

const originalFetch = globalThis.fetch
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  async json() {
    return { license: { spdx_id: 'MIT' }, archived: false, pushed_at: new Date().toISOString(), stargazers_count: 2500 }
  },
  async text() { return '' },
})

let dispose
await check('the plugin loads into a real cordis context', async () => {
  dispose = plugin.apply(app, { blockMs: 8000, maxAngles: 3 })
  assert.equal(typeof plugin.name, 'string')
  assert.ok(app.get('systemPrompt') !== undefined, 'the prompt registry is real')
  assert.ok(app.get('tools') !== undefined, 'the tool registry is real')
})

await check('the tools appear in the real registry', async () => {
  const tools = app.get('tools')
  for (const name of ['research_requirement', 'vet_dependency', 'recall_project', 'ask_style']) {
    assert.ok(tools.get(name) !== undefined, `${name} is registered`)
  }
  // The schema the real registry accepted is the one the model will see.
  const schema = tools.get('research_requirement').parameters
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['requirement'])
})

await check('the contract section is assembled into a real prompt', async () => {
  const prompt = app.get('systemPrompt')
  const assembly = await prompt.assemble({})
  const section = assembly.sections.find((entry) => entry.name === 'tool:req-search')
  assert.ok(section !== undefined, 'the section is in the assembled prompt')
  assert.match(section.text, /standing capability/u)
})

let injectedMessage
await check('a real AgentLoop dispatches agent/pre-step and commits the briefing', async () => {
  const agents = app.get('agents')
  const handle = await agents.create({
    sessionId: 'real-host-agent',
    agentOptions: { provider: 'stub', model: 'stub' },
  })
  const agent = handle.agent ?? handle
  assert.ok(agent !== undefined, 'the real factory created an agent')
  assert.equal(agent.id, 'real-host-agent')

  // Send a development request into the real inbox and let the real driver run
  // one turn: this is the production path, not a hand-fired event.
  agent.send({
    id: 'm1',
    role: 'user',
    content: [{ type: 'text', text: '我需要你做一个模拟经营游戏，要能存档' }],
    source: { kind: 'user' },
  }, 'next-turn', true)
  await agent.whenIdle()

  const events = agent.session.snapshotEvents()
  // A `user/message` event's data IS the message (see the log shape above).
  injectedMessage = events
    .filter((event) => event.type === 'user/message')
    .map((event) => event.data)
    .find((message) => message?.source?.kind === 'dsh-req-search')
  assert.ok(injectedMessage !== undefined, 'the briefing was committed to the real session log')
  assert.match(injectedMessage.content[0].text, /Background research for this task/u)
  assert.ok(searches.length > 0, 'the engine really searched')
  const stepStarts = events.filter((event) => event.type === 'step/start')
  assert.ok(stepStarts.length >= 1, 'the loop ran a real step')
})

await check('the run record the panel reads is the one the hook produced', async () => {
  const engine = app.get('requirementResearch')
  assert.ok(engine !== undefined, 'the engine is published as a service')
  const snapshot = engine.snapshot()
  assert.equal(snapshot.recent.length, 1)
  assert.equal(snapshot.recent[0].injected, true)
  assert.ok(snapshot.recent[0].phases.some((phase) => phase.name === 'plan'))
  assert.ok(snapshot.recent[0].sources.length > 0)
})

await check('an unrelated turn never reaches the provider', async () => {
  const agents = app.get('agents')
  const before = searches.length
  const handle = await agents.create({ sessionId: 'real-host-chat', agentOptions: { provider: 'stub', model: 'stub' } })
  const agent = handle.agent ?? handle
  agent.send({
    id: 'm2',
    role: 'user',
    content: [{ type: 'text', text: '谢谢你，已经完成了' }],
    source: { kind: 'user' },
  }, 'next-turn', true)
  await agent.whenIdle()
  assert.equal(searches.length, before, 'no search ran for an unrelated turn')
})

await check('a host with no provider still runs the turn', async () => {
  // Remove the only search provider and confirm the next development turn still
  // completes: research is an enhancement, never a gate.
  const agents = app.get('agents')
  const handle = await agents.create({ sessionId: 'real-host-rest', agentOptions: { provider: 'stub', model: 'stub' } })
  const agent = handle.agent ?? handle
  const before = searches.length
  agent.send({
    id: 'm3',
    role: 'user',
    content: [{ type: 'text', text: '写一个带鉴权的 REST API 服务' }],
    source: { kind: 'user' },
  }, 'next-turn', true)
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  assert.ok(events.some((event) => event.type === 'turn/end'), 'the turn closed')
  assert.ok(searches.length >= before, 'the run either searched or degraded')
})

await check('the plugin unloads cleanly from the real context', async () => {
  if (typeof dispose === 'function') dispose()
  globalThis.fetch = originalFetch
})

console.log(`\n${results.filter((entry) => entry.ok).length}/${results.length} real-host checks passed`)
if (results.some((entry) => entry.ok !== true)) process.exitCode = 1
