/**
 * Standalone test runner for the pure helpers.
 *
 * `node --test` spawns a child process per file with piped stdio, which the
 * DSH sandbox denies; this runner imports the module under test and asserts
 * in-process so the same cases run everywhere.
 */
import assert from 'node:assert/strict'
import {
  buildQuery,
  extractKeywords,
  hasCjk,
  normalizeSources,
  normalizeWebResult,
  parseBingRss,
  sourcesToMarkdown,
} from '../lib/search.js'

const cases = []
/** Register one assertion group. */
const test = (name, fn) => cases.push([name, fn])

test('extractKeywords segments Chinese requirements', () => {
  const keywords = extractKeywords('帮我写一个提出项目要求后关联搜索网页的插件')
  assert.ok(keywords.includes('项目'), keywords.join(','))
  assert.ok(keywords.includes('关联'))
  assert.ok(keywords.includes('搜索'))
  assert.ok(keywords.includes('网页'))
  assert.ok(!keywords.includes('帮我'))
  assert.ok(!keywords.includes('一个'))
})

test('extractKeywords keeps identifiers intact', () => {
  const keywords = extractKeywords('Use ctx.web.search() from DeepSeek Harness with web_search')
  assert.ok(keywords.includes('ctx.web.search'), keywords.join(','))
  assert.ok(keywords.includes('deepseek'))
  assert.ok(keywords.includes('harness'))
  assert.ok(keywords.includes('web_search'))
  assert.ok(!keywords.includes('use'))
})

test('extractKeywords deduplicates and caps', () => {
  const keywords = extractKeywords('react react react vue svelte angular ember backbone', 3)
  assert.deepEqual(keywords, ['react', 'vue', 'svelte'])
})

test('extractKeywords survives an empty requirement', () => {
  assert.deepEqual(extractKeywords(''), [])
  assert.deepEqual(extractKeywords(undefined), [])
})

test('buildQuery falls back to the raw requirement', () => {
  assert.equal(buildQuery('  要不要  用 Bing  ', []), '要不要 用 Bing')
  assert.equal(buildQuery('', []), '')
  assert.equal(buildQuery('x'.repeat(400), ['a', 'b']), 'a b')
  assert.equal(buildQuery('x'.repeat(400), []), 'x'.repeat(120))
})

test('hasCjk detects ideographs', () => {
  assert.equal(hasCjk('插件'), true)
  assert.equal(hasCjk('plugin'), false)
  assert.equal(hasCjk('plugin 插件'), true)
})

test('parseBingRss reads items and drops non-http links', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>Alpha &amp; Beta</title><link>https://example.com/a</link><description>First &lt;b&gt;hit&lt;/b&gt;</description></item>
    <item><title><![CDATA[Gamma]]></title><link>https://example.com/b</link><description></description></item>
    <item><title>Bad</title><link>not-a-url</link><description>skip me</description></item>
  </channel></rss>`
  const sources = parseBingRss(xml)
  assert.equal(sources.length, 2)
  assert.deepEqual(sources[0], {
    url: 'https://example.com/a',
    title: 'Alpha & Beta',
    snippet: 'First hit',
  })
  assert.deepEqual(sources[1], { url: 'https://example.com/b', title: 'Gamma' })
})

test('parseBingRss tolerates garbage', () => {
  assert.deepEqual(parseBingRss(undefined), [])
  assert.deepEqual(parseBingRss('<rss></rss>'), [])
})

test('normalizeSources dedupes, validates and caps', () => {
  const sources = normalizeSources(
    [
      { url: 'https://a.example/1', title: 'A' },
      { url: 'https://a.example/1#frag', title: 'A again' },
      { url: 'ftp://b.example/2' },
      { url: 'https://c.example/3', snippet: '', publishedAt: '2026-01-01' },
      { nope: true },
      { url: 'https://d.example/4' },
    ],
    3,
  )
  assert.deepEqual(sources, [
    { url: 'https://a.example/1', title: 'A' },
    { url: 'https://c.example/3', publishedAt: '2026-01-01' },
    { url: 'https://d.example/4' },
  ])
})

test('normalizeWebResult keeps the provider answer and flags truncation', () => {
  const result = normalizeWebResult(
    {
      content: '  an answer  ',
      sources: [{ url: 'https://a.example/1' }, { url: 'https://b.example/2' }],
      truncated: false,
    },
    1,
  )
  assert.deepEqual(result.sources.map((source) => source.url), ['https://a.example/1'])
  assert.equal(result.truncated, true)
  assert.equal(result.answer, '  an answer  ')

  const empty = normalizeWebResult(undefined, 5)
  assert.deepEqual(empty, { sources: [], truncated: false })
})

test('sourcesToMarkdown numbers the links', () => {
  assert.equal(
    sourcesToMarkdown([
      { url: 'https://a.example', title: 'A', snippet: 'first' },
      { url: 'https://b.example' },
    ]),
    '1. [A](https://a.example) — first\n2. [https://b.example](https://b.example)',
  )
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
