/**
 * Deciding which turn is a "wish" — a request that deserves research.
 *
 * The engine should not ask a human what they want before researching: it
 * should notice on its own that a message states a project requirement, do
 * the research, and hand the result to the Agent. That means the trigger has
 * to be decided from the message text alone.
 *
 * The decision is deliberately conservative in the *other* direction than a
 * keyword matcher: a message that clearly states a requirement is researched,
 * and a message that clearly does not (a question, a follow-up, a chat turn)
 * is not. Researching a follow-up wastes a network round trip and dilutes the
 * briefing; missing a requirement wastes the whole point of the engine.
 */

/** Verbs that state an intent to build something. */
const BUILD_VERBS = [
  'build', 'create', 'make', 'implement', 'develop', 'design', 'write', 'generate',
  'add', 'port', 'migrate', 'refactor', 'rewrite', 'clone', 'replicate', 'prototype',
  '搭建', '做', '做一个', '做个', '写', '写一个', '开发', '实现', '设计', '生成', '构建',
  '创建', '新增', '移植', '迁移', '重构', '重写', '复刻', '仿制', '搭建一个', '来一个',
]

/** Words that mark a request as a project requirement rather than a chat turn. */
const REQUIREMENT_MARKERS = [
  'app', 'application', 'website', 'site', 'web app', 'game', 'tool', 'service', 'api',
  'backend', 'frontend', 'system', 'platform', 'plugin', 'extension', 'bot', 'dashboard',
  'extension', 'library', 'framework', 'cli', 'desktop app', 'mobile app', 'script',
  'application', 'server', 'client', 'editor', 'viewer', 'manager', 'monitor',
  '应用', '程序', '网站', '网页', '系统', '平台', '工具', '游戏', '服务', '接口', '后端',
  '前端', '插件', '扩展', '机器人', '后台', '仪表盘', '脚本', '命令行', '桌面应用', '移动应用',
  '编辑器', '管理器', '客户端', '服务端', '模拟器', '生成器', '小工具', 'demo', '原型',
]

/** Phrases that explicitly ask for a build. */
const WISH_PHRASES = [
  'i want', 'i need', 'i would like', 'i\'d like', 'can you build', 'can you make',
  'can you create', 'could you build', 'help me build', 'help me make', 'build me',
  'make me', 'create a', 'build a', 'implement a', 'write a', 'let\'s build',
  '我想要', '我需要', '我想做', '帮我做', '帮我写', '帮我做', '做一个', '写一个',
  '来个', '来一个', '整一个', '搞一个', '造一个', '开发一个', '实现一个', '搭建一个',
]

/** Questions and meta-conversation that are not requirements. */
const NON_REQUIREMENT_PATTERNS = [
  /^\s*(?:hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|got it|继续|好|谢谢|好的|行|嗯)\s*[.!。？?]*\s*$/iu,
  /^\s*(?:what|who|where|when|why|how)\b.*\?\s*$/iu,
  /\?\s*$/u,
  /^\s*(?:继续|接着|然后呢|下一步|继续做|continue|go on|next|keep going)\b/iu,
  /^\s*(?:改一下|调整一下|换一下|优化一下|加上|删掉|去掉)\s*\S+\s*(?:吧|就行|即可)?\s*[.!。]?\s*$/iu,
]

/** A message long enough to be a real requirement statement. */
const MIN_LENGTH = 8

/** Longest message treated as a requirement; longer text is a document, not a wish. */
const MAX_LENGTH = 2000

/**
 * Extract the plain text of one message.
 *
 * The host's message content is a list of typed blocks; only the text blocks
 * carry what the user asked for.
 *
 * @param {unknown} message - a claimed message.
 * @returns {string} the concatenated text.
 */
export function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * Whether a message states a requirement worth researching.
 *
 * @param {unknown} message - the message to judge.
 * @returns {boolean} true when the message reads as a project requirement.
 */
export function isRequirementMessage(message) {
  const text = messageText(message).trim()
  if (text.length < MIN_LENGTH || text.length > MAX_LENGTH) return false
  for (const pattern of NON_REQUIREMENT_PATTERNS) {
    if (pattern.test(text)) return false
  }
  const lower = text.toLowerCase()
  // An explicit wish phrase is the strongest signal.
  if (WISH_PHRASES.some((phrase) => lower.includes(phrase))) return true
  // A build verb together with a product word is the usual shape of a request.
  const hasVerb = BUILD_VERBS.some((verb) => lower.includes(verb))
  const hasProduct = REQUIREMENT_MARKERS.some((marker) => lower.includes(marker))
  if (hasVerb && hasProduct) return true
  // A product word plus a concrete noun phrase reads as a requirement even
  // without a build verb: "a mod loader for Steam Workshop".
  return hasProduct && lower.length >= 16 && /\b(?:for|with|that|which|to)\b/u.test(lower)
}

/**
 * Pick the requirement a message states.
 *
 * When several messages were claimed together, the last one is the current
 * wish — an earlier message is usually the setup for it.
 *
 * @param {Array<object>} messages - the claimed messages.
 * @returns {string} the requirement text, or an empty string when there is none.
 */
export function pickRequirement(messages) {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messageText(messages[index]).trim()
    if (isRequirementMessage(messages[index])) return text
  }
  return ''
}
