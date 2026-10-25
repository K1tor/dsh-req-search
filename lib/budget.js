/**
 * Explainable, observable retrieval budgets.
 *
 * DSH does not expose a token counter to `agent/pre-step`. These are therefore
 * network/source/character budgets, not fabricated token counts. The injected
 * character ceiling bounds persistent context; time and provider-call ceilings
 * leave the rest of the turn available for implementation and verification.
 */

export const SEARCH_LEVELS = Object.freeze({
  0: Object.freeze({ name: 'off', angles: 0, results: 0, enrich: 0, contextChars: 0, deadlineMs: 0 }),
  1: Object.freeze({ name: 'light', angles: 2, results: 4, enrich: 2, contextChars: 6000, deadlineMs: 18000 }),
  2: Object.freeze({ name: 'standard', angles: 4, results: 6, enrich: 4, contextChars: 10000, deadlineMs: 35000 }),
  3: Object.freeze({ name: 'deep', angles: 6, results: 8, enrich: 6, contextChars: 14000, deadlineMs: 50000 }),
})

export const BUDGET_DEFAULTS = Object.freeze({
  maxLevel: 3,
  maxSearchCalls: 12,
  contextChars: 10000,
  maxSourceChars: 500,
  progressive: true,
})

/** Clamp configuration without turning invalid input into zero-cost work. */
function integer(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/**
 * Score intent and uncertainty, not just the occurrence of the word "search".
 * A question may need current official facts; a pasted code-edit instruction
 * with complete context may need none.
 *
 * @param {{ text: string, kind: string, reasons?: string[] }} classification
 * @param {{ existingProject?: boolean, stack?: string[] }} project
 * @param {{ maxLevel?: number }} limits
 */
export function decideSearchLevel(classification, project = {}, limits = {}) {
  const text = String(classification?.text ?? '').trim()
  const kind = classification?.kind ?? 'chat'
  const eligible = classification?.shouldResearch === true || classification?.research === true
  const ceiling = integer(limits.maxLevel, 0, 3, 3)
  if (!eligible || text.length === 0 || ceiling === 0) {
    return { level: 0, name: 'off', reasons: [...(classification?.reasons ?? ['no-search-value'])] }
  }

  const lower = text.toLowerCase()
  const explicitResearch = /(?:全面|深度|详细|完整).{0,12}(?:调研|研究|检索|搜索)|(?:deep|comprehensive|thorough)\s+(?:research|search|investigation)/iu.test(text)
  const current = /最新|当前版本|当前官方|现行|近期|最近发布|today|latest|current|up.to.date|release|migration guide/iu.test(text)
  const risky = /安全|鉴权|认证|支付|加密|漏洞|迁移|兼容性|疑难|security|authentication|payment|cryptograph|vulnerabilit|migration|compatibilit/iu.test(lower)
  const architectural = /架构|重构|技术选型|多模块|微服务|architecture|refactor|monorepo|microservice|trade.?off/iu.test(lower)
  const explicitSearch = /搜索|检索|调研|仓库|开源|官方文档|search|github|repository|documentation/iu.test(lower)
  const substantial = /[，,；;\n]/.test(text) || text.length > 120
  let level = 1
  const reasons = [...(classification.reasons ?? [])]
  if (kind === 'test' || kind === 'automation' || kind === 'feature' || kind === 'dependency') level = 1
  if (kind === 'bug' || kind === 'performance' || kind === 'refactor') level = 2
  if (architectural || kind === 'architecture' || kind === 'new-project' || explicitResearch) level = 3
  if (current || risky || explicitSearch || substantial) level = Math.max(level, 2)
  if ((current && architectural) || (risky && architectural) || explicitResearch) level = 3
  if (project.existingProject === true && !current && !risky && !architectural && !explicitResearch) {
    level = Math.max(1, level - 1)
    reasons.push('local-context-available')
  }
  if (explicitResearch) reasons.push('explicit-deep-research')
  if (current) reasons.push('current-official-facts-required')
  if (risky) reasons.push('compatibility-or-security-uncertainty')
  if (explicitSearch) reasons.push('external-reuse-or-official-docs')
  if (substantial) reasons.push('multiple-requirements-or-context')
  level = Math.min(ceiling, level)
  return { level, name: SEARCH_LEVELS[level].name, reasons: [...new Set(reasons)] }
}

/** Allocate the smaller of level, deployment and per-tool budgets. */
export function allocateSearchBudget(level, limits = {}, request = {}) {
  const profile = SEARCH_LEVELS[integer(level, 0, 3, 0)]
  const angleCeiling = integer(limits.maxAngles, 1, 6, 4)
  const maxAngles = Math.min(profile.angles, angleCeiling, integer(request.maxAngles, 1, angleCeiling, angleCeiling))
  const configuredChars = integer(limits.contextChars, 1000, 20000, BUDGET_DEFAULTS.contextChars)
  const requestedChars = integer(request.contextChars, 1000, configuredChars, configuredChars)
  const contextChars = Math.min(profile.contextChars, configuredChars, requestedChars)
  return {
    level: profile.angles === 0 ? 0 : integer(level, 1, 3, 1),
    name: profile.name,
    maxAngles,
    initialAngles: limits.progressive === false ? maxAngles : Math.min(maxAngles, 1),
    maxSearchCalls: Math.min(integer(limits.maxSearchCalls, 1, 24, 12), integer(request.maxSearchCalls, 1, 24, 12)),
    maxResults: Math.min(profile.results, integer(limits.maxResults, 1, 20, 8)),
    enrich: Math.min(profile.enrich, integer(limits.enrich, 0, 20, 8)),
    contextChars,
    maxSourceChars: Math.min(integer(limits.maxSourceChars, 120, 2000, 500), Math.floor(contextChars / 4)),
    deadlineMs: Math.min(profile.deadlineMs, integer(limits.deadlineMs, 250, 300000, 45000)),
    timeoutMs: integer(limits.timeoutMs, 500, 120000, 20000),
    concurrency: integer(limits.concurrency, 1, 6, 3),
    progressive: limits.progressive !== false,
  }
}

import { normalizeSourceUrl } from './search.js'

/** Does a batch materially reduce uncertainty? Duplicate URLs do not. */
export function evaluateRetrievalProgress(batch, previousUrls, options = {}) {
  const urls = new Set()
  let relevant = 0
  let failures = 0
  let providers = 0
  for (const angle of batch) {
    if (angle.provider !== 'none' && angle.provider !== undefined) providers += 1
    // A note naming an empty provider or a spent retry is degraded evidence,
    // not a failure: an angle that recovered on its second read did work.
    failures += (angle.notes ?? []).filter((note) => !/(?:^|:)(?:empty|retry)$/u.test(note)).length
    for (const source of angle.sources ?? []) {
      // Identity is the fragment-free URL: `...doc#one` and `...doc#two` are
      // one document, and counting them twice would fake progress.
      const identity = normalizeSourceUrl(source.url)
      if (previousUrls.has(identity) || urls.has(identity)) continue
      urls.add(identity)
      if ((source.relevance?.score ?? 1) > 0 || (angle.sources ?? []).length < 3) relevant += 1
    }
  }
  const noNew = urls.size === 0
  const poor = relevant === 0 || urls.size < Math.max(1, options.minimumNew ?? 1)
  return {
    newUrls: urls.size,
    relevant,
    failures,
    providers,
    stop: noNew || poor,
    reason: noNew ? 'no-new-sources' : poor ? 'low-value-results' : 'continue-if-uncertain',
  }
}

/** A counter used by callers and status snapshots; deliberately not "tokens". */
export function observableUsage(result) {
  return {
    searchCalls: (result.angles ?? []).filter((angle) => angle.searched === true || angle.provider !== undefined).length,
    sources: (result.sources ?? []).length,
    briefingChars: String(result.briefing ?? '').length,
    characterBudgetKind: 'observable-not-token-count',
  }
}
