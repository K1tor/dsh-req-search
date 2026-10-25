/**
 * The global research engine.
 *
 * One service, shared by every entry point in the application. The panel is a
 * view of it; the tools call it; the agent loop feeds it work through
 * `agent/pre-step`, which is the single seam *every* agent passes through —
 * the main conversation, a spawned subagent, a forked subagent, a workflow
 * child, a goal round, a scheduled wake, and the headless runner alike.
 *
 * The engine owns:
 *
 *   - classification (is this worth a network round trip at all),
 *   - the plan (which angles, for this kind of work),
 *   - de-duplication (the same ground is not searched twice in a project),
 *   - concurrency limits, cancellation, and the run-level deadline,
 *   - the source -> conclusion -> context pipeline,
 *   - and the durable, observable run record the panel reads.
 *
 * It deliberately does *not* know about HTTP routes, React, or any one agent's
 * prompt. Those are adapters around this object.
 */

import { randomUUID } from 'node:crypto'

import { classifyMessages, inferProjectProfile, sanitizeForResearch } from './classify.js'
import { buildResearchMessage } from './background.js'
import { buildPlan, describePlan } from './strategy.js'
import { formatBriefing as buildBriefing, runResearch } from './providers.js'
import { extractKeywords } from './search.js'
import { BUDGET_DEFAULTS, allocateSearchBudget, decideSearchLevel, observableUsage } from './budget.js'
/** Default engine limits; the plugin config overrides each of them. */
export const ENGINE_DEFAULTS = Object.freeze({
  /** Whether the background pass may run at all. */
  background: true,
  /** Cap on sources kept per angle. */
  maxResults: 8,
  /** Cap on angles per run. */
  maxAngles: 4,
  /** One provider call's budget. */
  timeoutMs: 20000,
  /** Whole-run budget: the background pass never blocks a step longer than this. */
  deadlineMs: 45000,
  /** Angles searched concurrently. */
  concurrency: 3,
  /** Repositories annotated with licence/maintenance facts. */
  enrich: 8,
  /** Keyless Bing fallback after the first two providers fail. */
  fallback: true,
  /** Runs recorded for the panel. */
  historySize: 40,
  /** Runs that may be in flight at once across all agents. */
  maxInflight: 2,
  /** A requirement researched for the same project within this window is reused. */
  cacheTtlMs: 6 * 60 * 60 * 1000,
  /** Most entries kept in the duplicate-key index. */
  cacheEntries: 64,
  /** Whether a run watches for duplicate work from sibling agents. */
  dedupe: true,
  ...BUDGET_DEFAULTS,
})

/**
 * Normalise a requirement into a stable de-duplication key.
 *
 * The key deliberately ignores case, punctuation and filler so that the same
 * request from a parent agent and from its subagent collapses to one research
 * run instead of two. Latin words keep their separating space (dropping it
 * would glue different words together); CJK text does not need one.
 *
 * @param {string} text - the sanitized requirement.
 * @returns {string} the key.
 */
export function researchKey(text) {
  const folded = String(text ?? '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  // Chinese has no spaces: "做一个 管理后台" and "做一个管理后台" are the same key.
  const compacted = folded.replace(/(?<=[\u3400-\u9fff])\s+|\s+(?=[\u3400-\u9fff])/gu, '')
  return compacted.slice(0, 240)
}

/**
 * A bounded LRU cache with a proof-of-freshness stamp.
 *
 * The engine caches whole research results per (project, key) so a subagent
 * that inherits the parent's task reads what the parent already found instead
 * of spending the same network round trips. An entry expires on age, and the
 * caller may additionally invalidate by a *version* string: when project files
 * or dependencies change, `lookup` reports the entry as stale and the next run
 * fetches again.
 *
 * @param {{ limit?: number }} [options] - caps.
 * @returns {object} the cache.
 */
export function createResultCache(options = {}) {
  const limit = Math.max(1, options.limit ?? 64)
  /** @type {Map<string, object>} */
  const entries = new Map()
  let hits = 0
  let misses = 0

  const keyOf = (project, key) => `${project ?? ''}\u0000${key}`

  return {
    /**
     * Read one entry.
     * @param {string | null} project - the project directory.
     * @param {string} key - the research key.
     * @param {{ ttlMs: number, version?: string, now?: number }} policy - freshness policy.
     * @returns {object | undefined} the entry, when still fresh.
     */
    lookup(project, key, policy) {
      const fullKey = keyOf(project, key)
      const entry = entries.get(fullKey)
      if (entry === undefined) {
        misses += 1
        return undefined
      }
      const now = policy.now ?? Date.now()
      const stale = now - entry.at > Math.max(0, policy.ttlMs)
      const versionChanged = policy.version !== undefined && entry.version !== policy.version
      const needsFreshEvidence = policy.level !== undefined && (entry.run.level ?? 0) < policy.level
      if (stale || versionChanged || needsFreshEvidence) {
        entries.delete(fullKey)
        misses += 1
        // Reporting the entry as stale is not the same as serving it: the
        // caller must fetch again, and the record says why.
        return { stale: true, reason: stale ? 'expired' : versionChanged ? 'project-changed' : 'deeper-search-required', previous: entry.run }
      }
      // Refresh recency: delete + set moves the key to the young end.
      entries.delete(fullKey)
      entries.set(fullKey, entry)
      hits += 1
      return entry
    },
    /**
     * Store one entry, evicting the oldest when full.
     * @param {string | null} project - the project directory.
     * @param {string} key - the research key.
     * @param {object} run - the completed run record.
     * @param {{ version?: string, now?: number }} [meta] - freshness metadata.
     */
    store(project, key, run, meta = {}) {
      const fullKey = keyOf(project, key)
      entries.delete(fullKey)
      entries.set(fullKey, { run, at: meta.now ?? Date.now(), version: meta.version, level: meta.level ?? run.level ?? 0 })
      while (entries.size > limit) {
        const oldest = entries.keys().next()
        if (oldest.done === true) break
        entries.delete(oldest.value)
      }
    },
    /** Drop everything (used when a project is deleted or research is disabled). */
    clear() {
      entries.clear()
    },
    /** @returns {{ size: number, hits: number, misses: number }} cache statistics. */
    stats() {
      return { size: entries.size, hits, misses }
    },
  }
}

/**
 * The run registry: live and recent research runs, the state the panel reads.
 *
 * Every fact in here is produced by an actual run — there is no synthetic
 * progress. A run moves through `queued` → `classifying` → `running` →
 * (`done` | `failed` | `cancelled` | `skipped` | `timeout`), records each
 * phase with a timestamp, and keeps its sources, its conclusions and the
 * exact text handed to the agent.
 *
 * @param {{ historySize?: number }} [options] - caps.
 * @returns {object} the registry.
 */
export function createRunRegistry(options = {}) {
  const historySize = Math.max(1, options.historySize ?? 40)
  /** @type {Map<string, object>} */
  const live = new Map()
  /** @type {object[]} */
  let recent = []
  let revision = 0
  const listeners = new Set()

  const notify = () => {
    revision += 1
    for (const listener of [...listeners]) {
      try {
        listener(revision)
      } catch {
        // A broken observer must never break a run.
      }
    }
  }

  /**
   * Copy one run for a reader, dropping the live-only internals.
   * @param {object} run - the run.
   * @returns {object} a detached snapshot.
   */
  const snapshotRun = (run) => ({
    id: run.id,
    status: run.status,
    kind: run.kind,
    label: run.label,
    domain: run.domain,
    requirement: run.requirement,
    ok: run.ok,
    reasons: [...run.reasons],
    redacted: [...run.redacted],
    level: run.level,
    levelName: run.levelName,
    budget: run.budget === undefined ? undefined : { ...run.budget },
    usage: run.usage === undefined ? undefined : { ...run.usage },
    stopped: run.stopped,
    agentId: run.agentId,
    parentId: run.parentId,
    origin: run.origin,
    project: run.project,
    plan: run.plan === undefined ? undefined : { ...run.plan, angles: run.plan.angles.map((angle) => ({ ...angle })) },
    phases: run.phases.map((phase) => ({ ...phase })),
    angles: run.angles.map((angle) => ({ ...angle, sources: angle.sources.map((source) => ({ ...source })) })),
    sources: run.sources.map((source) => ({ ...source })),
    failures: run.failures.map((failure) => ({ ...failure })),
    conclusions: [...run.conclusions],
    briefing: run.briefing,
    injected: run.injected === true,
    cached: run.cached === true,
    duplicateOf: run.duplicateOf,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.finishedAt === undefined ? undefined : run.finishedAt - run.startedAt,
    checks: [...run.checks],
  })

  return {
    /**
     * Open one run.
     * @param {object} seed - the run's initial facts.
     * @returns {object} the live run handle.
     */
    open(seed) {
      const run = {
        id: `research-${randomUUID().slice(0, 8)}`,
        status: 'queued',
        kind: seed.kind ?? 'feature',
        label: seed.label ?? 'task',
        domain: seed.domain ?? 'generic',
        requirement: seed.requirement ?? '',
        ok: seed.ok,
        reasons: Array.isArray(seed.reasons) ? seed.reasons : [],
        redacted: Array.isArray(seed.redacted) ? seed.redacted : [],
        level: seed.level,
        levelName: seed.levelName,
        budget: seed.budget,
        usage: seed.usage,
        stopped: undefined,
        agentId: seed.agentId,
        parentId: seed.parentId,
        origin: seed.origin ?? 'agent',
        project: seed.project ?? null,
        plan: undefined,
        phases: [],
        angles: [],
        sources: [],
        failures: [],
        conclusions: [],
        briefing: '',
        injected: false,
        cached: false,
        duplicateOf: undefined,
        startedAt: Date.now(),
        finishedAt: undefined,
        checks: [],
      }
      live.set(run.id, run)
      notify()
      return {
        /** The run's identity. */
        id: run.id,
        /**
         * Set the status.
         * @param {string} status - the new status.
         * @param {object} [extra] - facts to merge.
         */
        setStatus(status, extra = {}) {
          run.status = status
          Object.assign(run, extra)
          if (status !== 'running' && status !== 'queued' && run.finishedAt === undefined) run.finishedAt = Date.now()
          notify()
        },
        /**
         * Record one phase transition with a timestamp and optional detail.
         * @param {string} name - the phase name.
         * @param {string} state - `running` | `done` | `failed` | `skipped`.
         * @param {object} [detail] - extra facts.
         */
        phase(name, state, detail = {}) {
          run.phases.push({ name, state, at: Date.now(), ...detail })
          if (state === 'failed') run.failures.push({ phase: name, ...detail })
          notify()
        },
        /**
         * Merge research facts into the run.
         * @param {object} result - the research result.
         */
        attach(result) {
          run.domain = result.domain ?? run.domain
          run.angles = result.angles ?? []
          run.sources = result.sources ?? []
          notify()
        },
        /**
         * Record one conclusion handed to the agent.
         * @param {string} conclusion - one line of conclusion.
         */
        conclude(conclusion) {
          run.conclusions.push(conclusion)
          notify()
        },
        /** @returns {object} the live run, for internal mutation by the engine. */
        get current() {
          return run
        },
      }
    },
    /**
     * Close one run: move it from live to recent.
     * @param {string} id - the run id.
     */
    close(id) {
      const run = live.get(id)
      if (run === undefined) return
      live.delete(id)
      if (run.finishedAt === undefined) run.finishedAt = Date.now()
      recent = [run, ...recent].slice(0, historySize)
      notify()
    },
    /**
     * Read the current state.
     * @returns {{ revision: number, live: object[], recent: object[] }} the state.
     */
    snapshot() {
      return {
        revision,
        live: [...live.values()].map(snapshotRun),
        recent: recent.map(snapshotRun),
      }
    },
    /**
     * Read one run by id.
     * @param {string} id - the run id.
     * @returns {object | undefined} the run snapshot.
     */
    get(id) {
      const run = live.get(id) ?? recent.find((entry) => entry.id === id)
      return run === undefined ? undefined : snapshotRun(run)
    },
    /**
     * Merge facts into one recorded run (used to mark the run as delivered to
     * the agent after the message has actually entered the step).
     * @param {string} id - the run id.
     * @param {object} patch - the facts to merge.
     * @returns {boolean} whether the run existed.
     */
    mark(id, patch) {
      const run = live.get(id) ?? recent.find((entry) => entry.id === id)
      if (run === undefined) return false
      Object.assign(run, patch)
      notify()
      return true
    },
    /**
     * Observe revision changes.
     * @param {(revision: number) => void} listener - the observer.
     * @returns {() => void} the disposer.
     */
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** @returns {number} the current revision. */
    get revision() {
      return revision
    },
  }
}

/**
 * Turn a research result into the conclusions the agent should act on.
 *
 * This is the step the task asked for explicitly: research must not arrive as
 * a report. Each line here is an actionable reading of the material — licence
 * and maintenance verdicts decide adopt-versus-borrow, and repeated angles mean
 * the topic is load-bearing — so the briefing can be folded into a decision
 * instead of being summarised to the user.
 *
 * @param {object} result - output of the research pipeline.
 * @param {{ maxLines?: number }} [options] - caps.
 * @returns {string[]} the conclusions.
 */
export function deriveConclusions(result, options = {}) {
  const maxLines = Math.max(1, options.maxLines ?? 6)
  const conclusions = []
  if (result?.ok !== true) return conclusions

  const byLicense = new Map()
  for (const source of result.sources ?? []) {
    const meta = source.meta
    if (meta === undefined || typeof meta !== 'object') continue
    const key = meta.license ?? 'unknown licence'
    if (!byLicense.has(key)) byLicense.set(key, [])
    byLicense.get(key).push(source)
  }
  const permissive = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Unlicense', 'MPL-2.0']
  const adoptable = [...byLicense.entries()].filter(([license]) =>
    permissive.some((entry) => license.toLowerCase().startsWith(entry.toLowerCase())),
  )
  const risky = [...byLicense.entries()].filter(([license]) => !permissive.some((entry) =>
    license.toLowerCase().startsWith(entry.toLowerCase()),
  ))
  const stale = (result.sources ?? []).filter((source) => source.meta?.archived === true)

  if (adoptable.length > 0) {
    const names = adoptable.flatMap(([, list]) => list.map((source) => source.title ?? source.url)).slice(0, 3)
    conclusions.push(`Adoptable references (permissive licence): ${names.join('; ')}.`)
  }
  if (risky.length > 0) {
    const names = risky.flatMap(([, list]) => list.map((source) => source.title ?? source.url)).slice(0, 3)
    conclusions.push(`Borrow the design, not the code, from: ${names.join('; ')} — licence unknown or restrictive: check with vet_dependency first.`)
  }
  if (stale.length > 0) {
    conclusions.push(`Archived projects in the results: ${stale.map((source) => source.title ?? source.url).slice(0, 3).join('; ')} — treat their patterns as historical, not current practice.`)
  }
  const shared = (result.sources ?? []).filter((source) => (source.angles ?? []).length > 1)
  if (shared.length > 0) {
    conclusions.push(`Sources matched by several angles (load-bearing): ${shared.map((source) => source.title ?? source.url).slice(0, 3).join('; ')}.`)
  }
  for (const angle of result.angles ?? []) {
    if (conclusions.length >= maxLines) break
    if (angle.sources.length === 0) continue
    const first = angle.sources[0]
    conclusions.push(`${angle.purpose ?? angle.id}: ${first.title ?? first.url}.`)
  }
  if ((result.notes ?? []).length > 0) {
    conclusions.push(`Providers that failed this run: ${result.notes.join(' ')} — treat the briefing as partial, not as "nothing exists".`)
  }
  return conclusions.slice(0, maxLines)
}

/**
 * Create the global research engine.
 *
 * @param {object} deps - the engine's dependencies.
 * @param {object} deps.ctx - the plugin context (for `web`, `deepseekAccount`).
 * @param {object} [deps.logger] - a logger with `warn`/`info`.
 * @param {object} [deps.config] - resolved limits.
 * @param {() => Promise<object>} [deps.readProjectFacts] - reads manifest names and directory entries only.
 * @param {(run: object) => Promise<void>} [deps.persistRun] - durable record hook.
 * @returns {object} the engine.
 */
export function createResearchEngine(deps) {
  const { ctx } = deps
  const limits = { ...ENGINE_DEFAULTS, ...(deps.config ?? {}) }
  const logger = deps.logger ?? { warn() {}, info() {} }
  const registry = createRunRegistry({ historySize: limits.historySize })
  const cache = createResultCache({ limit: limits.cacheEntries })
  const inflight = new Set()
  /** @type {Map<string, Promise<object>>} */
  const pending = new Map()
  const cancelled = new Set()
  const activeControllers = new Map()

  const projectFacts = async (project) => {
    if (project === null || project === undefined || typeof deps.readProjectFacts !== 'function') {
      return { existingProject: false, stack: [], languages: [], signals: [], version: undefined, manifest: {}, files: [] }
    }
    try {
      const facts = await deps.readProjectFacts(project)
      return { ...inferProjectProfile(facts), version: facts.version, manifest: facts.manifest ?? {}, files: facts.files ?? [] }
    } catch (error) {
      logger.warn('req-search: project facts unavailable: %o', error)
      return { existingProject: false, stack: [], languages: [], signals: [], version: undefined, manifest: {}, files: [] }
    }
  }

  /**
   * Run one research pass, sharing work with any identical run already in
   * flight. The returned promise always resolves (never rejects): research is
   * an enhancement, so its failure is data, not an exception.
   *
   * @param {object} request - what to research.
   * @returns {Promise<object>} the completed run.
   */
  const run = async (request) => {
    const key = researchKey(request.text)
    const dedupeKey = `${request.project ?? ''}\u0000${request.level ?? 'auto'}\u0000${key}`
    if (limits.dedupe && pending.has(dedupeKey)) {
      // Another agent is already researching this exact task in this project.
      // Share its retrieval, but still record that this agent was served — the
      // panel must show every delivery, and "one search, two agents" is the
      // truth worth showing.
      const shared = await pending.get(dedupeKey)
      const handle = registry.open({
        kind: request.kind,
        label: request.label,
        domain: shared.domain ?? request.domain,
        requirement: request.text,
        reasons: [...(request.reasons ?? []), 'shared-with-inflight-run'],
        redacted: request.redacted,
        agentId: request.agentId,
        parentId: request.parentId,
        origin: request.origin,
        project: request.project ?? null,
        ok: shared.ok === true,
        level: shared.level,
        levelName: shared.levelName,
        budget: shared.budget,
        usage: shared.usage,
      })
      handle.phase('dedupe', 'done', { sharedWith: shared.runId })
      handle.attach({
        domain: shared.domain ?? request.domain,
        angles: shared.angles ?? [],
        sources: shared.sources ?? [],
      })
      // The shared run's plan is unknown to the engine at this point (it is the
      // *other* run's object), so the record exposes the angles it actually
      // received rather than inventing a plan it never built.
      handle.current.plan = {
        kind: request.kind,
        domain: shared.domain ?? request.domain,
        language: shared.language ?? 'en',
        keywords: shared.keywords ?? [],
        angles: (shared.angles ?? []).map((angle) => ({
          id: angle.id,
          purpose: angle.purpose,
          query: angle.query,
        })),
      }
      for (const conclusion of shared.conclusions ?? []) handle.conclude(conclusion)
      handle.setStatus(shared.ok === true ? 'done' : 'failed', {
        ok: shared.ok === true,
        cached: true,
        duplicateOf: shared.runId,
        briefing: shared.briefing ?? '',
      })
      registry.close(handle.current.id)
      return {
        ...shared,
        runId: handle.current.id,
        duplicateOf: shared.runId,
        cached: true,
        sharedWith: 'inflight',
      }
    }
    const execution = execute({ ...request, key })
    if (limits.dedupe) pending.set(dedupeKey, execution)
    try {
      return await execution
    } finally {
      if (limits.dedupe) pending.delete(dedupeKey)
    }
  }

  /**
   * Execute one run to completion, recording every phase.
   * @param {object} request - the run facts.
   * @returns {Promise<object>} the completed run.
   */
  const execute = async (request) => {
    const project = request.project ?? null
    const facts = await projectFacts(project)
    const decision = request.level === undefined
      ? decideSearchLevel({ ...request, shouldResearch: true }, facts, limits)
      : { level: request.level, name: request.levelName ?? `level-${request.level}`, reasons: request.reasons ?? [] }
    const budget = allocateSearchBudget(decision.level, limits, request)
    const handle = registry.open({
      level: decision.level,
      levelName: decision.name,
      budget,
      kind: request.kind,
      label: request.label,
      domain: request.domain,
      requirement: request.text,
      reasons: request.reasons,
      redacted: request.redacted,
      agentId: request.agentId,
      parentId: request.parentId,
      origin: request.origin,
      project,
    })
    const current = handle.current
    const signal = request.signal
    try {
      handle.setStatus('classifying')
      handle.phase('classify', 'done', { kind: request.kind, level: decision.level, reasons: decision.reasons })
      if (decision.level === 0) {
        handle.setStatus('skipped', { ok: false })
        registry.close(current.id)
        return { ok: false, skipped: true, runId: current.id, level: 0, angles: [], sources: [], notes: ['no-search-value'] }
      }

      // A repeat of the same task in the same project within the TTL is served
      // from the cache: a subagent inheriting the parent's work must not search
      // the same ground again.
      const cached = cache.lookup(project, researchKey(request.text), {
        ttlMs: limits.cacheTtlMs,
        version: facts.version ?? request.projectVersion,
        level: decision.level,
      })
      if (cached !== undefined && cached.stale !== true) {
        handle.phase('cache', 'done', { source: 'cache' })
        handle.setStatus('done', { ok: true, cached: true, briefing: cached.run.briefing, injected: false })
        current.angles = cached.run.angles ?? []
        current.sources = cached.run.sources ?? []
        current.conclusions = cached.run.conclusions ?? []
        current.usage = cached.run.usage
        current.stopped = 'cache-hit'
        current.ok = true
        // A cached run reuses the plan that produced it; recording a fabricated
        // one would make the panel show angles that never ran.
        if (cached.run.plan !== undefined) current.plan = cached.run.plan
        if (deps.persistRun !== undefined) await deps.persistRun(current)
        registry.close(current.id)
        return { ...cached.run, runId: current.id, cached: true }
      }
      if (cached?.stale === true) handle.phase('cache', 'skipped', { reason: cached.reason })
      else handle.phase('cache', 'skipped', { reason: 'miss' })

      const plan = buildPlan(
        {
          kind: request.kind,
          domain: request.domain,
          keywords: Array.isArray(request.keywords) && request.keywords.length > 0
            ? request.keywords
            : extractKeywords(request.text, 6),
          language: request.language ?? (/[\u3400-\u9fff]/u.test(request.text) ? 'zh' : 'en'),
          project: facts,
          requirement: request.text,
        },
        {
          maxAngles: budget.maxAngles,
          officialFirst: decision.reasons.includes('current-official-facts-required'),
        },
      )
      current.plan = plan
      handle.phase('plan', 'done', { summary: describePlan(plan) })
      if (signal?.aborted === true) {
        handle.setStatus('cancelled', { ok: false })
        registry.close(current.id)
        return { ok: false, cancelled: true, runId: current.id, angles: [], sources: [], notes: ['cancelled'] }
      }

      // The background pass is bounded: a slow network must never hold a step
      // open indefinitely. The deadline races the whole retrieval, not each
      // provider (providers already have their own per-call budget).
      handle.setStatus('running')
      inflight.add(current.id)
      const controller = new AbortController()
      activeControllers.set(current.id, controller)
      cancelled.delete(current.id)
      let timedOut = false
      const deadline = setTimeout(() => {
        timedOut = true
        controller.abort(new Error('research deadline exceeded'))
      }, budget.deadlineMs)
      const fused = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
      let result
      try {
        result = await runResearch(ctx, request.text, {
          ...budget,
          fallback: limits.fallback,
          angleCeiling: limits.maxAngles,
          angles: plan.angles,
          keywords: plan.keywords,
          domain: plan.domain,
          language: plan.language,
          signal: fused,
          onPhase: (name, state, detail) => handle.phase(name, state, detail),
        })
      } finally {
        clearTimeout(deadline)
        activeControllers.delete(current.id)
        inflight.delete(current.id)
      }

      handle.attach(result)
      current.stopped = result.stopped
      const notes = [...(result.notes ?? [])]
      const cancelledNow = signal?.aborted === true || cancelled.delete(current.id)
      if (cancelledNow) {
        handle.setStatus('cancelled', { ok: false })
        handle.phase('retrieve', 'failed', { reason: 'cancelled' })
        registry.close(current.id)
        return { ...result, ok: false, cancelled: true, runId: current.id, notes }
      }
      const status = result.ok === true ? 'done' : timedOut ? 'timeout' : 'failed'
      const conclusions = deriveConclusions(result)
      for (const line of conclusions) handle.conclude(line)
      const briefing = buildBriefing(result, {
        contextChars: budget.contextChars,
        snippetChars: budget.maxSourceChars,
        conclusions,
      })
      const usage = observableUsage({ ...result, briefing })
      handle.setStatus(status, { ok: result.ok === true, briefing, usage })
      handle.phase('conclude', 'done', { count: conclusions.length, usage })
      if (result.ok === true) {
        cache.store(project, researchKey(request.text), {
          ...result,
          level: decision.level,
          levelName: decision.name,
          budget,
          usage,
          briefing,
          conclusions,
          plan,
          language: plan.language,
          keywords: plan.keywords,
        }, {
          version: facts.version ?? request.projectVersion,
          level: decision.level,
        })
      } else {
        handle.phase('degrade', 'done', { notes })
      }
      if (deps.persistRun !== undefined) {
        try {
          await deps.persistRun(handle.current)
        } catch (error) {
          logger.warn('req-search: recording the run failed: %o', error)
        }
      }
      registry.close(current.id)
      return { ...result, runId: current.id, status, conclusions, briefing, level: decision.level, levelName: decision.name, budget, usage }
    } catch (error) {
      logger.warn('req-search: research failed: %o', error)
      handle.setStatus('failed', { ok: false, briefing: '' })
      handle.phase('error', 'failed', { reason: String(error?.message ?? error).slice(0, 160) })
      registry.close(current.id)
      return { ok: false, runId: current.id, angles: [], sources: [], notes: ['research-failed'], error: String(error?.message ?? error) }
    }
  }

  return {
    limits,
    registry,
    cache,
    /** @returns {number} how many runs are in flight. */
    get inflightCount() {
      return inflight.size
    },
    /** @returns {boolean} whether another run may start. */
    get hasCapacity() {
      return inflight.size < limits.maxInflight
    },
    /**
     * Research one task in the background (the common path). Resolves with the
     * completed run; never rejects.
     * @param {object} request - the run facts.
     * @returns {Promise<object>} the run.
     */
    research(request) {
      return run(request)
    },
    /**
     * Research and render the agent-facing message in one step.
     * @param {object} request - the run facts.
     * @returns {Promise<{ run: object, message: object | undefined }>} the run and its message.
     */
    async researchInto(request) {
      const completed = await run(request)
      if (completed.ok !== true) return { run: completed, message: undefined }
      const message = buildResearchMessage(
        {
          ...completed,
          conclusions: completed.conclusions ?? [],
          contextChars: completed.budget?.contextChars,
          maxSourceChars: completed.budget?.maxSourceChars,
          runId: completed.runId,
        },
        request.text,
      )
      return { run: completed, message }
    },
    /**
     * Cancel one run.
     * @param {string} id - the run id.
     * @returns {boolean} whether a live run was marked.
     */
    cancel(id) {
      if (!inflight.has(id)) return false
      cancelled.add(id)
      activeControllers.get(id)?.abort(new Error('research run cancelled'))
      return true
    },
    /**
     * Clear the cached result for one key, forcing the next run to fetch.
     * @param {string | null} project - the project directory.
     * @param {string} text - the requirement text.
     */
    invalidate(project, text) {
      cache.lookup(project, researchKey(text), { ttlMs: 0 })
    },
    /**
     * Classify a set of claimed messages (exposed for adapters and tests).
     * @param {Array<object>} messages - claimed messages.
     * @returns {object} the classification.
     */
    classify(messages) {
      return classifyMessages(messages)
    },
    /** @returns {{ revision: number, live: object[], recent: object[] }} the observable state. */
    snapshot() {
      return registry.snapshot()
    },
    /**
     * Clear every cached result (used when a project is deleted).
     */
    clearCache() {
      cache.clear()
    },
    /**
     * Redact a candidate text without running research (used by the panel's
     * re-run control and by tests).
     * @param {string} text - raw text.
     * @returns {{ text: string, redacted: string[] }} the sanitized text.
     */
    sanitize(text) {
      return sanitizeForResearch(text)
    },
  }
}
