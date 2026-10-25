import assert from 'node:assert/strict'
import { allocateSearchBudget, decideSearchLevel, evaluateRetrievalProgress } from '../lib/budget.js'
import { createResearchEngine } from '../lib/engine.js'
import { formatBriefing } from '../lib/providers.js'
import { buildResearchMessage } from '../lib/background.js'
import { buildPlan } from '../lib/strategy.js'

const cases = []
const test = (name, fn) => cases.push([name, fn])
const facts = { existingProject: false, stack: [] }
const eligible = (text, kind = 'feature') => ({ text, kind, shouldResearch: true, reasons: [] })

test('level 0 suppresses search; common development starts light', () => {
  assert.equal(decideSearchLevel({ text: '解释 map 的语法', kind: 'question', shouldResearch: false }, facts).level, 0)
  const level = decideSearchLevel(eligible('给 CLI 增加 JSON 导出功能'), facts)
  assert.equal(level.level, 1)
  assert.equal(level.name, 'light')
})

test('complexity, current-version requirements and deep research escalate', () => {
  assert.equal(decideSearchLevel(eligible('排查 React 升级后的兼容性错误并修复', 'bug'), facts).level, 2)
  assert.equal(decideSearchLevel(eligible('重构多模块鉴权架构，比较安全取舍', 'architecture'), facts).level, 3)
  assert.equal(decideSearchLevel(eligible('请全面深度调研此架构', 'architecture'), facts).level, 3)
})

test('current-version plans put official documentation before repositories', () => {
  const decision = decideSearchLevel(eligible('检查 DSH 当前版本的插件迁移指南', 'dependency'), facts)
  assert.equal(decision.level, 2)
  assert.ok(decision.reasons.includes('current-official-facts-required'))
  const plan = buildPlan({ kind: 'dependency', domain: 'plugin', keywords: ['dsh', 'plugin'] }, { maxAngles: 4, officialFirst: true })
  assert.equal(plan.angles[0].id, 'official')
})

test('budgets are observable, bounded and leave lower search ceilings intact', () => {
  const light = allocateSearchBudget(1, { maxAngles: 6, contextChars: 20000, maxSearchCalls: 20, deadlineMs: 45000 })
  assert.equal(light.maxAngles, 2)
  assert.equal(light.initialAngles, 1)
  assert.equal(light.contextChars, 6000)
  assert.equal(light.deadlineMs, 18000)
  const deep = allocateSearchBudget(3, { maxAngles: 2, contextChars: 4000, maxSearchCalls: 1, deadlineMs: 45000 })
  assert.equal(deep.maxAngles, 2)
  assert.equal(deep.contextChars, 4000)
  assert.equal(deep.maxSearchCalls, 1)
  assert.equal(allocateSearchBudget(3, { maxLevel: 0 }).level, 3, 'level is resolved before allocation')
})

test('duplicate results stop instead of consuming more calls', () => {
  const old = new Set(['https://example.com/known'])
  const batch = [{ provider: 'ctx.web', notes: [], sources: [{ url: 'https://example.com/known' }] }]
  assert.equal(evaluateRetrievalProgress(batch, old).stop, true)
  assert.equal(evaluateRetrievalProgress(batch, old).reason, 'no-new-sources')
})

test('a light task does not search every allowed angle', async () => {
  let calls = 0
  const ctx = { get: (name) => name === 'web' ? { async search() {
    calls += 1
    return { sources: [{ url: `https://docs.example/${calls}`, title: 'API docs' }] }
  } } : undefined }
  const engine = createResearchEngine({ ctx, config: { maxAngles: 4 }, readProjectFacts: async () => ({ files: [], manifest: {} }) })
  const run = await engine.research({ text: '给 CLI 增加 JSON 导出功能', kind: 'feature', domain: 'automation', level: 1 })
  assert.equal(calls, 1)
  assert.equal(run.stopped, 'sufficient-for-light-search')
  assert.equal(run.unsearchedAngles.length, 1)
  assert.equal(run.usage.characterBudgetKind, 'observable-not-token-count')
  assert.equal(run.budget.maxSearchCalls > 0, true)
})

test('different tasks and in-flight budget counters do not share state', async () => {
  const active = new Map()
  const ctx = { get: (name) => name === 'web' ? { async search(request) {
    active.set(request.query, (active.get(request.query) ?? 0) + 1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    return { sources: [{ url: `https://docs.example/${request.query}`, title: request.query }] }
  } } : undefined }
  const engine = createResearchEngine({ ctx, config: { maxAngles: 3 }, readProjectFacts: async () => ({ files: [], manifest: {} }) })
  const [left, right] = await Promise.all([
    engine.research({ text: '修复 Web 兼容性错误', kind: 'bug', domain: 'web', level: 2 }),
    engine.research({ text: '优化数据库性能瓶颈', kind: 'performance', domain: 'data', level: 2 }),
  ])
  assert.equal(left.usage.searchCalls, 3)
  assert.equal(right.usage.searchCalls, 3)
  assert.notDeepEqual(left.angles.map((angle) => angle.query), right.angles.map((angle) => angle.query))
})

test('non-progressive mode retains the original all-angle behaviour', async () => {
  let calls = 0
  const ctx = { get: (name) => name === 'web' ? { async search() {
    calls += 1
    return { sources: [{ url: `https://docs.example/${calls}`, title: 'Docs' }] }
  } } : undefined }
  const engine = createResearchEngine({ ctx, config: { maxAngles: 3, progressive: false }, readProjectFacts: async () => ({ files: [], manifest: {} }) })
  const run = await engine.research({ text: '给 CLI 增加 JSON 导出功能', kind: 'feature', domain: 'automation', level: 1 })
  assert.equal(calls, 2)
  assert.equal(run.searchCalls, 2)
})

test('injected messages and briefings obey real character ceilings', () => {
  const angle = { id: 'official', provider: 'ctx.web', sources: Array.from({ length: 3 }, (_, index) => ({
    url: `https://example.com/${index}`, title: `Result ${index}`, snippet: 'x'.repeat(2000),
  })) }
  const briefing = formatBriefing({ domain: 'plugin', keywords: ['dsh'], providers: [], notes: [], angles: [angle] }, { contextChars: 1000, snippetChars: 120 })
  assert.ok(briefing.length <= 1000)
  assert.match(briefing, /truncated/u)
  const message = buildResearchMessage({ runId: 'r', level: 1, contextChars: 1000, maxSourceChars: 120, conclusions: [], angles: [angle] }, '需求')
  assert.ok(message.content[0].text.length <= 1000)
  assert.match(message.content[0].text, /untrusted|unverified|truncated/u)
})

let failed = 0
for (const [name, run] of cases) {
  try {
    await run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}\n     ${error.stack}`)
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`)
if (failed > 0) process.exitCode = 1
