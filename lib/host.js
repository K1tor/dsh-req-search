/**
 * Host half: the global research engine and its surfaces.
 *
 * This is the composition root. It builds one engine, mounts it on the shared
 * agent execution seam (`agent/pre-step`), registers the model-facing tools and
 * the behaviour contract, and exposes the engine's real state to the panel over
 * HTTP. The panel is one view of this object; the tools are another; the
 * background pass every agent inherits is the third.
 *
 * Nothing here decides whether a task deserves research — the engine does. This
 * module only routes requests to it and publishes what it actually did.
 */

import { createResearchEngine, ENGINE_DEFAULTS } from './engine.js'
import { clampInt, formatBriefing, readConfig, runResearch } from './providers.js'
import { buildContract, SECTION_NAME, SECTION_ORDER } from './contract.js'
import { DEFAULT_ENRICH_LIMIT, detectGitHubRepo, fetchRepoMeta, formatMeta, maintenanceLabel } from './enrich.js'
import { createStyleStore, normalizeOffer } from './style-store.js'
import { detectNpmPackage, vetPackage } from './vet.js'
import {
  installBackgroundPass,
  installContract,
  installTools,
  projectDirectory,
  readProjectFacts,
  recordInMemory,
} from './integration.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-req-search'

/** Version of the panel/status protocol this host implements. */
export const STATUS_VERSION = 2

/** Route that publishes and answers the pending style question. */
export const STYLE_PATH = '/dsh-req-search/style'

/** Route the panel subscribes to for engine revision changes. */
export const STYLE_EVENTS_PATH = '/dsh-req-search/style/events'

/** Route that publishes the engine's real run state. */
export const STATUS_PATH = '/dsh-req-search/status'

/** Route the panel subscribes to for run-state revision changes. */
export const STATUS_EVENTS_PATH = '/dsh-req-search/status/events'

/** Route that cancels or re-runs one research run. */
export const CONTROL_PATH = '/dsh-req-search/control'

/** Largest request body this route accepts, in bytes. */
const MAX_BODY_BYTES = 16 * 1024

/**
 * Config defaults. `maxResults` caps one angle's sources, `maxAngles` caps how
 * many angles run, `timeoutMs` bounds one provider call, `deadlineMs` bounds a
 * whole background run, and `fallback` selects whether the keyless Bing path may
 * run after the first two providers fail.
 */
export const DEFAULT_CONFIG = Object.freeze({
  ...ENGINE_DEFAULTS,
  maxResults: 8,
  maxAngles: 4,
  timeoutMs: 20000,
  concurrency: 3,
  fallback: true,
  enrich: DEFAULT_ENRICH_LIMIT,
})

/**
 * Write a JSON response with no-store caching.
 * @param {import('node:http').ServerResponse} response - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - JSON-serializable body.
 */
function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/**
 * Read and parse a size-capped JSON body.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @returns {Promise<unknown>} the parsed body.
 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Whether a request is same-origin with the page that loaded it.
 *
 * The Host header is the value an attacker's page cannot forge, so an
 * undeclared authority is refused regardless of what Origin claims; a request
 * carried by a proxy may drop Origin, which is not itself cross-site.
 *
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {() => readonly string[]} trustedHosts - deployment-declared authorities.
 * @returns {boolean} true when the request may be served.
 */
function sameOrigin(request, trustedHosts) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const host = request.headers.host
  const origin = request.headers.origin
  if (host !== undefined) {
    const bare = host.toLowerCase()
    const loopback = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/u.test(bare)
    const declared = trustedHosts().some((entry) => entry.toLowerCase() === bare)
    if (!loopback && !declared) return false
  }
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Build one server-sent-events response that fires when a revision moves.
 *
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {import('node:http').ServerResponse} response - the response.
 * @param {object} source - the object with `subscribe` and `revision`.
 */
function streamRevisions(request, response, source) {
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'text/event-stream; charset=utf-8',
    connection: 'keep-alive',
  })
  let lastRevision = source.revision
  response.write(`data: ${JSON.stringify({ revision: lastRevision })}\n\n`)
  // A subscription fires on every change; the stream collapses them into one
  // frame per revision move so the panel simply re-reads the snapshot.
  const dispose = source.subscribe(() => {
    if (source.revision === lastRevision) return
    lastRevision = source.revision
    try {
      response.write(`data: ${JSON.stringify({ revision: lastRevision })}\n\n`)
    } catch {
      dispose()
    }
  })
  // Some hosts deliver no subscription (a fake in a test); a slow poll still
  // keeps the panel honest without inventing progress.
  const timer = setInterval(() => {
    if (source.revision === lastRevision) return
    lastRevision = source.revision
    try {
      response.write(`data: ${JSON.stringify({ revision: lastRevision })}\n\n`)
    } catch {
      clearInterval(timer)
    }
  }, 3000)
  // A stream poll must never be the reason the host process stays alive; the
  // open socket already is, and it closes this timer.
  timer.unref?.()
  const close = () => {
    clearInterval(timer)
    dispose()
  }
  request.on?.('close', close)
  response.on?.('close', close)
}

/**
 * Vet one named dependency, choosing the checker that fits the name.
 *
 * An npm package is checked against the registry and the advisory database; a
 * GitHub repository is checked for licence and maintenance. Either way the
 * answer states what was actually looked up, so "not checked" never reads as
 * "safe".
 *
 * @param {string} target - a package name or a repository URL.
 * @param {{ timeoutMs?: number }} [options] - knobs.
 * @returns {Promise<object>} the verdict.
 */
export async function vetTarget(target, options = {}) {
  const repo = detectGitHubRepo(target)
  if (repo !== null) {
    const meta = await fetchRepoMeta(repo, options)
    if (meta === undefined) {
      return {
        ok: false,
        kind: 'repository',
        name: `${repo.owner}/${repo.repo}`,
        summary: `Could not read metadata for ${repo.owner}/${repo.repo}. Treat its licence and maintenance state as unknown.`,
        notes: ['metadata-unavailable'],
      }
    }
    const facts = formatMeta(meta)
    return {
      ok: true,
      kind: 'repository',
      name: `${repo.owner}/${repo.repo}`,
      summary: facts.length > 0
        ? `${repo.owner}/${repo.repo}: ${facts}.`
        : `${repo.owner}/${repo.repo}: no licence, maintenance or popularity facts could be read.`,
      license: meta.license,
      maintenance: meta.archived === true ? 'archived' : maintenanceLabel(meta.pushedAt ?? ''),
      notes: meta.license === undefined ? ['license-unknown'] : [],
    }
  }

  const packageName = detectNpmPackage(target)
  if (packageName === null) {
    return {
      ok: false,
      kind: 'unknown',
      name: target,
      summary: `Could not recognise "${target}" as an npm package or a GitHub repository. Pass a package name such as "express" or a repository URL.`,
      notes: ['unrecognised-target'],
    }
  }

  const verdict = await vetPackage(packageName, options)
  if (verdict.checked !== true) {
    return {
      ok: false,
      kind: 'npm',
      name: packageName,
      summary: `Could not read the registry entry for ${packageName}. Its licence, maintenance state and advisories are unknown.`,
      notes: ['registry-unavailable'],
    }
  }
  const parts = []
  if (typeof verdict.license === 'string' && verdict.license.length > 0) parts.push(`licence ${verdict.license}`)
  else parts.push('licence unknown')
  if (typeof verdict.deprecated === 'string' && verdict.deprecated.length > 0) parts.push('deprecated by its publisher')
  if (verdict.vulnerable === true) {
    const ids = verdict.advisories.map((entry) => entry.id)
    parts.push(`${ids.length} known advisory/advisories (${ids.slice(0, 3).join(', ')})`)
  } else {
    parts.push('no known advisories')
  }
  return {
    ok: true,
    kind: 'npm',
    name: packageName,
    summary: `${packageName}@${verdict.version ?? 'unknown'}: ${parts.join('; ')}.`,
    license: verdict.license,
    advisories: verdict.advisories.map((entry) => entry.id),
    notes: verdict.license === undefined ? ['license-unknown'] : [],
  }
}

/**
 * Mount the plugin.
 *
 * `webServer`, `tools`, `systemPrompt` and `workingDirectory` are injected
 * locally rather than declared on the plugin, so a host without one of them
 * still mounts the rest instead of failing activation for the whole
 * composition. The `agent/pre-step` listener is the exception: it is registered
 * on the root context precisely so it receives *every* agent.
 *
 * @param {object} ctx - plugin context.
 * @param {Record<string, unknown>} [config] - loader config.
 */
export function apply(ctx, config) {
  const limits = {
    background: readConfig(config, 'background', DEFAULT_CONFIG.background) !== false,
    blockMs: clampInt(readConfig(config, 'blockMs', DEFAULT_CONFIG.blockMs), 250, 120_000, DEFAULT_CONFIG.blockMs),
    maxResults: clampInt(readConfig(config, 'maxResults', DEFAULT_CONFIG.maxResults), 1, 20, DEFAULT_CONFIG.maxResults),
    maxAngles: clampInt(readConfig(config, 'maxAngles', DEFAULT_CONFIG.maxAngles), 1, 6, DEFAULT_CONFIG.maxAngles),
    angleCeiling: clampInt(readConfig(config, 'maxAngles', DEFAULT_CONFIG.maxAngles), 1, 6, DEFAULT_CONFIG.maxAngles),
    timeoutMs: clampInt(readConfig(config, 'timeoutMs', DEFAULT_CONFIG.timeoutMs), 500, 120_000, DEFAULT_CONFIG.timeoutMs),
    deadlineMs: clampInt(readConfig(config, 'deadlineMs', DEFAULT_CONFIG.deadlineMs), 1000, 300_000, DEFAULT_CONFIG.deadlineMs),
    concurrency: clampInt(readConfig(config, 'concurrency', DEFAULT_CONFIG.concurrency), 1, 6, DEFAULT_CONFIG.concurrency),
    enrich: clampInt(readConfig(config, 'enrich', DEFAULT_CONFIG.enrich), 0, 20, DEFAULT_CONFIG.enrich),
    fallback: readConfig(config, 'fallback', DEFAULT_CONFIG.fallback) !== false,
    historySize: clampInt(readConfig(config, 'historySize', DEFAULT_CONFIG.historySize), 5, 200, DEFAULT_CONFIG.historySize),
    maxInflight: clampInt(readConfig(config, 'maxInflight', DEFAULT_CONFIG.maxInflight), 1, 8, DEFAULT_CONFIG.maxInflight),
    cacheTtlMs: clampInt(readConfig(config, 'cacheTtlMs', DEFAULT_CONFIG.cacheTtlMs), 0, 7 * 24 * 60 * 60 * 1000, DEFAULT_CONFIG.cacheTtlMs),
    cacheEntries: clampInt(readConfig(config, 'cacheEntries', DEFAULT_CONFIG.cacheEntries), 1, 512, DEFAULT_CONFIG.cacheEntries),
    dedupe: readConfig(config, 'dedupe', DEFAULT_CONFIG.dedupe) !== false,
  }

  /** One pending style question, shared by the tool and the panel. */
  const style = createStyleStore()

  /** The engine: the single research service every surface talks to. */
  const engine = createResearchEngine({
    ctx,
    logger: ctx.logger ?? { warn() {}, info() {} },
    config: limits,
    readProjectFacts,
    persistRun: async (run) => {
      const directory = run.project ?? null
      if (directory === null) return
      await recordInMemory(directory, run, run.requirement)
    },
  })

  /** Every requirement the background pass was *deferred* on, newest first. */
  const deferred = []
  const onDeferred = (promise, facts) => {
    const entry = { ...facts, at: Date.now() }
    deferred.unshift(entry)
    if (deferred.length > 20) deferred.pop()
    void promise.then(() => {
      const at = deferred.indexOf(entry)
      if (at !== -1) deferred.splice(at, 1)
    }).catch(() => {})
  }

  installBackgroundPass(ctx, engine, {
    background: limits.background,
    blockMs: limits.blockMs,
    onDeferred,
  })
  installContract(ctx, { maxAngles: limits.maxAngles, background: limits.background })
  installTools(ctx, engine, style, limits, vetTarget)

  /** Deployment-declared authorities, read per request as the service settles late. */
  const trustedHosts = () => {
    const connection = ctx.get?.('connection')
    const list = connection?.trustedHosts
    return Array.isArray(list) ? list.filter((entry) => typeof entry === 'string') : []
  }

  /**
   * The observable snapshot the panel reads: real run state, plus the engine's
   * own cache and capacity facts. No synthetic progress is added here.
   * @returns {object} the snapshot.
   */
  const statusPayload = () => {
    const snapshot = engine.snapshot()
    const project = projectDirectory(ctx, undefined)
    return {
      ok: true,
      version: STATUS_VERSION,
      revision: snapshot.revision,
      background: limits.background,
      limits: {
        maxAngles: limits.maxAngles,
        maxResults: limits.maxResults,
        deadlineMs: limits.deadlineMs,
        blockMs: limits.blockMs,
        maxInflight: limits.maxInflight,
        cacheTtlMs: limits.cacheTtlMs,
      },
      capacity: {
        inflight: engine.inflightCount,
        maxInflight: limits.maxInflight,
        cache: engine.cache.stats(),
      },
      project,
      live: snapshot.live,
      recent: snapshot.recent,
      deferred: deferred.map((entry) => ({ ...entry })),
      style: style.snapshot(),
    }
  }

  ctx.inject(['webServer'], (hostCtx) => {
    const disposers = [
      hostCtx.webServer.register({
        kind: 'exact',
        path: STYLE_PATH,
        handler: async (request, response) => {
          if (request.method === 'GET') {
            sendJson(response, 200, { ok: true, ...style.snapshot() })
            return
          }
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'GET, POST' })
            response.end()
            return
          }
          if (!sameOrigin(request, trustedHosts)) {
            sendJson(response, 403, { ok: false, error: 'untrusted origin' })
            return
          }
          let body
          try {
            body = await readJsonBody(request)
          } catch (error) {
            sendJson(response, 400, { ok: false, error: error.message })
            return
          }
          const outcome = style.answer(typeof body?.choice === 'string' ? body.choice : '')
          sendJson(response, outcome.ok ? 200 : 409, { ...outcome, ...style.snapshot() })
        },
      }),
      hostCtx.webServer.register({
        kind: 'exact',
        path: STYLE_EVENTS_PATH,
        handler: (request, response) => {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          streamRevisions(request, response, styleEvents(style))
        },
      }),
      hostCtx.webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: (request, response) => {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          sendJson(response, 200, statusPayload())
        },
      }),
      hostCtx.webServer.register({
        kind: 'exact',
        path: STATUS_EVENTS_PATH,
        handler: (request, response) => {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          streamRevisions(request, response, engineEvents(engine))
        },
      }),
      hostCtx.webServer.register({
        kind: 'exact',
        path: CONTROL_PATH,
        handler: async (request, response) => {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          if (!sameOrigin(request, trustedHosts)) {
            sendJson(response, 403, { ok: false, error: 'untrusted origin' })
            return
          }
          let body
          try {
            body = await readJsonBody(request)
          } catch (error) {
            sendJson(response, 400, { ok: false, error: error.message })
            return
          }
          const action = typeof body?.action === 'string' ? body.action : ''
          const id = typeof body?.id === 'string' ? body.id : ''
          if (action === 'cancel') {
            const cancelled = engine.cancel(id)
            sendJson(response, cancelled ? 200 : 409, {
              ok: cancelled,
              action,
              id,
              error: cancelled ? undefined : 'no in-flight run with that id',
            })
            return
          }
          if (action === 'rerun') {
            const previous = engine.registry.get(id)
            if (previous === undefined) {
              sendJson(response, 404, { ok: false, error: 'unknown run id' })
              return
            }
            if (!engine.hasCapacity) {
              sendJson(response, 429, { ok: false, error: 'too many runs in flight' })
              return
            }
            // A re-run replays a run that already happened: the requirement it
            // recorded is the request, and the project it ran for is the scope.
            const requeued = engine.research({
              text: previous.requirement,
              requirement: previous.requirement,
              kind: previous.kind,
              label: previous.label,
              domain: previous.domain,
              reasons: ['manual-rerun'],
              redacted: [],
              agentId: previous.agentId,
              parentId: previous.parentId,
              origin: 'panel',
              project: previous.project,
            })
            const completed = await requeued
            sendJson(response, 200, { ok: completed.ok === true, action, id, runId: completed.runId, status: completed.status })
            return
          }
          sendJson(response, 400, { ok: false, error: 'unknown action' })
        },
      }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  })

  // The engine is exposed as a service so a host can drive it directly (tests,
  // another adapter, a future UI) without going through HTTP.
  ctx.provide?.('requirementResearch', engine)
}

/**
 * A revision source over the style store (the store has no subscription, so the
 * stream polls it; a style change is a user-visible event, not a hot path).
 * @param {object} style - the style store.
 * @returns {{ revision: number, subscribe: (listener: () => void) => () => void }} the source.
 */
function styleEvents(style) {
  return {
    get revision() {
      return style.snapshot().revision
    },
    subscribe() {
      return () => {}
    },
  }
}

/**
 * A revision source over the engine's run registry.
 * @param {object} engine - the engine.
 * @returns {{ revision: number, subscribe: (listener: () => void) => () => void }} the source.
 */
function engineEvents(engine) {
  return {
    get revision() {
      return engine.registry.revision
    },
    subscribe(listener) {
      return engine.registry.subscribe(listener)
    },
  }
}

export { buildContract, SECTION_NAME, SECTION_ORDER, formatBriefing, runResearch, normalizeOffer }
