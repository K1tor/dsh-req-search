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
  const advisories = await fetchAdvisories('lodash', { fetchImpl })
  assert.equal(advisories.length, 1)
  assert.equal(advisories[0].id, 'GHSA-1')
})

test('fetchAdvisories returns an empty list when nothing is known', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, async json() { return { vulns: [] } } })
  assert.deepEqual(await fetchAdvisories('clean', { fetchImpl }), [])
})

test('fetchAdvisories fails soft on a network fault', async () => {
  const fetchImpl = async () => { throw new Error('offline') }
  assert.deepEqual(await fetchAdvisories('x', { fetchImpl }), [])
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
  assert.equal(verdict.license, 'ISC')
  assert.equal(verdict.vulnerable, true)
  assert.equal(verdict.advisories.length, 1)
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
