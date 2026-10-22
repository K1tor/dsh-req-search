/**
 * Tests for project memory: the Markdown format, the round trip, and the
 * note the model receives.
 */
import assert from 'node:assert/strict'
import {
  MAX_ENTRIES,
  appendMemory,
  formatMemoryNote,
  memoryBody,
  memoryTitle,
  parseMemory,
  renderMemory,
} from '../lib/memory.js'

const cases = []
/** Register one assertion group. */
const test = (name, fn) => cases.push([name, fn])

test('an empty memory renders as a placeholder', () => {
  const body = renderMemory([])
  assert.match(body, /Nothing recorded yet/u)
})

test('entries round trip through the file format', () => {
  const body = appendMemory('', { title: 'Build an auth service', body: 'Chose JWT with refresh tokens.', when: '2026-10-01' })
  const entries = parseMemory(body)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].title, 'Build an auth service')
  assert.equal(entries[0].when, '2026-10-01')
  assert.match(entries[0].body, /refresh tokens/u)
})

test('a repeated title replaces the older entry', () => {
  let body = appendMemory('', { title: 'Same task', body: 'first finding' })
  body = appendMemory(body, { title: 'Same task', body: 'second finding' })
  const entries = parseMemory(body)
  assert.equal(entries.length, 1)
  assert.match(entries[0].body, /second finding/u)
  assert.doesNotMatch(entries[0].body, /first finding/u)
})

test('the newest entry comes first', () => {
  let body = appendMemory('', { title: 'first', body: 'a' })
  body = appendMemory(body, { title: 'second', body: 'b' })
  const entries = parseMemory(body)
  assert.equal(entries[0].title, 'second')
})

test('the file stays bounded', () => {
  let body = ''
  for (let index = 0; index < MAX_ENTRIES + 10; index += 1) {
    body = appendMemory(body, { title: `entry ${index}`, body: 'x' })
  }
  assert.ok(parseMemory(body).length <= MAX_ENTRIES)
})

test('a hand-edited file is parsed leniently', () => {
  const hand = [
    '# Some other title',
    '',
    '## A decision',
    '_2026-09-01_',
    '',
    'We chose SQLite over Postgres.',
    '',
    '## Another',
    'body without a date',
  ].join('\n')
  const entries = parseMemory(hand)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].title, 'A decision')
  assert.equal(entries[1].title, 'Another')
})

test('an unparseable file yields no entries rather than an error', () => {
  assert.deepEqual(parseMemory(''), [])
  assert.deepEqual(parseMemory(undefined), [])
  assert.deepEqual(parseMemory('no headings at all'), [])
})

test('formatMemoryNote summarises what is known', () => {
  const entries = [{ title: 'Auth', body: 'JWT with refresh tokens, Passport library.' }]
  const note = formatMemoryNote(entries)
  assert.match(note, /Already known/u)
  assert.match(note, /Auth/u)
  assert.match(note, /Passport/u)
})

test('formatMemoryNote is empty when nothing is known', () => {
  assert.equal(formatMemoryNote([]), '')
  assert.equal(formatMemoryNote(undefined), '')
})

test('formatMemoryNote caps each entry', () => {
  const entries = [{ title: 'Long', body: 'x'.repeat(5000) }]
  const note = formatMemoryNote(entries, { charsPerEntry: 100 })
  assert.ok(note.length < 300, `note was ${note.length} characters`)
})

test('memoryTitle is stable and bounded', () => {
  assert.equal(memoryTitle('Build an auth service'), 'Build an auth service')
  assert.ok(memoryTitle('x'.repeat(500)).length <= 401)
  assert.equal(memoryTitle('   '), 'research')
})

test('memoryBody keeps the sources and their facts', () => {
  const body = memoryBody({
    domain: 'web',
    angles: [
      {
        id: 'reference',
        sources: [{ url: 'https://github.com/a/b', title: 'Repo', meta: { license: 'MIT' } }],
      },
      { id: 'similar', sources: [] },
    ],
  })
  assert.match(body, /Domain: web/u)
  assert.match(body, /reference:/u)
  assert.match(body, /https:\/\/github\.com\/a\/b/u)
  assert.match(body, /MIT/u)
  assert.doesNotMatch(body, /similar:/u)
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
