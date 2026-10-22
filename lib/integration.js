/**
 * Wiring the global engine into DSH's shared execution layer.
 *
 * There is exactly one seam that every agent in the harness passes through
 * before a model step: the `agent/pre-step` waterfall. The main conversation,
 * a spawned subagent, a forked subagent, a workflow child, a goal round, a
 * scheduled wake and the headless runner are all `AgentLoop` instances, and
 * `AgentLoop.preStep` dispatches that waterfall for each of them. A listener
 * registered on the plugin's root context is untagged, so scope filtering
 * delivers every agent's events to it.
 *
 * That is where this module hooks. It adds no page-specific logic and no
 * per-entry-point integration: the decision of *whether* a turn deserves
 * research is made by the engine, and the only per-agent state kept here is
 * "what this session was already told".
 *
 * The hook is bounded on purpose. The step waits at most `blockMs` for the
 * research; if it is still running, the step proceeds and the result is
 * steered into the *next* step through `agent.inject()`. A research run can
 * therefore never hold a turn open indefinitely, and a failed run leaves the
 * turn exactly as the host composed it.
 */

import { randomUUID } from 'node:crypto'

import { buildContract, SECTION_NAME, SECTION_ORDER } from './contract.js'
import { tool } from './tool.js'
import { MEMORY_FILENAME, appendMemory, formatMemoryNote, memoryBody, memoryTitle, parseMemory } from './memory.js'
import { normalizeOffer } from './style-store.js'
import { ENGINE_DEFAULTS } from './engine.js'

/** Run origins the integration reports to the engine. */
const ORIGIN_MAIN = 'main'
const ORIGIN_SUBAGENT = 'subagent'

/**
 * Read the facts about a project that decide what research is worth doing.
 *
 * Only *names* are read: directory entries, a manifest's `name`/`dependencies`
 * keys, and a cheap version stamp from file metadata. No source file is opened
 * and no file content leaves the process. The stamp changes when a manifest or
 * lockfile changes, which is what invalidates a cached research result.
 *
 * @param {string} directory - absolute project directory.
 * @returns {Promise<{ files: string[], manifest: object, dependencyNames: string[], version: string }>} the facts.
 */
export async function readProjectFacts(directory) {
  const { readdir, readFile, stat } = await import('node:fs/promises')
  const { join } = await import('node:path')
  let files = []
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    files = entries.map((entry) => entry.name).slice(0, 200)
  } catch {
    return { files: [], manifest: {}, dependencyNames: [], version: '' }
  }

  let manifest = {}
  const dependencyNames = []
  const stampParts = []
  for (const candidate of ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'requirements.txt', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']) {
    if (!files.includes(candidate)) continue
    try {
      const info = await stat(join(directory, candidate))
      stampParts.push(`${candidate}:${info.size}:${Math.floor(info.mtimeMs)}`)
    } catch {
      // A file that vanished between listing and stat is simply not stamped.
    }
  }
  if (files.includes('package.json')) {
    try {
      const raw = await readFile(join(directory, 'package.json'), 'utf8')
      const parsed = JSON.parse(raw.slice(0, 200_000))
      if (typeof parsed === 'object' && parsed !== null) {
        manifest = {
          name: typeof parsed.name === 'string' ? parsed.name : undefined,
          version: typeof parsed.version === 'string' ? parsed.version : undefined,
          dependencies: typeof parsed.dependencies === 'object' && parsed.dependencies !== null ? parsed.dependencies : {},
          devDependencies: typeof parsed.devDependencies === 'object' && parsed.devDependencies !== null ? parsed.devDependencies : {},
        }
        dependencyNames.push(...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {}))
      }
    } catch {
      // An unreadable manifest leaves the project unclassified, never fails.
    }
  }
  try {
    if ((await stat(join(directory, '.git'))).isDirectory()) files.push('.git')
  } catch {
    // Not a git project; nothing to record.
  }
  return {
    files,
    manifest,
    dependencyNames: dependencyNames.slice(0, 200),
    version: stampParts.join('|'),
  }
}

/**
 * Read the project memory file.
 * @param {string} directory - the project directory.
 * @returns {Promise<string>} the file body, or an empty string when absent.
 */
async function readMemoryFile(directory) {
  try {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    return await readFile(join(directory, MEMORY_FILENAME), 'utf8')
  } catch {
    return ''
  }
}

/**
 * Write the project memory file, creating its directory when needed.
 * @param {string} directory - the project directory.
 * @param {string} body - the new file body.
 * @returns {Promise<boolean>} true when the file was written.
 */
async function writeMemoryFile(directory, body) {
  try {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { dirname, join } = await import('node:path')
    const path = join(directory, MEMORY_FILENAME)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the project directory the current agent is working in.
 *
 * The working-directory service owns the effective directory for a session, so
 * it is the authority here; the process directory is the fallback for a host
 * that mounts no such service.
 *
 * @param {object} ctx - plugin context.
 * @param {object} [agent] - the agent, when there is one.
 * @returns {string | null} an absolute directory, or null when there is none.
 */
export function projectDirectory(ctx, agent) {
  const working = ctx.get?.('workingDirectory')
  const session = agent?.session
  if (working !== undefined && typeof working.get === 'function' && session !== undefined) {
    try {
      const directory = working.get(session)
      if (typeof directory === 'string' && directory.length > 0) return directory
    } catch {
      // A session without a recorded directory falls through to the default.
    }
  }
  if (working !== undefined && typeof working.defaultDirectory === 'string' && working.defaultDirectory.length > 0) {
    return working.defaultDirectory
  }
  return typeof process.cwd() === 'string' ? process.cwd() : null
}

/**
 * Describe one agent's position in the delegation tree.
 *
 * A subagent inherits its parent's project but not its context, so the engine
 * needs to know that a turn came from a child: the panel shows it, and the
 * duplicate check may share the parent's result instead of searching again.
 *
 * @param {object} agent - the agent, when the host supplied one.
 * @returns {{ origin: string, parentId: string | undefined, depth: number }} the position.
 */
export function describeAgentOrigin(agent) {
  const header = agent?.session?.header
  if (header === undefined || header === null) return { origin: ORIGIN_MAIN, parentId: undefined, depth: 0 }
  const depth = Number.isSafeInteger(header.delegationDepth) ? header.delegationDepth : 0
  const origin = depth > 0 || header.origin === 'subagent' || typeof header.parentSession === 'string' ? ORIGIN_SUBAGENT : ORIGIN_MAIN
  return {
    origin,
    parentId: typeof header.parentSession === 'string' ? header.parentSession : undefined,
    depth,
  }
}

/**
 * Record one research run in the project memory file.
 *
 * The memory is an optimisation and a hand-editable note: a failure to write
 * it changes nothing about the research the agent already received.
 *
 * @param {string | null} directory - the project directory.
 * @param {object} run - the completed run record (it carries `requirement`).
 * @param {string} [requirement] - the requirement, when the caller has it separately.
 * @returns {Promise<boolean>} true when the note was written.
 */
export async function recordInMemory(directory, run, requirement) {
  if (directory === null || run?.ok !== true) return false
  try {
    const body = memoryBody({ domain: run.domain, angles: run.angles })
    if (body.length === 0) return false
    const title = memoryTitle(requirement ?? run.requirement ?? '')
    if (title.length === 0) return false
    const current = await readMemoryFile(directory)
    const next = appendMemory(current, { title, body })
    return await writeMemoryFile(directory, next)
  } catch {
    return false
  }
}

/**
 * Mount the background research pass on `agent/pre-step`.
 *
 * The listener is registered on the plugin's root context, untagged, so every
 * agent the harness creates dispatches to it. Two guards keep it honest:
 *
 *   - Only *claimed* user messages are classified. A step entered by tool
 *     results or by the goal driver carries no requirement and costs nothing.
 *   - Each agent remembers which requirements it was already told about, so a
 *     long turn never receives the same briefing twice.
 *
 * @param {object} ctx - plugin context.
 * @param {object} engine - the research engine.
 * @param {object} [options] - integration limits.
 * @param {number} [options.blockMs] - how long a step may wait for research.
 * @param {boolean} [options.background] - whether the pass runs at all.
 * @param {(run: object) => void} [options.onInjected] - observer for the panel.
 * @returns {() => void} the disposer.
 */
export function installBackgroundPass(ctx, engine, options = {}) {
  const blockMs = Math.max(250, options.blockMs ?? 12_000)
  const enabled = options.background !== false
  /** @type {WeakMap<object, Set<string>>} */
  const told = new WeakMap()
  /** @type {Map<string, Set<string>>} session-id fallback for hosts with no agent object. */
  const toldBySession = new Map()

  /**
   * Read (and create) the set of requirement keys already delivered to one agent.
   * @param {object} agent - the agent.
   * @returns {Set<string>} the delivered keys.
   */
  const delivered = (agent) => {
    if (agent !== undefined && agent !== null) {
      let set = told.get(agent)
      if (set === undefined) {
        set = new Set()
        told.set(agent, set)
      }
      return set
    }
    const id = agent?.session?.id ?? 'anonymous'
    let set = toldBySession.get(id)
    if (set === undefined) {
      set = new Set()
      toldBySession.set(id, set)
    }
    return set
  }

  const dispose = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!enabled) return decision
    if (decision?.kind === 'reject') return decision
    const signal = payload?.signal
    if (signal?.aborted === true) return decision
    const messages = Array.isArray(payload?.messages) ? payload.messages : []
    if (messages.length === 0) return decision

    // Only a real user/agent request is classified: the research message this
    // plugin injects is a `user` message too, so it must be excluded explicitly
    // or a resumed session would research its own briefing.
    const claimed = messages.filter((message) => {
      const kind = message?.source?.kind
      return kind !== 'dsh-req-search' && kind !== 'dsh-research'
    })
    if (claimed.length === 0) return decision

    const classified = engine.classify(claimed)
    if (classified.shouldResearch !== true) {
      return decision
    }

    const agent = payload?.agent
    const deliveredKeys = delivered(agent)
    if (deliveredKeys.has(classified.sanitized)) return decision
    if (!engine.hasCapacity) return decision

    const origin = describeAgentOrigin(agent)
    const directory = projectDirectory(ctx, agent)
    const request = {
      text: classified.sanitized,
      // `requirement` is the *unsanitized* text kept for the run record and the
      // project memory; `text` is what goes to a provider. Keeping the original
      // for display is why the panel can show what the user actually typed
      // while the query itself carries none of its secrets.
      requirement: classified.text,
      kind: classified.kind,
      label: classified.label,
      // The *domain* decides the vocabulary of the queries; the *kind* decides
      // which questions are asked. Reporting the kind as the domain was the
      // reason every task searched with generic phrasing.
      domain: classified.domain,
      reasons: classified.reasons,
      redacted: classified.redacted,
      agentId: agent?.session?.id,
      parentId: origin.parentId,
      origin: origin.origin,
      project: directory,
      signal,
    }

    const pending = engine.researchInto(request)
    let run
    try {
      run = await Promise.race([
        pending,
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(undefined), blockMs)
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve(undefined)
          }, { once: true })
        }),
      ])
    } catch {
      return decision
    }

    if (run === undefined) {
      // The step must not wait forever. The run continues; its result is
      // steered into the next step once it lands, and is never presented as if
      // it had been available for this one.
      options.onDeferred?.(pending, { agentId: agent?.session?.id })
      void pending.then(async (late) => {
        if (late?.message === undefined) return
        if (signal?.aborted === true) return
        try {
          deliveredKeys.add(classified.sanitized)
          if (late.run?.runId !== undefined) engine.registry.mark(late.run.runId, { injected: true, deferred: true })
          const live = agent
          if (live !== undefined && typeof live.inject === 'function' && live.status === 'running') live.inject(late.message)
          else if (live !== undefined && typeof live.steer === 'function') live.steer(late.message)
          options.onInjected?.({ run: late.run, late: true })
        } catch {
          // A run that finished too late is simply not delivered.
        }
      }).catch(() => {})
      return decision
    }

    if (run.message === undefined) return decision
    deliveredKeys.add(classified.sanitized)
    if (run.run?.runId !== undefined) engine.registry.mark(run.run.runId, { injected: true })
    options.onInjected?.({ run: run.run, late: false })
    void recordInMemory(directory, run.run, classified.text)
    // The message joins the step the agent is about to take, so the result is
    // part of the context it actually reasons over.
    return { ...decision, messages: [...decision.messages, run.message] }
  })

  return dispose
}

/**
 * Register the model-facing tools: research on demand, dependency vetting,
 * project recall, and the style decision.
 *
 * @param {object} ctx - plugin context.
 * @param {object} engine - the research engine.
 * @param {object} style - the shared style-question store.
 * @param {object} limits - resolved limits.
 * @param {(target: string, options?: object) => Promise<object>} vetTarget - the dependency checker.
 * @returns {() => void} the disposer.
 */
export function installTools(ctx, engine, style, limits, vetTarget) {
  const disposers = []
  disposers.push(ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register(tool({
      name: 'research_requirement',
      description: 'Research a project requirement on the web before building it: comparable work, open-source implementations, mechanics, and known pitfalls. Returns a compact briefing to fold into the implementation. Use it whenever a requirement names a product, genre, or technology you would otherwise guess about.',
      parameters: {
        requirement: {
          type: 'string',
          required: true,
          description: 'What the user wants built, in their words.',
        },
        focus: {
          type: 'string',
          description: 'Optional extra direction, such as "economy balance" or "Godot only".',
        },
        maxAngles: {
          type: 'integer',
          description: `How many research angles to run, 1-${limits.maxAngles}. Defaults to the deployment value.`,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'domain', 'keywords', 'briefing', 'sourceCount', 'notes'],
          properties: {
            ok: { type: 'boolean' },
            domain: { type: 'string' },
            keywords: { type: 'array', items: { type: 'string' } },
            briefing: { type: 'string' },
            sourceCount: { type: 'integer' },
            notes: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.briefing }],
      },
      timeoutMs: limits.timeoutMs * 3,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const requirement = args.requirement.trim()
        if (requirement.length === 0) throw new Error('requirement must be a non-empty string')
        const focus = typeof args.focus === 'string' ? args.focus.trim() : ''
        const text = focus.length > 0 ? `${requirement} ${focus}` : requirement
        const classified = engine.classify([{ role: 'user', content: [{ type: 'text', text }] }])
        const completed = await engine.research({
          text: classified.sanitized.length > 0 ? classified.sanitized : text,
          requirement,
          kind: classified.kind === 'chat' ? 'feature' : classified.kind,
          label: classified.label,
          domain: classified.domain,
          reasons: ['tool-request'],
          redacted: classified.redacted,
          agentId: exec?.agent?.session?.id,
          origin: describeAgentOrigin(exec?.agent).origin,
          project: projectDirectory(ctx, exec?.agent),
          maxAngles: args.maxAngles,
          signal: exec?.signal,
        })
        // Record what was learned so the next task in this project does not
        // research the same ground again.
        await recordInMemory(projectDirectory(ctx, exec?.agent), completed, requirement)
        return {
          ok: completed.ok === true,
          domain: completed.domain ?? 'generic',
          keywords: completed.keywords ?? [],
          briefing: completed.briefing ?? '',
          sourceCount: (completed.sources ?? []).length,
          notes: completed.notes ?? [],
        }
      },
    }))

    toolCtx.tools.register(tool({
      name: 'vet_dependency',
      description: 'Check whether a package or repository is safe to depend on: its licence, whether it is still maintained, and the known security advisories against it. Use it before adding a third-party dependency, and when a research result points at a library you intend to adopt rather than merely read.',
      parameters: {
        name: {
          type: 'string',
          required: true,
          description: 'An npm package name ("express", "@scope/pkg"), a GitHub repository URL, or a package page URL.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'kind', 'name', 'summary'],
          properties: {
            ok: { type: 'boolean' },
            kind: { type: 'string' },
            name: { type: 'string' },
            summary: { type: 'string' },
            license: { type: 'string' },
            maintenance: { type: 'string' },
            advisories: { type: 'array', items: { type: 'string' } },
            notes: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      timeoutMs: limits.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args) {
        const target = args.name.trim()
        if (target.length === 0) throw new Error('name must be a non-empty string')
        return await vetTarget(target, { timeoutMs: limits.timeoutMs })
      },
    }))

    toolCtx.tools.register(tool({
      name: 'recall_project',
      description: 'Read what the engine already learned about this project: earlier research, the reference projects that were already compared, and the decisions that were already settled. Call it before researching a requirement in a project you have worked on, so the same ground is not covered twice.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'note', 'entryCount'],
          properties: {
            ok: { type: 'boolean' },
            note: { type: 'string' },
            entryCount: { type: 'integer' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.note.length > 0 ? value.note : 'Nothing recorded for this project yet.' }],
      },
      timeoutMs: limits.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const directory = projectDirectory(ctx, exec?.agent)
        if (directory === null) return { ok: false, note: '', entryCount: 0 }
        const entries = parseMemory(await readMemoryFile(directory))
        return { ok: true, note: formatMemoryNote(entries), entryCount: entries.length }
      },
    }))

    toolCtx.tools.register(tool({
      name: 'ask_style',
      description: 'Ask the user to pick the project\'s visual or design style when that choice would change the result. Use it only for style/direction decisions that are the user\'s to make — not for facts you can research. The panel on the left shows the question; this call resolves with the chosen option once the user answers.',
      parameters: {
        question: {
          type: 'string',
          required: true,
          description: 'The one-sentence question shown above the choices.',
        },
        options: {
          type: 'array',
          required: true,
          description: 'Two to six mutually exclusive style choices.',
          items: { type: 'string' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['choice', 'revision'],
          properties: {
            choice: { type: 'string' },
            revision: { type: 'integer' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `The user chose: ${value.choice}` }],
      },
      timeoutMs: 600_000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const offer = normalizeOffer({ question: args.question, options: args.options })
        if (offer.ok !== true) throw new Error(offer.error)
        const published = style.offer(offer)
        return await new Promise((resolve, reject) => {
          const timer = setInterval(() => {
            const snapshot = style.snapshot()
            if (snapshot.answered !== null && snapshot.answered.revision >= published.revision) {
              clearInterval(timer)
              resolve({ choice: snapshot.answered.choice, revision: snapshot.answered.revision })
              return
            }
            if (exec.signal?.aborted === true) {
              clearInterval(timer)
              style.clear()
              reject(new Error('the style question was cancelled before it was answered'))
            }
          }, 400)
          exec.signal?.addEventListener('abort', () => {
            clearInterval(timer)
            style.clear()
            reject(new Error('the style question was cancelled before it was answered'))
          }, { once: true })
          if (exec.signal?.aborted === true) {
            clearInterval(timer)
            style.clear()
            reject(new Error('the style question was cancelled before it was answered'))
          }
        })
      },
    }))
  }))
  return () => { for (const dispose of disposers) dispose() }
}

/**
 * Register the behaviour contract as a system-prompt section.
 *
 * The contract is what makes the engine a standing capability rather than a
 * tool the model may call: it states when research is due, that it already ran
 * in the background, and what to do with what came back. It is scoped to
 * agents that can actually see `research_requirement`.
 *
 * @param {object} ctx - plugin context.
 * @param {{ maxAngles: number, background: boolean }} limits - resolved limits.
 * @returns {() => void} the disposer.
 */
export function installContract(ctx, limits) {
  return ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: ({ scope }) => {
        const tools = ctx.get?.('tools')
        if (tools === undefined || typeof tools.get !== 'function') return ''
        return tools.get('research_requirement', scope) === undefined ? '' : buildContract(limits)
      },
    })
  })
}

/**
 * Build a `research_requirement`-shaped message id (kept for compatibility with
 * the earlier panel API and for tests).
 * @returns {string} a message id.
 */
export function researchMessageId() {
  return `dsh-req-search-${randomUUID()}`
}

export { ENGINE_DEFAULTS }
