/**
 * Association-plan tests: which domain a requirement lands in, what queries the
 * plan emits, and the caps that keep a plan searchable.
 */
import assert from 'node:assert/strict'
import { buildAssociationPlan, detectDomain, keywordPhrase } from '../lib/associate.js'
import { extractKeywords } from '../lib/search.js'

const cases = []
/** Register one assertion group. */
const test = (name, fn) => cases.push([name, fn])

test('a management-sim game lands in the game domain', () => {
  const requirement = '我需要你做一个模拟经营游戏'
  const keywords = extractKeywords(requirement)
  assert.equal(detectDomain(keywords), 'game')
  const plan = buildAssociationPlan(requirement, keywords)
  assert.equal(plan.domain, 'game')
  assert.equal(plan.language, 'zh')
  assert.deepEqual(plan.angles.map((angle) => angle.id), ['similar', 'reference', 'pitfalls', 'mechanics'])
  assert.match(plan.angles[0].query, /同类游戏/u)
  assert.match(plan.angles[1].query, /github/u)
  assert.match(plan.angles[2].query, /踩坑/u)
})

test('queries carry the requirement keywords, not the whole sentence', () => {
  const requirement = '我需要你做一个模拟经营游戏'
  const keywords = extractKeywords(requirement)
  const plan = buildAssociationPlan(requirement, keywords)
  for (const angle of plan.angles) {
    assert.ok(angle.query.includes(keywordPhrase(keywords)), angle.query)
    assert.ok(angle.query.length <= 96, angle.query)
    assert.ok(!angle.query.includes('{kw}'))
  }
})

test('a DSH plugin requirement lands in the plugin domain', () => {
  const requirement = '帮我写一个 DSH 插件，注册一个侧边栏面板'
  const keywords = extractKeywords(requirement)
  assert.equal(detectDomain(keywords), 'plugin')
  const plan = buildAssociationPlan(requirement, keywords)
  assert.equal(plan.domain, 'plugin')
  assert.match(plan.angles[0].query, /开源|类似/u)
})

test('a web requirement lands in the web domain', () => {
  const keywords = extractKeywords('做一个管理后台的网页界面')
  assert.equal(detectDomain(keywords), 'web')
})

test('an unclassifiable requirement falls back to the generic angles', () => {
  const keywords = extractKeywords('整理一下会议纪要')
  assert.equal(detectDomain(keywords), 'generic')
  const plan = buildAssociationPlan('整理一下会议纪要', keywords)
  assert.deepEqual(plan.angles.map((angle) => angle.id), ['similar', 'reference', 'pitfalls', 'mechanics'])
})

test('English requirements get English templates', () => {
  const requirement = 'I need a management simulation game with shops and staff'
  const keywords = extractKeywords(requirement)
  const plan = buildAssociationPlan(requirement, keywords)
  assert.equal(plan.language, 'en')
  assert.equal(plan.domain, 'game')
  assert.match(plan.angles[0].query, /games similar to/u)
  assert.equal(/[\u4e00-\u9fa5]/u.test(plan.angles[0].query), false)
})

test('an empty keyword list still produces a usable plan', () => {
  const plan = buildAssociationPlan('模拟经营', [], { maxAngles: 2 })
  assert.equal(plan.angles.length, 2)
  for (const angle of plan.angles) assert.ok(angle.query.trim().length > 0)
})

test('maxAngles caps the plan', () => {
  const keywords = extractKeywords('模拟经营游戏')
  for (const maxAngles of [1, 2, 5]) {
    assert.equal(buildAssociationPlan('模拟经营游戏', keywords, { maxAngles }).angles.length, Math.min(maxAngles, 5))
  }
})

test('keywordPhrase keeps the strongest few', () => {
  assert.equal(keywordPhrase(['a', 'b', 'c', 'd']), 'a b c')
  assert.equal(keywordPhrase(['a', 'b', 'c', 'd'], 2), 'a b')
  assert.equal(keywordPhrase([], 3), '')
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
