/**
 * Real-network tests: the provider protocols as the live services actually
 * answer them, over real HTTP.
 *
 * The offline suite stubs every endpoint, which keeps it repeatable but can
 * only assert what the fixtures already knew. This group complements it with
 * the two protocol facts the 2026-10 audit caught in the wild:
 *
 *   - OSV answers a clean package with HTTP 200 and an object that may omit
 *     `vulns` entirely (`{}` for left-pad@1.3.0) — a successful empty check;
 *   - Bing's RSS endpoint occasionally serves HTTP 200 with zero items, and
 *     sometimes serves an HTML page that is not RSS at all.
 *
 * These tests touch the network, so they are a separate group: they are
 * skipped unless `DSH_REQ_SEARCH_NET=1` is set, and the skip states why. A
 * flaky network fails this group, never the offline suite.
 */
import assert from 'node:assert/strict'

import { fetchAdvisories, fetchPackageMeta, vetPackage } from '../lib/vet.js'
import { searchOneAngle } from '../lib/providers.js'

const cases = []
/** Register one assertion group. */
const test = (name, fn) => cases.push([name, fn])

if (process.env.DSH_REQ_SEARCH_NET !== '1') {
  console.log('skip real-network: touches live services; set DSH_REQ_SEARCH_NET=1 to run them')
  console.log('0/0 passed (skipped)')
} else {
  test('the npm registry answers a real package read', async () => {
    const meta = await fetchPackageMeta('express', { timeoutMs: 15000 })
    assert.ok(meta !== undefined, 'the registry read succeeded')
    assert.equal(meta.name, 'express')
    assert.ok(typeof meta.version === 'string' && meta.version.length > 0)
  })

  test('OSV answers a clean package with HTTP 200 and no vulns field', async () => {
    // The audit's real-world probe: left-pad@1.3.0 returns `{}`.
    const outcome = await fetchAdvisories('left-pad', { version: '1.3.0', timeoutMs: 15000 })
    assert.equal(outcome.checked, true, `an omitted vulns field is a successful check (got reason: ${outcome.reason})`)
    assert.equal(outcome.reason, undefined)
    assert.deepEqual(outcome.advisories, [])
  })

  test('vetPackage reads a real package end to end', async () => {
    const verdict = await vetPackage('left-pad', { timeoutMs: 15000 })
    assert.equal(verdict.checked, true, 'the registry was read')
    assert.equal(verdict.advisoriesChecked, true, 'the advisory database was read')
    assert.equal(verdict.vulnerable, false, 'a clean check reads as safe, not as failed')
  })

  test('Bing RSS answers a real query over its actual protocol', async () => {
    // No ctx.web and no account service: the angle falls through to the
    // keyless Bing path, exactly as it does in a deployment with neither.
    const ctx = { get: () => undefined }
    const result = await searchOneAngle({
      ctx,
      query: 'node.js stream backpressure documentation',
      limits: { maxResults: 5, timeoutMs: 15000, bingEmptyRetryMs: 500 },
      fallback: true,
    })
    if (result.provider === 'bing-rss') {
      assert.ok(result.sources.length > 0 || result.notes.includes('bing:empty'),
        'a real read either found sources or reported the empty feed')
      assert.ok(result.sources.every((source) => /^https?:\/\//iu.test(source.url)), 'sources are URLs')
    } else {
      // Bing refused the host entirely (rate limit, region block); that is a
      // network-condition failure, recorded as one, never as success.
      assert.equal(result.provider, 'none')
      assert.ok(result.notes.some((note) => note.startsWith('bing:')), result.notes.join(' '))
    }
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
}
