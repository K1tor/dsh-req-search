/**
 * Tests for source quality: relevance scoring, filtering and the
 * "the provider ignored the query" detection.
 *
 * These are the rules that keep a low-quality keyless provider from filling the
 * agent's context with dictionary entries and download portals — the failure
 * that only showed up in a real headless run.
 */
import assert from 'node:assert/strict'

import {
  anglesUndifferentiated,
  filterSources,
  formatBriefing,
  scoreSource,
} from '../lib/providers.js'

const cases = []
/** Register one assertion group. */
const test = (name, fn) => cases.push([name, fn])

/** One search hit. */
function source(url, title, angles = ['similar']) {
  return { url, title, angles }
}

test('a source is scored by how much of the requirement it shares', () => {
  const keywords = ['模拟经营', 'game', '存档']
  assert.deepEqual(scoreSource(source('https://a.example/1', '模拟经营游戏存档设计'), keywords).matched, ['模拟经营', '存档'])
  assert.deepEqual(scoreSource(source('https://a.example/2', 'cooking recipes'), keywords).matched, [])
  // A keyword in the URL counts: a repository path often names its subject.
  assert.deepEqual(scoreSource(source('https://github.com/x/game-engine', 'Engine'), keywords).matched, ['game'])
})

test('a dictionary host is off-topic whatever its title says', () => {
  const filtered = filterSources(
    [
      source('https://baike.baidu.com/item/模拟', '模拟_百度百科'),
      source('https://github.com/example/sim', 'sim game engine'),
      source('https://hgcha.com/zidian/1', '带 的拼音'),
    ],
    { keywords: ['模拟', 'game'] },
  )
  assert.deepEqual(filtered.kept.map((entry) => entry.url), ['https://github.com/example/sim'])
  assert.equal(filtered.dropped.length, 2)
  assert.ok(filtered.dropped.every((entry) => entry.reason === 'off-topic-source'))
})

test('a weak but real reference survives when the angles are differentiated', () => {
  // A title rarely repeats the requirement verbatim; dropping everything that
  // does not is worse than carrying one weak lead.
  const filtered = filterSources(
    [source('https://blog.example/1', 'How we built our shop system')],
    { keywords: ['模拟经营', 'game'], undifferentiated: false },
  )
  assert.equal(filtered.kept.length, 1)
  assert.deepEqual(filtered.dropped, [])
})

test('a single generic keyword is not enough when the provider ignored the queries', () => {
  // A consumer product page can share the topic word ("导出") with the task and
  // still be useless. Two matches is the bar once the provider has proven it
  // does not differentiate queries.
  const filtered = filterSources(
    [source('https://some-tool.example/', '轻虾导出助手 - 微信聊天记录导出工具')],
    { keywords: ['导出', 'excel'], undifferentiated: true },
  )
  assert.equal(filtered.kept.length, 0)
  assert.equal(filtered.dropped[0].reason, 'single-keyword-match')

  const docs = filterSources(
    [source('https://docs.example/', '导出 Excel 的完整指南')],
    { keywords: ['导出', 'excel'], undifferentiated: true },
  )
  assert.equal(docs.kept.length, 1)
})

test('when every angle returned the same set, only keyword matches survive', () => {
  const filtered = filterSources(
    [
      source('https://mumu.163.com/', 'MuMu模拟器官网'),
      source('https://example.com/cooking', 'Cooking recipes'),
      source('https://github.com/example/sim', 'sim game engine 模拟经营'),
    ],
    { keywords: ['模拟经营', 'game'], undifferentiated: true },
  )
  // `模拟` matched the title of the first hit but `模拟经营` did not, and
  // `game` is absent — so only the exact-subject repository survives.
  assert.deepEqual(filtered.kept.map((entry) => entry.url), ['https://github.com/example/sim'])
  assert.equal(filtered.dropped.length, 2)
  assert.equal(filtered.dropped[0].reason, 'off-topic-source')
})

test('kept sources are ranked by relevance, then by how many angles they serve', () => {
  const filtered = filterSources(
    [
      source('https://a.example/weak', 'game engine', ['similar']),
      source('https://b.example/strong', 'game engine 存档', ['similar', 'reference']),
      source('https://c.example/mid', 'game engine 存档', ['similar']),
    ],
    { keywords: ['game', '存档'] },
  )
  assert.deepEqual(filtered.kept.map((entry) => entry.url), [
    'https://b.example/strong',
    'https://c.example/mid',
    'https://a.example/weak',
  ])
})

test('the result cap is honoured', () => {
  const many = Array.from({ length: 30 }, (_, index) => source(`https://a.example/${index}`, 'game engine'))
  const filtered = filterSources(many, { keywords: ['game'], max: 5 })
  assert.equal(filtered.kept.length, 5)
})

test('identical sets across angles are detected once they are non-trivial', () => {
  const repeated = [
    { id: 'similar', sources: [source('https://a/1', 'a'), source('https://a/2', 'b'), source('https://a/3', 'c')] },
    { id: 'reference', sources: [source('https://a/3', 'c'), source('https://a/1', 'a'), source('https://a/2', 'b')] },
  ]
  assert.equal(anglesUndifferentiated(repeated), true)

  // One shared hit is a find, not a provider that ignored the query.
  const shared = [
    { id: 'similar', sources: [source('https://a/1', 'a')] },
    { id: 'reference', sources: [source('https://a/1', 'a')] },
  ]
  assert.equal(anglesUndifferentiated(shared), false)

  // Two truly different sets are differentiated.
  const distinct = [
    { id: 'similar', sources: [source('https://a/1', 'a'), source('https://a/2', 'b'), source('https://a/3', 'c')] },
    { id: 'reference', sources: [source('https://a/9', 'x'), source('https://a/8', 'y'), source('https://a/7', 'z')] },
  ]
  assert.equal(anglesUndifferentiated(distinct), false)
})

test('the briefing admits a provider that ignored the queries', () => {
  const briefing = formatBriefing({
    domain: 'game',
    keywords: ['模拟经营'],
    providers: ['bing-rss'],
    notes: ['undifferentiated:angles', 'filtered:3'],
    undifferentiated: true,
    dropped: [{ url: 'https://x.example', reason: 'off-topic-source' }],
    angles: [{
      id: 'similar',
      purpose: 'comparable titles',
      provider: 'bing-rss',
      sources: [source('https://a.example/1', 'A')],
    }],
  })
  assert.match(briefing, /Every angle returned the same result set/u)
  assert.match(briefing, /dropped for sharing nothing/u)
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
