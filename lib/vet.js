/**
 * Dependency vetting for the packages a research result suggests.
 *
 * The engine's job is to decide what to adopt. "Should I add this package?"
 * has three answers the web search cannot give: does it have a licence that
 * allows it, is it still maintained, and does it carry a known vulnerability.
 * The first two come from the repository metadata; the third comes from the
 * advisory databases.
 *
 * The npm registry and the OSV advisory API both answer without a key, so a
 * package named in a search result can be checked before the model decides to
 * depend on it. Every lookup is best-effort: an unreachable registry leaves
 * the package unvetted, which the caller must report as "not checked" rather
 * than as "safe".
 */

/** The npm registry's package metadata endpoint. */
const NPM_REGISTRY = 'https://registry.npmjs.org'

/** OSV's query API for one package. */
const OSV_API = 'https://api.osv.dev/v1/query'

/** Longest one registry or advisory read, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 8000

/** The ecosystems OSV knows, keyed by the npm ecosystem name. */
const ECOSYSTEMS = { npm: 'npm' }

/** A plain package name: lowercase start, then letters, digits, dot, dash, underscore. */
const PLAIN_NAME = /^[a-z0-9][a-z0-9._-]*$/

/** A scoped package name: an `@scope` prefix and a plain name after the slash. */
const SCOPED_NAME = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/

/**
 * Recognise an npm package name in a URL or a bare name.
 *
 * @param {unknown} value - a candidate package name or URL.
 * @returns {string | null} the package name, or null when there is none.
 */
export function detectNpmPackage(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0) return null
  // A URL is read as a URL; a bare name is read as a name. The URL check has
  // to come first, because `example.com/express` also looks like a bare
  // name once its host is stripped.
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) {
    let parsed
    try {
      parsed = new URL(text)
    } catch {
      return null
    }
    if (parsed.hostname !== 'www.npmjs.com' && parsed.hostname !== 'npmjs.com') return null
    const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0)
    // A package page is `/package/<name>`; a bare `/<name>` also resolves.
    if (segments[0] === 'package') segments.shift()
    if (segments.length < 1) return null
    // A scoped package occupies two path segments: `/package/@scope/name`.
    let raw = segments[0]
    if (raw.startsWith('@') && segments.length > 1) raw = `${raw}/${segments[1]}`
    let name
    try {
      name = decodeURIComponent(raw)
    } catch {
      return null
    }
    if (PLAIN_NAME.test(name) || SCOPED_NAME.test(name)) return name
    return null
  }
  if (PLAIN_NAME.test(text)) return text.toLowerCase()
  if (SCOPED_NAME.test(text)) return text
  return null
}

/**
 * Read one package's registry metadata.
 *
 * @param {string} name - the package name.
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [options] - knobs.
 * @returns {Promise<object | undefined>} the metadata, or undefined on failure.
 */
export async function fetchPackageMeta(name, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const doFetch = options.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return undefined
  try {
    const response = await doFetch(`${NPM_REGISTRY}/${name.replace('/', '%2f')}/latest`, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-req-search/0.1' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return undefined
    const payload = await response.json()
    if (typeof payload !== 'object' || payload === null) return undefined
    return {
      name: typeof payload.name === 'string' ? payload.name : name,
      version: typeof payload.version === 'string' ? payload.version : undefined,
      license: typeof payload.license === 'string' ? payload.license : undefined,
      description: typeof payload.description === 'string' ? payload.description.slice(0, 200) : undefined,
      deprecated: typeof payload.deprecated === 'string' ? payload.deprecated : undefined,
      dependencies: typeof payload.dependencies === 'object' && payload.dependencies !== null ? Object.keys(payload.dependencies) : [],
    }
  } catch {
    return undefined
  }
}

/**
 * Query OSV for the known advisories affecting one package.
 *
 * @param {string} name - the package name.
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [options] - knobs.
 * @returns {Promise<Array<{ id: string, summary: string }>>} the advisories; empty when none are known.
 */
export async function fetchAdvisories(name, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const doFetch = options.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return []
  try {
    const response = await doFetch(OSV_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'dsh-req-search/0.1' },
      body: JSON.stringify({
        package: { name, ecosystem: ECOSYSTEMS.npm },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return []
    const payload = await response.json()
    if (typeof payload !== 'object' || payload === null || !Array.isArray(payload.vulns)) return []
    return payload.vulns
      .filter((entry) => typeof entry === 'object' && entry !== null && typeof entry.id === 'string')
      .map((entry) => ({
        id: entry.id,
        summary: typeof entry.summary === 'string' ? entry.summary.slice(0, 200) : '',
      }))
  } catch {
    return []
  }
}

/**
 * Vet one package: its registry facts and the advisories against it.
 *
 * @param {string} name - the package name.
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [options] - knobs.
 * @returns {Promise<object>} the verdict; `checked` says whether anything was read.
 */
export async function vetPackage(name, options = {}) {
  const [meta, advisories] = await Promise.all([
    fetchPackageMeta(name, options),
    fetchAdvisories(name, options),
  ])
  return {
    package: name,
    checked: meta !== undefined,
    license: meta?.license,
    version: meta?.version,
    deprecated: meta?.deprecated,
    advisories,
    vulnerable: advisories.length > 0,
  }
}

/**
 * Render a verdict as one short line.
 *
 * The line has to make the decision easy: a licence problem and a known
 * advisory are the two facts that change what the model should do, so they
 * come first, and a package that was never checked says so.
 *
 * @param {object} verdict - output of {@link vetPackage}.
 * @returns {string} the annotation, or an empty string when nothing is known.
 */
export function formatVerdict(verdict) {
  if (verdict === undefined || verdict === null || typeof verdict !== 'object') return ''
  if (verdict.checked !== true) return ''
  const parts = []
  if (typeof verdict.license === 'string' && verdict.license.length > 0) parts.push(verdict.license)
  if (typeof verdict.deprecated === 'string' && verdict.deprecated.length > 0) parts.push('deprecated')
  if (verdict.vulnerable === true) {
    const ids = Array.isArray(verdict.advisories) ? verdict.advisories.map((entry) => entry.id) : []
    parts.push(`${ids.length} advisory${ids.length === 1 ? '' : 's'}: ${ids.slice(0, 3).join(', ')}`)
  }
  if (parts.length === 0) return ''
  return parts.join(' · ')
}
