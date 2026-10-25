/**
 * Tests for the repository-fact enrichment: URL recognition, annotation
 * formatting, and the best-effort lookup contract.
 */
import assert from 'node:assert/strict'
import {
  detectGitHubRepo,
  enrichSources,
  fetchRepoMeta,
  formatMeta,
  formatStars,
  maintenanceLabel,
} from '../lib/enrich.js'

const cases = []
/** Register one assertion group. */
const test = (name, fn) => cases.push([name, fn])

test('detectGitHubRepo recognises a repository URL', () => {
  assert.deepEqual(detectGitHubRepo('https://github.com/deepseek-ai/DeepSeek-Harness'), {
    owner: 'deepseek-ai',
    repo: 'DeepSeek-Harness',
  })
  assert.deepEqual(detectGitHubRepo('https://www.github.com/a/b'), { owner: 'a', repo: 'b' })
})

test('detectGitHubRepo ignores non-repository pages and other hosts', () => {
  assert.equal(detectGitHubRepo('https://github.com/deepseek-ai'), null)
  assert.equal(detectGitHubRepo('https://github.com/orgs/foo'), null)
  assert.equal(detectGitHubRepo('https://github.com/topics/game'), null)
  assert.equal(detectGitHubRepo('https://gitlab.com/a/b'), null)
  assert.equal(detectGitHubRepo('https://example.com/a/b'), null)
  assert.equal(detectGitHubRepo('not a url'), null)
  assert.equal(detectGitHubRepo(undefined), null)
})

test('formatStars renders a compact count', () => {
  assert.equal(formatStars(0), '0')
  assert.equal(formatStars(999), '999')
  assert.equal(formatStars(1500), '1.5k')
  assert.equal(formatStars(12_300), '12.3k')
  assert.equal(formatStars(undefined), '')
  assert.equal(formatStars(-1), '')
})

test('maintenanceLabel describes how recently a repository moved', () => {
  const now = Date.parse('2026-10-01T00:00:00Z')
  assert.equal(maintenanceLabel('2026-09-25T00:00:00Z', now), 'active')
  // 91 days: stale, and the label states its own threshold.
  assert.equal(maintenanceLabel('2026-07-02T00:00:00Z', now), 'stale (>90d)')
  // A full year elapsed: unmaintained, not "stale (>1y)".
  assert.equal(maintenanceLabel('2025-09-30T00:00:00Z', now), 'unmaintained (>1y)')
  assert.equal(maintenanceLabel('nonsense', now), '')
})

test('formatMeta puts licence first and says when a project is archived', () => {
  assert.equal(formatMeta({ license: 'MIT', pushedAt: '2026-09-25T00:00:00Z', stars: 1200 }), 'MIT · active · 1.2k★')
  assert.equal(formatMeta({ archived: true, license: 'Apache-2.0' }), 'Apache-2.0 · archived')
  assert.equal(formatMeta(undefined), '')
  assert.equal(formatMeta({}), '')
})

test('an unknown licence is reported as unknown, never as permissive', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() { return { license: { spdx_id: 'NOASSERTION' }, stargazers_count: 1 } },
  })
  const meta = await fetchRepoMeta({ owner: 'a', repo: 'b' }, { fetchImpl })
  assert.equal(meta.license, 'unknown licence')
})

test('fetchRepoMeta reads the fields the decision needs', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        license: { spdx_id: 'MIT' },
        archived: false,
        pushed_at: '2026-10-01T00:00:00Z',
        stargazers_count: 42,
        description: 'a harness',
      }
    },
  })
  const meta = await fetchRepoMeta({ owner: 'a', repo: 'b' }, { fetchImpl })
  assert.equal(meta.license, 'MIT')
  assert.equal(meta.archived, false)
  assert.equal(meta.stars, 42)
})

test('fetchRepoMeta reports an unknown licence honestly', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() { return { license: { spdx_id: 'NOASSERTION' }, stargazers_count: 1 } },
  })
  const meta = await fetchRepoMeta({ owner: 'a', repo: 'b' }, { fetchImpl })
  assert.equal(meta.license, 'unknown licence')
})

test('fetchRepoMeta fails soft on an error status or a network fault', async () => {
  const failing = async () => ({ ok: false, status: 404, async json() { return {} } })
  assert.equal(await fetchRepoMeta({ owner: 'a', repo: 'b' }, { fetchImpl: failing }), undefined)
  const throwing = async () => { throw new Error('offline') }
  assert.equal(await fetchRepoMeta({ owner: 'a', repo: 'b' }, { fetchImpl: throwing }), undefined)
})

test('enrichSources annotates repositories and leaves other links alone', async () => {
  const fetchImpl = async (url) => {
    assert.match(String(url), /github\.com/)
    return {
      ok: true,
      status: 200,
      async json() {
        return { license: { spdx_id: 'MIT' }, pushed_at: '2026-10-01T00:00:00Z', stargazers_count: 10 }
      },
    }
  }
  const sources = [
    { url: 'https://github.com/a/b', title: 'Repo' },
    { url: 'https://example.com/post', title: 'Post' },
  ]
  const enriched = await enrichSources(sources, { fetchImpl, limit: 4 })
  assert.equal(enriched[0].meta.license, 'MIT')
  assert.equal(enriched[1].meta, undefined)
})

test('enrichSources reads one repository once even when it appears twice', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return { ok: true, status: 200, async json() { return { license: { spdx_id: 'MIT' } } } }
  }
  const sources = [
    { url: 'https://github.com/a/b' },
    { url: 'https://github.com/a/b#readme' },
  ]
  await enrichSources(sources, { fetchImpl, limit: 4 })
  assert.equal(calls, 1)
})

test('enrichSources respects its limit', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return { ok: true, status: 200, async json() { return {} } }
  }
  const sources = [
    { url: 'https://github.com/a/one' },
    { url: 'https://github.com/b/two' },
    { url: 'https://github.com/c/three' },
  ]
  await enrichSources(sources, { fetchImpl, limit: 2 })
  assert.equal(calls, 2)
})

test('enrichSources with a zero limit makes no calls at all', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return { ok: true, status: 200, async json() { return {} } }
  }
  const sources = [{ url: 'https://github.com/a/b' }]
  const enriched = await enrichSources(sources, { fetchImpl, limit: 0 })
  assert.equal(calls, 0)
  assert.equal(enriched[0].meta, undefined)
})

/**
 * Placeholder kept so the licence test above reads as a statement about a
 * missing fact rather than about a helper.
 * @returns {undefined} always undefined.
 */
function await_placeholder() {
  return undefined
}

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
