/**
 * Tests for dependency vetting: name recognition, the advisory and registry
 * lookups, and the verdict rendering.
 */
import assert from 'node:assert/strict'
import {
  detectNpmPackage,
  fetchAdvisories,
  fetchPackageMeta,
  formatVerdict,
  vetPackage,
} from '../lib/vet.js'

const cases = []
/** Register one assertion group. */
const test = (name, fn) => cases.push([name, fn])

test('detectNpmPackage recognises plain and scoped names', () => {
  assert.equal(detectNpmPackage('express'), 'express')
  assert.equal(detectNpmPackage('  lodash  '), 'lodash')
  assert.equal(detectNpmPackage('@scope/pkg'), '@scope/pkg')
})

test('detectNpmPackage reads a name out of an npm URL', () => {
  assert.equal(detectNpmPackage('https://www.npmjs.com/package/express'), 'express')
  assert.equal(detectNpmPackage('https://npmjs.com/package/@scope/pkg'), '@scope/pkg')
})

test('detectNpmPackage rejects things that are not packages', () => {
  assert.equal(detectNpmPackage('https://github.com/a/b'), null)
  assert.equal(detectNpmPackage('https://example.com/a'), null)
  assert.equal(detectNpmPackage('some/relative/path'), null)
  assert.equal(detectNpmPackage(''), null)
  assert.equal(detectNpmPackage(undefined), null)
})

test('fetchPackageMeta reads the facts a decision needs', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        name: 'express',
        version: '4.19.2',
        license: 'MIT',
        description: 'web framework',
        dependencies: { bodyparser: '1.20.1' },
      }
    },
  })
  const meta = await fetchPackageMeta('express', { fetchImpl })
  assert.equal(meta.license, 'MIT')
  assert.equal(meta.version, '4.19.2')
  assert.deepEqual(meta.dependencies, ['bodyparser'])
})

test('fetchPackageMeta reports a deprecated package as deprecated', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() { return { name: 'old', version: '1.0.0', deprecated: 'use new-pkg instead' } },
  })
  const meta = await fetchPackageMeta('old', { fetchImpl })
  assert.equal(meta.deprecated, 'use new-pkg instead')
})

test('fetchPackageMeta fails soft on an error status', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, async json() { return {} } })
  assert.equal(await fetchPackageMeta('nope', { fetchImpl }), undefined)
})

test('fetchAdvisories reports the known advisories', async () => {
  const fetchImpl = async (url, init) => {
    assert.match(String(url), /osv\.dev/u)
    assert.equal(init.method, 'POST')
    const body = JSON.parse(init.body)
    assert.equal(body.package.name, 'lodash')
    assert.equal(body.package.ecosystem, 'npm')
    return {
      ok: true,
      status: 200,
      async json() { return { vulns: [{ id: 'GHSA-1', summary: 'ReDoS' }] } },
    }
  }
  const outcome = await fetchAdvisories('lodash', { fetchImpl })
  assert.equal(outcome.checked, true)
  assert.equal(outcome.advisories.length, 1)
  assert.equal(outcome.advisories[0].id, 'GHSA-1')
})

test('fetchAdvisories scopes the query to the registry version', async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    assert.equal(body.version, '4.19.2')
    return { ok: true, status: 200, async json() { return { vulns: [] } } }
  }
  const outcome = await fetchAdvisories('lodash', { fetchImpl, version: '4.19.2' })
  assert.equal(outcome.checked, true)
  assert.deepEqual(outcome.advisories, [])
})

test('fetchAdvisories reports an empty list when nothing is known', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, async json() { return { vulns: [] } } })
  const outcome = await fetchAdvisories('clean', { fetchImpl })
  assert.equal(outcome.checked, true, 'an empty answer is a successful check')
  assert.deepEqual(outcome.advisories, [])
})

test('fetchAdvisories distinguishes a failed lookup from a clean one', async () => {
  const httpError = async () => ({ ok: false, status: 503, async json() { return {} } })
  const failed = await fetchAdvisories('x', { fetchImpl: httpError })
  assert.equal(failed.checked, false)
  assert.equal(failed.reason, 'HTTP_503')
  const badBody = async () => ({ ok: true, status: 200, async json() { return { unexpected: true } } })
  const malformed = await fetchAdvisories('x', { fetchImpl: badBody })
  assert.equal(malformed.checked, false)
  assert.equal(malformed.reason, 'unexpected-body')
  const offline = async () => { throw new Error('fetch failed') }
  const unreachable = await fetchAdvisories('x', { fetchImpl: offline })
  assert.equal(unreachable.checked, false)
  assert.equal(unreachable.reason, 'unreachable')
})

test('vetPackage combines the registry facts and the advisories', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('osv.dev')) {
      return { ok: true, status: 200, async json() { return { vulns: [{ id: 'GHSA-2', summary: 'x' }] } } }
    }
    return { ok: true, status: 200, async json() { return { name: 'p', version: '1.0.0', license: 'ISC' } } }
  }
  const verdict = await vetPackage('p', { fetchImpl })
  assert.equal(verdict.checked, true)
  assert.equal(verdict.advisoriesChecked, true)
  assert.equal(verdict.license, 'ISC')
  assert.equal(verdict.vulnerable, true)
  assert.equal(verdict.advisories.length, 1)
})

test('a failed advisory lookup is an unknown, never a clean bill of health', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('osv.dev')) {
      return { ok: false, status: 500, async json() { return {} } }
    }
    return { ok: true, status: 200, async json() { return { name: 'p', version: '2.0.0', license: 'MIT' } } }
  }
  const verdict = await vetPackage('p', { fetchImpl })
  assert.equal(verdict.checked, true, 'the registry was read')
  assert.equal(verdict.advisoriesChecked, false, 'the advisory database was not')
  assert.equal(verdict.vulnerable, undefined)
  assert.equal(verdict.advisories.length, 0)
  assert.match(formatVerdict(verdict), /advisories not checked/u)
})

test('formatVerdict puts the licence and advisories first', () => {
  assert.equal(formatVerdict({ checked: true, license: 'MIT', vulnerable: false }), 'MIT')
  assert.equal(
    formatVerdict({ checked: true, license: 'MIT', vulnerable: true, advisories: [{ id: 'GHSA-9' }] }),
    'MIT · 1 advisory: GHSA-9',
  )
  assert.equal(formatVerdict({ checked: true, vulnerable: false }), '')
  assert.equal(formatVerdict({ checked: false }), '')
  assert.equal(formatVerdict(undefined), '')
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
