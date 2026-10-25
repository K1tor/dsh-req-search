/**
 * Source facts that decide whether a reference project is worth adopting.
 *
 * The briefing lists URLs and snippets. A snippet cannot tell the model that
 * a repository is MIT-licensed and actively maintained, or that it was
 * archived three years ago — and those are exactly the facts that separate
 * "adopt this dependency" from "borrow the idea and write it yourself".
 *
 * The GitHub REST API answers them without a key, so the engine can attach
 * licence, maintenance and popularity to the repositories it surfaces instead
 * of guessing or spending a fetch per repository.
 *
 * Enrichment is best-effort by design: a repository whose metadata cannot be
 * read is still a usable reference, just an unannotated one.
 */

/** GitHub's public API root; no authentication is used or required. */
const GITHUB_API = 'https://api.github.com'

/** A browser-ish user agent; the API rejects requests without one. */
const USER_AGENT = 'dsh-req-search/0.1 (+https://github.com/deepseek-ai/DeepSeek-Harness)'

/** Longest metadata read, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 8000

/** How many repositories one research run annotates at most. */
export const DEFAULT_ENRICH_LIMIT = 8

/**
 * Recognise a GitHub repository URL and pull out its owner and name.
 *
 * Only the canonical repository host counts: a link to a file, an issue or an
 * organisation page is not the repository itself, and annotating it with the
 * organisation's licence would be wrong.
 *
 * @param {unknown} url - a source URL.
 * @returns {{ owner: string, repo: string } | null} the repository identity.
 */
export function detectGitHubRepo(url) {
  if (typeof url !== 'string') return null
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') return null
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0)
  if (segments.length < 2) return null
  const [owner, repo] = segments
  // Reserved owner names are not repositories.
  if (['orgs', 'settings', 'features', 'topics', 'collections', 'sponsors', 'apps', 'marketplace'].includes(owner)) return null
  if (!/^[A-Za-z0-9_.-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(repo)) return null
  if (repo.endsWith('.git')) return null
  return { owner, repo }
}

/**
 * Format a star count the way a person reads it.
 * @param {unknown} value - the raw count.
 * @returns {string} a compact count, or an empty string when there is none.
 */
export function formatStars(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return ''
  if (value >= 1000) return `${Math.round(value / 100) / 10}k`
  return String(value)
}

/**
 * Condense a repository's metadata into one short annotation.
 *
 * The annotation is meant to sit on a source line: licence first (it decides
 * what the model may do with the code), then whether the project still lives,
 * then rough popularity as a weak signal of maturity.
 *
 * @param {object | undefined} meta - the metadata from {@link fetchRepoMeta}.
 * @returns {string} the annotation, or an empty string when nothing is known.
 */
export function formatMeta(meta) {
  if (meta === undefined || meta === null || typeof meta !== 'object') return ''
  const parts = []
  if (typeof meta.license === 'string' && meta.license.length > 0) parts.push(meta.license)
  if (meta.archived === true) parts.push('archived')
  else if (typeof meta.pushedAt === 'string' && meta.pushedAt.length > 0) parts.push(maintenanceLabel(meta.pushedAt))
  const stars = formatStars(meta.stars)
  if (stars.length > 0) parts.push(`${stars}★`)
  return parts.join(' · ')
}

/**
 * Describe how recently a repository was touched.
 *
 * The label states its own threshold so the text and the elapsed time can
 * never disagree: a push 91 days ago is "stale (>90d)", one 366 days ago is
 * "unmaintained (>1y)".
 *
 * @param {string} pushedAt - an ISO timestamp.
 * @param {number} [now] - the current epoch milliseconds, for testing.
 * @returns {string} a short label.
 */
export function maintenanceLabel(pushedAt, now = Date.now()) {
  const timestamp = Date.parse(pushedAt)
  if (Number.isNaN(timestamp)) return ''
  const days = Math.floor((now - timestamp) / 86_400_000)
  if (days < 0) return 'active'
  if (days <= 90) return 'active'
  if (days < 365) return 'stale (>90d)'
  return 'unmaintained (>1y)'
}

/**
 * Read one repository's metadata from the public GitHub API.
 *
 * @param {{ owner: string, repo: string }} repo - the repository identity.
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [options] - knobs.
 * @returns {Promise<object | undefined>} the metadata, or undefined on failure.
 */
export async function fetchRepoMeta(repo, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const doFetch = options.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return undefined
  try {
    const response = await doFetch(`${GITHUB_API}/repos/${repo.owner}/${repo.repo}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': USER_AGENT,
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'follow',
      signal: options.signal === undefined
        ? AbortSignal.timeout(timeoutMs)
        : typeof AbortSignal.any === 'function'
          ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
          : options.signal,
    })
    if (!response.ok) return undefined
    const payload = await response.json()
    if (typeof payload !== 'object' || payload === null) return undefined
    const license = typeof payload.license === 'object' && payload.license !== null ? payload.license : undefined
    const spdx = license !== undefined && typeof license.spdx_id === 'string' ? license.spdx_id : undefined
    return {
      license: spdx === undefined ? undefined : spdx === 'NOASSERTION' ? 'unknown licence' : spdx,
      archived: payload.archived === true,
      pushedAt: typeof payload.pushed_at === 'string' ? payload.pushed_at : undefined,
      stars: typeof payload.stargazers_count === 'number' ? payload.stargazers_count : undefined,
      description: typeof payload.description === 'string' ? payload.description.slice(0, 200) : undefined,
    }
  } catch {
    // A rate limit, a timeout or an offline host must not fail the research.
    return undefined
  }
}

/**
 * Attach repository facts to the sources that point at one.
 *
 * Only the first `limit` repositories are looked up: the briefing shows a
 * handful of sources per angle, and a research run should not turn into a
 * hundred API calls. Results are cached per URL so a repeated repository is
 * read once, and a repository that failed is not retried within the run.
 *
 * @param {Array<object>} sources - the merged sources.
 * @param {{ limit?: number, timeoutMs?: number, fetchImpl?: typeof fetch }} [options] - knobs.
 * @returns {Promise<Array<object>>} the sources, each possibly carrying `meta`.
 */
export async function enrichSources(sources, options = {}) {
  const limit = Math.max(0, options.limit ?? DEFAULT_ENRICH_LIMIT)
  if (limit === 0) return sources
  const targets = []
  for (const source of sources) {
    if (targets.length >= limit) break
    const repo = detectGitHubRepo(source.url)
    if (repo === null) continue
    const key = `${repo.owner}/${repo.repo}`
    if (targets.some((entry) => entry.key === key)) continue
    targets.push({ key, repo })
  }
  if (targets.length === 0) return sources

  const cache = new Map()
  await Promise.all(
    targets.map(async (target) => {
      const meta = await fetchRepoMeta(target.repo, {
      ...options,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    })
      cache.set(target.key, meta)
    }),
  )

  return sources.map((source) => {
    if (source.meta !== undefined) return source
    const repo = detectGitHubRepo(source.url)
    if (repo === null) return source
    const meta = cache.get(`${repo.owner}/${repo.repo}`)
    if (meta === undefined) return source
    return { ...source, meta }
  })
}
