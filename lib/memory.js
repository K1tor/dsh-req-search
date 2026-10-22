/**
 * Project memory: what the engine already learned about this project.
 *
 * The engine researches a requirement, folds the result into the code, and
 * then the session ends. The next session starts from zero and researches the
 * same ground again — the same comparable projects, the same licence
 * questions, the same decisions already settled. This file is the fix: a
 * small, human-readable note per project directory that records what was
 * learned and what was decided, so the next task starts from there.
 *
 * The memory is deliberately a plain Markdown file in the project, not a
 * database: it is inspectable, diffable, survives a harness reinstall, and
 * belongs to the user's repository rather than to the tool.
 *
 * It is an optimisation, never a source of truth. Anything in it can be
 * wrong or stale, so the engine treats it as a hint and still verifies what
 * matters.
 */

/** Where the note lives, relative to the project directory. */
export const MEMORY_FILENAME = '.dsh/req-search-memory.md'

/** Most memory entries kept; older ones are dropped. */
export const MAX_ENTRIES = 40

/** Longest one entry's text, in characters. */
const MAX_ENTRY_CHARS = 2000

/** Longest one line of an entry, in characters. */
const MAX_LINE_CHARS = 400

/**
 * Fold a value onto one line: no newlines, collapsed spaces, bounded length.
 * @param {unknown} value - the text to fold.
 * @returns {string} the folded line.
 */
function foldLine(value) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text
}

/**
 * Build the Markdown body for a memory file.
 *
 * @param {Array<object>} entries - the entries, newest first.
 * @returns {string} the file body.
 */
export function renderMemory(entries) {
  const lines = [
    '# Project research memory',
    '',
    'What the engine has already learned and decided about this project.',
    'Written by the `dsh-req-search` plugin; safe to edit or delete.',
    '',
  ]
  if (!Array.isArray(entries) || entries.length === 0) {
    lines.push('_Nothing recorded yet._', '')
    return lines.join('\n')
  }
  for (const entry of entries) {
    lines.push(`## ${entry.title}`)
    if (typeof entry.when === 'string' && entry.when.length > 0) lines.push(`_${entry.when}_`)
    if (typeof entry.body === 'string' && entry.body.length > 0) {
      lines.push('', entry.body.slice(0, MAX_ENTRY_CHARS))
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Parse a memory file back into entries.
 *
 * The format is Markdown, and a hand-edited file is a normal thing to have,
 * so the parser is forgiving: anything it cannot read is skipped rather than
 * treated as an error.
 *
 * @param {string} text - the file body.
 * @returns {Array<object>} the entries, in file order.
 */
export function parseMemory(text) {
  const entries = []
  if (typeof text !== 'string' || text.length === 0) return entries
  let current = undefined
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith('## ')) {
      current = { title: line.slice(3).trim(), when: undefined, body: '' }
      entries.push(current)
      continue
    }
    if (current === undefined) continue
    if (current.when === undefined && line.startsWith('_') && line.endsWith('_') && line.length > 2) {
      current.when = line.slice(1, -1).trim()
      continue
    }
    current.body = current.body.length === 0 ? line : `${current.body}\n${line}`
  }
  for (const entry of entries) {
    entry.body = entry.body.trim()
    entry.title = foldLine(entry.title)
  }
  return entries.filter((entry) => entry.title.length > 0)
}

/**
 * Add an entry to a memory file, keeping the file bounded.
 *
 * A new entry replaces an older one with the same title, so re-running the
 * same task updates the note instead of accumulating duplicates.
 *
 * @param {string} text - the current file body.
 * @param {{ title: string, body: string, when?: string }} entry - the entry.
 * @returns {string} the new file body.
 */
export function appendMemory(text, entry) {
  const title = foldLine(entry?.title)
  if (title.length === 0) return typeof text === 'string' ? text : renderMemory([])
  const entries = parseMemory(text).filter((existing) => existing.title !== title)
  const record = {
    title,
    when: typeof entry.when === 'string' && entry.when.length > 0 ? entry.when : new Date().toISOString().slice(0, 10),
    body: String(entry.body ?? '').slice(0, MAX_ENTRY_CHARS),
  }
  entries.unshift(record)
  return renderMemory(entries.slice(0, MAX_ENTRIES))
}

/**
 * Summarise memory entries into a short note for the model.
 *
 * The note answers the question the next task actually has: what is already
 * known, and what was already decided. It is capped, because the point is to
 * avoid repeating research, not to replay it.
 *
 * @param {Array<object>} entries - the entries.
 * @param {{ limit?: number, charsPerEntry?: number }} [options] - caps.
 * @returns {string} the note, or an empty string when there is nothing.
 */
export function formatMemoryNote(entries, options = {}) {
  const limit = Math.max(1, options.limit ?? 10)
  const charsPerEntry = Math.max(60, options.charsPerEntry ?? 400)
  if (!Array.isArray(entries) || entries.length === 0) return ''
  const lines = ['Already known about this project (from previous work; verify anything load-bearing):']
  for (const entry of entries.slice(0, limit)) {
    const body = String(entry.body ?? '').replace(/\s+/gu, ' ').trim()
    const summary = body.length > charsPerEntry ? `${body.slice(0, charsPerEntry)}…` : body
    lines.push(`- ${entry.title}${summary.length > 0 ? `: ${summary}` : ''}`)
  }
  return lines.join('\n')
}

/**
 * Derive a stable title for one research run.
 *
 * The title is what makes an entry replaceable, so it has to survive
 * re-running the same requirement while still distinguishing two different
 * requirements.
 *
 * @param {string} requirement - the requirement text.
 * @returns {string} the title.
 */
export function memoryTitle(requirement) {
  const text = String(requirement ?? '').replace(/\s+/gu, ' ').trim()
  if (text.length === 0) return 'research'
  return foldLine(text.length > 80 ? text.slice(0, 80) : text)
}

/**
 * Turn a research result into the body of a memory entry.
 *
 * The body keeps what a future task needs — the sources, their facts, and the
 * decision they support — and drops the parts that only mattered for the
 * conversation that produced them.
 *
 * @param {object} result - the research result.
 * @param {{ perAngle?: number }} [options] - caps.
 * @returns {string} the entry body.
 */
export function memoryBody(result, options = {}) {
  const perAngle = Math.max(1, options.perAngle ?? 3)
  const lines = []
  if (result?.domain !== undefined) lines.push(`Domain: ${result.domain}.`)
  for (const angle of result?.angles ?? []) {
    const sources = (angle.sources ?? []).slice(0, perAngle)
    if (sources.length === 0) continue
    lines.push('')
    lines.push(`${angle.id}:`)
    for (const source of sources) {
      const facts = source.meta === undefined ? '' : ` (${source.meta.license ?? '?'}${source.meta.archived === true ? ', archived' : ''})`
      lines.push(`- ${source.title ?? source.url} — ${source.url}${facts}`)
    }
  }
  return lines.join('\n')
}
