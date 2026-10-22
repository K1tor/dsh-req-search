/**
 * Style-question handshake tests: offer validation, revision replacement, and
 * the answer path the `ask_style` tool waits on.
 */
import assert from 'node:assert/strict'
import { createStyleStore, MAX_OPTIONS, normalizeOffer } from '../lib/style-store.js'

const cases = []
/** Register one assertion group. */
const test = (name, fn) => cases.push([name, fn])

test('normalizeOffer accepts a valid offer and trims it', () => {
  const offer = normalizeOffer({ question: '  选风格  ', options: [' 像素 ', '写实', '像素'] })
  assert.equal(offer.ok, false, 'a repeated option is rejected')
  const good = normalizeOffer({ question: '  选风格  ', options: [' 像素 ', '写实'] })
  assert.deepEqual(good, { ok: true, question: '选风格', options: ['像素', '写实'] })
})

test('normalizeOffer rejects too few, too many and empty options', () => {
  assert.equal(normalizeOffer({ options: ['a'] }).ok, false)
  assert.equal(normalizeOffer({ options: [] }).ok, false)
  assert.equal(normalizeOffer({}).ok, false)
  assert.equal(normalizeOffer({ options: ['   ', 'b'] }).ok, false)
  assert.equal(normalizeOffer({ options: Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => `o${i}`) }).ok, false)
})

test('normalizeOffer supplies a default question and caps its length', () => {
  const offer = normalizeOffer({ options: ['a', 'b'] })
  assert.equal(offer.ok, true)
  assert.ok(offer.question.length > 0)
  const long = normalizeOffer({ question: 'x'.repeat(500), options: ['a', 'b'] })
  assert.equal(long.question.length, 200)
})

test('a second offer replaces the first and bumps the revision', () => {
  const store = createStyleStore()
  const first = store.offer({ question: 'one', options: ['a', 'b'] })
  const second = store.offer({ question: 'two', options: ['c', 'd'] })
  assert.equal(first.revision, 1)
  assert.equal(second.revision, 2)
  assert.deepEqual(store.snapshot().pending.options, ['c', 'd'])
})

test('answering clears the pending question', () => {
  const store = createStyleStore()
  store.offer({ question: 'q', options: ['a', 'b'] })
  assert.deepEqual(store.answer('a'), { ok: true, revision: 1, choice: 'a' })
  assert.equal(store.snapshot().pending, null)
  assert.deepEqual(store.snapshot().answered, { revision: 1, choice: 'a' })
})

test('answering an unoffered option or with nothing pending fails', () => {
  const store = createStyleStore()
  assert.equal(store.answer('a').ok, false)
  store.offer({ question: 'q', options: ['a', 'b'] })
  const rejected = store.answer('c')
  assert.equal(rejected.ok, false)
  // The question is still pending after a rejected answer.
  assert.deepEqual(store.snapshot().pending.options, ['a', 'b'])
})

test('clear withdraws a pending question', () => {
  const store = createStyleStore()
  store.offer({ question: 'q', options: ['a', 'b'] })
  store.clear()
  assert.equal(store.snapshot().pending, null)
  assert.equal(store.answer('a').ok, false)
})

test('a snapshot is detached from the store', () => {
  const store = createStyleStore()
  store.offer({ question: 'q', options: ['a', 'b'] })
  const snapshot = store.snapshot()
  snapshot.pending.options.push('c')
  assert.deepEqual(store.snapshot().pending.options, ['a', 'b'])
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
