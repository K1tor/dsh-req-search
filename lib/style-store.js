/**
 * Shared state for the style-choice handshake.
 *
 * The Agent researches in the background and only opens the panel when the
 * project's *style* is a decision it must not make alone. This store holds the
 * one pending question and the answer, so a tool call and an HTTP request can
 * meet without either knowing about the other's transport.
 *
 * Pure and synchronous: the host owns instances, tests own their own.
 */

/** Longest label accepted for one style option. */
export const MAX_OPTION_CHARS = 120
/** Most options one question may offer. */
export const MAX_OPTIONS = 6

/**
 * Validate and normalize one offer.
 *
 * @param {{ question?: unknown, options?: unknown }} input - raw offer.
 * @returns {{ ok: true, question: string, options: string[] } | { ok: false, error: string }} the normalized offer.
 */
export function normalizeOffer(input) {
  const options = Array.isArray(input?.options)
    ? input.options
        .filter((option) => typeof option === 'string')
        .map((option) => option.trim())
        .filter((option) => option.length > 0)
    : []
  if (options.length < 2) return { ok: false, error: 'options must contain at least two non-empty choices' }
  if (options.length > MAX_OPTIONS) return { ok: false, error: `options must contain at most ${MAX_OPTIONS} choices` }
  const unique = [...new Set(options)]
  if (unique.length !== options.length) return { ok: false, error: 'options must not repeat a choice' }
  if (unique.some((option) => option.length > MAX_OPTION_CHARS)) {
    return { ok: false, error: `each option must be at most ${MAX_OPTION_CHARS} characters` }
  }
  const question = typeof input?.question === 'string' && input.question.trim().length > 0
    ? input.question.trim().slice(0, 200)
    : '选择项目的风格方向'
  return { ok: true, question, options: unique }
}

/**
 * Create one style-choice store.
 *
 * A newer offer replaces an older one — a stale question must never outlive the
 * research that produced it — and answering clears the pending question so a
 * poll cannot resurrect it.
 *
 * @returns {object} the store.
 */
export function createStyleStore() {
  let pending = null
  let answered = null
  let revision = 0

  return {
    /**
     * Publish a question for the panel.
     * @param {{ question: string, options: string[] }} offer - normalized offer.
     * @returns {{ revision: number, question: string, options: string[] }} the published state.
     */
    offer(offer) {
      revision += 1
      pending = { revision, question: offer.question, options: [...offer.options] }
      answered = null
      return pending
    },
    /**
     * Record the user's answer.
     * @param {string} option - one of the pending options.
     * @returns {{ ok: true, revision: number, choice: string } | { ok: false, error: string }} the outcome.
     */
    answer(option) {
      if (pending === null) return { ok: false, error: 'no style question is pending' }
      if (!pending.options.includes(option)) return { ok: false, error: 'the choice is not one of the offered options' }
      answered = { revision: pending.revision, choice: option }
      pending = null
      return { ok: true, revision: answered.revision, choice: option }
    },
    /**
     * Read the current state without consuming it.
     * @returns {{ revision: number, pending: object | null, answered: object | null }} a snapshot.
     */
    snapshot() {
      return {
        revision,
        pending: pending === null ? null : { revision: pending.revision, question: pending.question, options: [...pending.options] },
        answered: answered === null ? null : { ...answered },
      }
    },
    /** Drop any pending question (the Agent withdrew it). */
    clear() {
      pending = null
    },
  }
}
