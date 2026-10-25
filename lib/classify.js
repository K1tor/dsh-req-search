/**
 * Task classification: should this turn be researched at all?
 *
 * The engine is a global background capability, so its first duty is to *stay
 * out of the way*. A greeting, a translation, a question about the code, or a
 * follow-up tweak must cost nothing — no network round trip, no injected
 * message, no prompt bytes. Conversely, a real development task must be caught
 * even when it arrives as an ordinary chat message, from a subagent, or from a
 * scheduled wake.
 *
 * Classification therefore returns a *kind* (what sort of work this is) and a
 * research *decision* (whether that kind benefits, how many angles, and why).
 * The decision is deliberately explainable: every run records the reasons it
 * fired, so the panel can show why a turn was or was not researched.
 *
 * Everything here is pure, so it is unit-testable without a host or network.
 */

/** Message text extraction, shared with the wish detector. */
import { messageText } from './wish.js'

/**
 * Task kinds. `research` is the default verdict per kind: a kind that cannot
 * benefit from external references is never researched, whatever its words.
 */
export const TASK_KINDS = Object.freeze({
  'new-project': { research: true, angles: 4, label: 'new project' },
  feature: { research: true, angles: 4, label: 'feature work' },
  refactor: { research: true, angles: 3, label: 'refactor' },
  bug: { research: true, angles: 4, label: 'bug fix' },
  performance: { research: true, angles: 4, label: 'performance' },
  architecture: { research: true, angles: 4, label: 'architecture / tech choice' },
  dependency: { research: true, angles: 3, label: 'dependency choice' },
  test: { research: true, angles: 3, label: 'tests' },
  release: { research: false, angles: 0, label: 'release prep' },
  automation: { research: true, angles: 3, label: 'automation' },
  docs: { research: false, angles: 0, label: 'documentation' },
  chat: { research: false, angles: 0, label: 'conversation' },
  translation: { research: false, angles: 0, label: 'translation' },
  question: { research: false, angles: 0, label: 'question' },
  continuation: { research: false, angles: 0, label: 'continuation' },
  'simple-edit': { research: false, angles: 0, label: 'small edit' },
})

/** Domain vocabulary. Order matters only for tie-breaks; scoring decides. */
const DOMAIN_WORDS = {
  game: [
    'game', 'games', 'roguelike', 'roguelite', 'rpg', 'slg', 'fps', 'rts', 'metroidvania',
    'unity', 'godot', 'unreal', 'phaser', 'pygame', 'gameplay', 'level design',
    '游戏', '关卡', '玩法', '数值', '经济系统', '模拟经营', '塔防', '卡牌', '像素', '存档', '掉落',
  ],
  web: [
    'web', 'webapp', 'website', 'frontend', 'backend', 'fullstack', 'react', 'vue', 'svelte',
    'next.js', 'nuxt', 'vite', 'tailwind', 'html', 'css', 'dashboard', 'admin panel', 'ssr',
    '网页', '网站', '前端', '后端', '页面', '界面', '仪表盘', '管理后台', '组件库', '响应式',
  ],
  desktop: [
    'desktop', 'electron', 'tauri', 'qt', 'wpf', 'winui', 'tray', 'installer', 'auto-update',
    '桌面', '桌面应用', '托盘', '安装包', '自动更新', '窗口',
  ],
  mobile: [
    'ios', 'android', 'react native', 'flutter', 'swiftui', 'jetpack compose', 'mobile app',
    '移动端', '移动应用', '小程序', '安卓', '手机',
  ],
  ai: [
    'ai', 'llm', 'agent', 'rag', 'embedding', 'vector database', 'prompt', 'fine-tune',
    'mcp', 'tool calling', 'agent framework', 'evaluation', 'inference',
    '大模型', '智能体', '向量', '检索增强', '提示词', '推理', '评测', '模型集成',
  ],
  data: [
    'database', 'sql', 'postgres', 'mysql', 'sqlite', 'redis', 'index', 'query plan',
    'algorithm', 'data structure', 'etl', 'pipeline', 'stream processing',
    '数据库', '索引', '算法', '数据结构', '查询优化', '数据管道', '缓存',
  ],
  automation: [
    'script', 'automation', 'cron', 'cli', 'shell', 'workflow', 'etl script', 'batch',
    '脚本', '自动化', '命令行', '定时任务', '批处理', '爬虫',
  ],
  enterprise: [
    'enterprise', 'sso', 'rbac', 'audit log', 'tenant', 'transaction', 'idempotent', 'compliance',
    '企业', '权限模型', '审计', '多租户', '事务', '一致性', '工作流引擎',
  ],
  plugin: [
    'plugin', 'extension', 'dsh', 'harness', 'cordis', 'hook', 'middleware', 'bundle',
    '插件', '扩展', '中间件', '生命周期', '钩子',
  ],
}

/** Words that mark a turn as a bug report or a fix request. */
const BUG_WORDS = [
  'bug', 'error', 'exception', 'crash', 'broken', 'fails', 'failing', 'failure', 'stack trace',
  'traceback', 'regression', 'not working', "doesn't work", 'does not work', 'undefined is not',
  '报错', '错误', '异常', '崩溃', '修复', '闪退', '不工作', '失败', '排查', '定位', '回归',
]

/** Words that mark a performance task. */
const PERFORMANCE_WORDS = [
  'performance', 'slow', 'latency', 'throughput', 'memory leak', 'cpu', 'gpu', 'optimize',
  'optimization', 'profil', 'benchmark', 'bottleneck',
  '性能', '优化', '卡顿', '延迟', '吞吐', '内存泄漏', '瓶颈', '基准测试', '加速',
]

/** Words that mark an architecture or technology-choice task. */
const ARCHITECTURE_WORDS = [
  'architecture', 'design', 'tech stack', 'technology choice', 'trade-off', 'tradeoff',
  'which library', 'which framework', 'system design', 'scale', 'scalable', 'monorepo',
  '架构', '技术选型', '设计方案', '权衡', '重构架构', '模块划分', '技术栈', '可扩展',
]

/** Words that mark a refactor task. */
const REFACTOR_WORDS = [
  'refactor', 'restructure', 'rewrite', 'clean up', 'decouple', 'extract module', 'migrate',
  '重构', '重写', '拆分', '解耦', '迁移', '整理代码',
]

/** Words that mark a dependency task. */
const DEPENDENCY_WORDS = [
  'dependency', 'dependencies', 'package', 'npm', 'library', 'add a library', 'pypi', 'crate',
  '依赖', '引入库', '第三方库', '包管理', '安装包', 'npm 包',
]

/** Words that mark a test task. */
const TEST_WORDS = [
  'test', 'tests', 'unit test', 'integration test', 'e2e', 'coverage', 'test suite',
  '测试', '单测', '集成测试', '端到端', '覆盖率', '用例',
]

/** Words that mark an automation task. */
const AUTOMATION_WORDS = [
  'automate', 'automation', 'script', 'cron', 'scheduled task', 'rename files', 'batch process',
  '自动化', '脚本', '定时', '批量', '批处理', '流程编排',
]

/** Words that mark a release task. */
const RELEASE_WORDS = [
  'release', 'publish', 'version bump', 'changelog', 'tag the release', 'deploy pipeline',
  '发布', '上线', '版本号', '变更日志', '打包发布',
]

/** Words that mark a translation / plain text processing task. */
const TRANSLATION_WORDS = [
  'translate', 'translation', 'in english', 'in chinese', 'proofread', 'summarize this text',
  '翻译', '译成', '中译英', '英译中', '润色', '校对', '改写成',
]

/** Words that name documentation work rather than a buildable product. */
const DOC_WORDS = [
  'documentation', 'readme', 'docstring', 'jsdoc', 'api doc', 'changelog', 'write docs',
  '说明文档', '使用文档', '使用说明', '接口文档', '开发文档', '补文档', '写文档', '写个文档', '写说明', '文档注释',
]

/**
 * Statements that withdraw the task the engine just picked up.
 *
 * Only a *bare* cancellation counts: "取消" alone, or naming the thing it
 * cancels. A message that pairs the cancellation with a new requirement
 * ("取消刚才的，改成做 X") does not match, so the new requirement is read
 * normally.
 */
const CANCELLED_PATTERNS = [
  /^\s*(?:请)?(?:取消|停止|停下|别做了|不用做了|不用了|不要了|算了)(?:刚才|之前|上面|那个|这个)?(?:的)?(?:任务|需求|搜索|检索|研究)?\s*[.!。！?]*$/u,
  /^\s*(?:please\s+)?(?:cancel|stop|never\s?mind|forget it)\s*(?:that|it|the task|the search|the research)?\s*[.!?]*$/iu,
]

/** Words that state an intent to build something. */
const BUILD_VERBS = [
  'build', 'create', 'make', 'implement', 'develop', 'design', 'write', 'generate', 'add',
  'port', 'migrate', 'refactor', 'rewrite', 'clone', 'replicate', 'prototype', 'integrate',
  'optimi', 'fix', 'debug', 'set up', 'setup',
  '搭建', '做', '做一个', '做个', '写', '写一个', '开发', '实现', '设计', '生成', '构建',
  '创建', '新增', '移植', '迁移', '重构', '重写', '复刻', '仿制', '修复', '排查', '接入',
  '优化', '加上', '增加', '支持',
]

/** Words that mark a request as a project requirement rather than a chat turn. */
const PRODUCT_WORDS = [
  'app', 'application', 'website', 'site', 'web app', 'game', 'tool', 'service', 'api',
  'backend', 'frontend', 'system', 'platform', 'plugin', 'extension', 'bot', 'dashboard',
  'library', 'framework', 'cli', 'desktop app', 'mobile app', 'script', 'server', 'client',
  'editor', 'viewer', 'manager', 'monitor', 'feature', 'module', 'component', 'endpoint',
  '应用', '程序', '网站', '网页', '系统', '平台', '工具', '游戏', '服务', '接口', '后端',
  '前端', '插件', '扩展', '机器人', '后台', '仪表盘', '脚本', '命令行', '桌面应用', '移动应用',
  '编辑器', '管理器', '客户端', '服务端', '模拟器', '生成器', '小工具', '功能', '模块', '组件',
]

/** Phrases that explicitly ask for a build. */
const WISH_PHRASES = [
  'i want', 'i need', 'i would like', "i'd like", 'can you build', 'can you make',
  'can you create', 'could you build', 'help me build', 'help me make', 'build me',
  'make me', 'create a', 'build a', 'implement a', 'write a', "let's build",
  '我想要', '我需要', '我想做', '帮我做', '帮我写', '做一个', '写一个',
  '来个', '来一个', '整一个', '搞一个', '造一个', '开发一个', '实现一个', '搭建一个',
]

/** Questions and meta-conversation that are not tasks. */
const NON_TASK_PATTERNS = [
  /^\s*(?:hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|got it|继续|好|谢谢|好的|行|嗯)\s*[.!。？?]*\s*$/iu,
  /^\s*(?:继续|接着|然后呢|下一步|继续做|continue|go on|next|keep going)\b/iu,
]

/**
 * Bare questions: an interrogative that asks the harness (or the person) for
 * an opinion rather than stating work. A question that names a failure, a
 * performance problem or a dependency still counts as work, so these patterns
 * are checked before — but answered without — the task vocabulary below.
 */
const TASK_QUESTION_PATTERNS = [
  /^\s*(?:what|who|where|when|why|how)\b(?:(?!\b(?:error|fail|crash|fix|bug|slow|optimi[sz]e|install|deploy|test)\b).)*\?\s*$/iu,
  /^\s*(?:什么|为什么|如何|怎么|哪些|哪个|多少|是否)(?![^\n]*(?:报错|错误|失败|崩溃|修复|优化|性能|测试|部署))[^\n]*[？?]\s*$/u,
]

/** A message long enough to be a real task statement. */
const MIN_LENGTH = 8

/** Longest follow-up tweak still treated as a small edit rather than a task. */
const SMALL_EDIT_MAX_CHARS = 40

/** ASCII tokens that are conversational filler rather than a technical subject. */
const CONVERSATIONAL_TOKENS = new Set([
  'the', 'and', 'but', 'for', 'you', 'your', 'please', 'thanks', 'thank', 'hello', 'hey',
  'this', 'that', 'these', 'those', 'what', 'when', 'why', 'how', 'can', 'could', 'would',
  'should', 'have', 'has', 'had', 'was', 'were', 'been', 'are', 'not', 'does', 'did', 'doing',
  'done', 'okay', 'yes', 'sure', 'good', 'great', 'nice', 'just', 'very', 'much', 'more',
  'some', 'any', 'all', 'too', 'also', 'then', 'than', 'with', 'from', 'about', 'into',
])

/** Longest message treated as a task; longer text is a document, not a request. */
const MAX_LENGTH = 4000

/**
 * Score domain vocabulary hits in one text.
 *
 * Longer vocabulary entries are matched first so a compound such as
 * `simulation game` cannot be scored as two weaker hits.
 *
 * @param {string} text - lowercased text.
 * @returns {{ domain: string, score: number, hits: string[] }} the strongest domain.
 */
export function detectDomains(text) {
  const scored = []
  for (const [domain, words] of Object.entries(DOMAIN_WORDS)) {
    const hits = []
    for (const word of words) {
      const needle = word.toLowerCase()
      if (needle.length === 0) continue
      if (text.includes(needle)) hits.push(needle)
    }
    scored.push({ domain, score: hits.length, hits })
  }
  scored.sort((left, right) => right.score - left.score)
  const best = scored[0]
  if (best === undefined || best.score === 0) return { domain: 'generic', score: 0, hits: [] }
  const tied = scored.filter((entry) => entry.score === best.score)
  return tied.length > 1
    ? { domain: 'generic', score: best.score, hits: [...new Set(tied.flatMap((entry) => entry.hits))] }
    : best
}

/**
 * Match a keyword family, case-insensitively.
 * @param {string} text - lowercased text.
 * @param {string[]} words - vocabulary.
 * @returns {boolean} whether any entry occurs.
 */
function hasAny(text, words) {
  return words.some((word) => text.includes(word.toLowerCase()))
}

/**
 * Classify one message into a task kind.
 *
 * The order encodes precedence: an explicit bug or performance statement wins
 * over a generic build verb, because the research that follows is different.
 *
 * @param {string} text - the message text.
 * @returns {{ kind: string, label: string, research: boolean, angles: number, reasons: string[] }} the classification.
 */
export function classifyText(text) {
  const trimmed = String(text ?? '').trim()
  const lower = trimmed.toLowerCase()
  if (trimmed.length === 0) {
    return { kind: 'chat', label: TASK_KINDS.chat.label, research: false, angles: 0, reasons: ['empty-message'] }
  }
  if (trimmed.length > MAX_LENGTH) {
    // A long message is usually a pasted document — but a long requirement that
    // carries a pasted log or a code dump is still a task. Strip the noise
    // first; only what remains long is a document, not a request.
    const withoutCode = trimmed
      .replace(/```[\s\S]*?```/gu, ' ')
      .replace(/`[^`]{40,}`/gu, ' ')
      .replace(/^\s*\[?\d{4}-\d{2}-\d{2}[T ][^\n]*$/gimu, ' ')
      .replace(/^\s*(?:Traceback(?: .*)?|at .+?\(.+?:\d+\)|[A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception|Warning)\b)[^\n]*$/gimu, ' ')
    if (withoutCode.length > MAX_LENGTH) {
      return { kind: 'docs', label: TASK_KINDS.docs.label, research: false, angles: 0, reasons: ['message-too-long'] }
    }
    return classifyText(withoutCode)
  }

  const hasBuildVerb = hasAny(lower, BUILD_VERBS)
  const hasProduct = hasAny(lower, PRODUCT_WORDS)
  const hasWishPhrase = hasAny(lower, WISH_PHRASES)

  const bug = hasAny(lower, BUG_WORDS)
  const performance = hasAny(lower, PERFORMANCE_WORDS)
  const architecture = hasAny(lower, ARCHITECTURE_WORDS)
  const refactor = hasAny(lower, REFACTOR_WORDS)
  const dependency = hasAny(lower, DEPENDENCY_WORDS)
  const test = hasAny(lower, TEST_WORDS)
  const automation = hasAny(lower, AUTOMATION_WORDS)
  const release = hasAny(lower, RELEASE_WORDS)

  // A trailing question mark means the user is asking something, but only a
  // *bare* question is conversational: "为什么这个接口报错？" is a real request
  // for help, while "应该用哪个库？" is a decision the model may simply make.
  const looksLikeQuestion = /\?\s*$/u.test(trimmed) || /[？]\s*$/u.test(trimmed)
  for (const pattern of TASK_QUESTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { kind: 'question', label: TASK_KINDS.question.label, research: false, angles: 0, reasons: ['bare-question'] }
    }
  }

  // A gesture at conversation (acknowledgement, greeting, "continue") is not a
  // task even when it is long enough to look like one.
  for (const pattern of NON_TASK_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { kind: 'chat', label: TASK_KINDS.chat.label, research: false, angles: 0, reasons: ['conversation'] }
    }
  }

  // "改一下那个按钮" and "加上分页" are follow-up tweaks: they name no external
  // technology and the agent already has the project open. A tweak that names a
  // real problem still falls through to the vocabulary below.
  const isSmallEdit = /^\s*(?:改一下|调整一下|换一下|加上|加个|删掉|去掉|rename|change|tweak|adjust)\s*/u.test(trimmed) &&
    trimmed.length <= SMALL_EDIT_MAX_CHARS &&
    !bug && !performance && !dependency && !architecture && !refactor && !test
  if (isSmallEdit) {
    return { kind: 'simple-edit', label: TASK_KINDS['simple-edit'].label, research: false, angles: 0, reasons: ['small-edit'] }
  }
  if (release && !bug && !architecture) {
    return { kind: 'release', label: TASK_KINDS.release.label, research: false, angles: 0, reasons: ['release-task'] }
  }
  // Translation intent wins over failure wording: in "把这段报错翻译成英文"
  // the error word is the *object* being translated, not the task. A message
  // that pairs a translation word with a build verb and a product ("写一个
  // 翻译工具") is building something, not translating.
  if (hasAny(lower, TRANSLATION_WORDS) && !(hasBuildVerb && hasProduct)) {
    return { kind: 'translation', label: TASK_KINDS.translation.label, research: false, angles: 0, reasons: ['translation'] }
  }
  // Documentation work names its material ("README", "说明文档") rather than a
  // product; a product that happens to relate to docs ("文档管理工具") has a
  // build verb and a product word and reads as a feature below.
  if (hasAny(lower, DOC_WORDS) && !bug && !performance && !architecture && !refactor && !(hasBuildVerb && hasProduct)) {
    return { kind: 'docs', label: TASK_KINDS.docs.label, research: false, angles: 0, reasons: ['docs-vocabulary'] }
  }

  if (bug) return { kind: 'bug', label: TASK_KINDS.bug.label, research: true, angles: TASK_KINDS.bug.angles, reasons: ['bug-vocabulary'] }
  if (performance) {
    return { kind: 'performance', label: TASK_KINDS.performance.label, research: true, angles: TASK_KINDS.performance.angles, reasons: ['performance-vocabulary'] }
  }
  if (architecture) {
    return { kind: 'architecture', label: TASK_KINDS.architecture.label, research: true, angles: TASK_KINDS.architecture.angles, reasons: ['architecture-vocabulary'] }
  }
  if (dependency) {
    return { kind: 'dependency', label: TASK_KINDS.dependency.label, research: true, angles: TASK_KINDS.dependency.angles, reasons: ['dependency-vocabulary'] }
  }
  if (refactor) return { kind: 'refactor', label: TASK_KINDS.refactor.label, research: true, angles: TASK_KINDS.refactor.angles, reasons: ['refactor-vocabulary'] }
  if (test) return { kind: 'test', label: TASK_KINDS.test.label, research: true, angles: TASK_KINDS.test.angles, reasons: ['test-vocabulary'] }
  if (automation) {
    return { kind: 'automation', label: TASK_KINDS.automation.label, research: true, angles: TASK_KINDS.automation.angles, reasons: ['automation-vocabulary'] }
  }

  // A bare noun phrase with no build intent is still work worth researching
  // when it names a product ("a mod loader for Steam Workshop", "侧边栏面板"):
  // the product word *is* the task. Only a phrase with neither a product word
  // nor a build verb is conversation.
  if (!hasBuildVerb && !hasProduct && !hasWishPhrase) {
    if (trimmed.length < MIN_LENGTH) {
      return { kind: 'chat', label: TASK_KINDS.chat.label, research: false, angles: 0, reasons: ['too-short'] }
    }
    // A named technology plus a scope is a technical request even without a verb:
    // "Add a subagent that reviews PRs" / "带鉴权的 REST API".
    if (hasConcreteNounPhrase(lower) && looksLikeImperativeStart(trimmed)) {
      return { kind: 'feature', label: TASK_KINDS.feature.label, research: true, angles: TASK_KINDS.feature.angles, reasons: ['concrete-request'] }
    }
    return { kind: 'chat', label: TASK_KINDS.chat.label, research: false, angles: 0, reasons: ['no-build-verb-or-product-word'] }
  }
  if (hasWishPhrase || (hasBuildVerb && hasProduct)) {
    return { kind: 'feature', label: TASK_KINDS.feature.label, research: true, angles: TASK_KINDS.feature.angles, reasons: [hasWishPhrase ? 'wish-phrase' : 'build-verb+product-word'] }
  }
  // A product word with a concrete noun phrase reads as a requirement even
  // without a build verb: "a mod loader for Steam Workshop".
  if (hasProduct && (lower.length >= 16 || hasConcreteNounPhrase(lower))) {
    return { kind: 'feature', label: TASK_KINDS.feature.label, research: true, angles: TASK_KINDS.feature.angles, reasons: ['product-phrase'] }
  }
  // A build verb that names a concrete domain ("refactor", "add a panel") is
  // still work; it just has no product word to anchor the queries on.
  if (hasBuildVerb && trimmed.length >= MIN_LENGTH) {
    return { kind: 'feature', label: TASK_KINDS.feature.label, research: true, angles: TASK_KINDS.feature.angles, reasons: ['build-verb'] }
  }
  return { kind: 'chat', label: TASK_KINDS.chat.label, research: false, angles: 0, reasons: ['insufficient-signal'] }
}

/**
 * Whether a phrase opens like a request for work rather than like a statement
 * about something.
 *
 * Latin-script requests in this harness usually open with an imperative
 * ("Add …", "Create …", "Fix …"); a sentence that opens with a determiner or a
 * pronoun is describing something, not asking for it. Chinese requests put the
 * same weight on the product word instead, which the caller has checked.
 *
 * @param {string} trimmed - the original text.
 * @returns {boolean} true when the text opens imperatively.
 */
function looksLikeImperativeStart(trimmed) {
  if (/[\u3400-\u9fff]/u.test(trimmed)) return false
  return /^\s*(?:add|create|build|make|write|implement|fix|add|support|introduce|refactor|port|migrate|optimi[sz]e|document|review|test|publish)\b/iu.test(trimmed)
}

/**
 * Whether a phrase names a concrete technical subject rather than conversational
 * filler.
 *
 * The signal is a named technology or identifier — an ASCII token of three or
 * more characters that is not a function word — which is what makes "add a
 * subagent that reviews PRs" a request while "谢谢你，已经完成了" is not. Chinese
 * requests carry their subject in product words instead, which the caller has
 * already checked.
 *
 * @param {string} lower - lowercased text.
 * @returns {boolean} true when the phrase names something concrete.
 */
function hasConcreteNounPhrase(lower) {
  if (/\b(?:for|with|that|which|using|based on)\b/u.test(lower)) return true
  for (const match of lower.matchAll(/[a-z][a-z0-9.+#_-]{2,}/gu)) {
    const token = match[0]
    if (CONVERSATIONAL_TOKENS.has(token)) continue
    return true
  }
  return false
}

/**
 * Project facts that change what research is worth doing.
 *
 * These are *file names and manifest fields only* — never file contents, never
 * source code. They answer "is there already a project here, and on what
 * stack?", which decides whether the queries should ask for greenfield
 * references or for the way this stack already solves the problem.
 *
 * @param {{ manifest?: object, files?: string[], dependencyNames?: string[] }} input - observed project facts.
 * @returns {{ existingProject: boolean, stack: string[], languages: string[], signals: string[] }} the summary.
 */
export function inferProjectProfile(input = {}) {
  const files = Array.isArray(input.files) ? input.files : []
  const manifest = typeof input.manifest === 'object' && input.manifest !== null ? input.manifest : {}
  const dependencies = Array.isArray(input.dependencyNames) ? input.dependencyNames : []
  const stack = []
  const languages = []
  const push = (list, value) => {
    if (typeof value === 'string' && value.length > 0 && !list.includes(value)) list.push(value)
  }

  if (files.includes('package.json')) {
    push(languages, 'JavaScript/TypeScript')
    const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) }
    for (const name of ['react', 'vue', 'svelte', 'next', 'nuxt', 'express', 'fastify', 'electron', 'vite', 'cordis']) {
      if (Object.hasOwn(deps, name)) push(stack, name)
    }
    if (manifest.name === 'cordis' || Object.hasOwn(deps, '@deepseek-ai/cordis')) push(stack, 'dsh-plugin')
  }
  // Any harness package in the dependency set marks a DSH plugin/monorepo,
  // which is the one stack whose research should read like Cordis work.
  for (const name of dependencies) {
    if (name.startsWith('@deepseek-ai/')) push(stack, 'dsh-plugin')
  }
  if (files.includes('pyproject.toml') || files.includes('requirements.txt')) {
    push(languages, 'Python')
  }
  if (files.includes('Cargo.toml')) {
    push(languages, 'Rust')
  }
  if (files.includes('go.mod')) push(languages, 'Go')
  if (files.includes('pom.xml') || files.includes('build.gradle')) push(languages, 'JVM')
  if (files.includes('project.godot')) push(stack, 'godot')
  if (files.includes('*.uproject')) push(stack, 'unreal')
  if (files.includes('ProjectSettings')) push(stack, 'unity')
  for (const name of dependencies) {
    if (name.startsWith('@deepseek-ai/')) push(stack, 'dsh-plugin')
  }

  const existingProject = files.length > 0 && (
    files.includes('package.json') ||
    files.includes('pyproject.toml') ||
    files.includes('Cargo.toml') ||
    files.includes('go.mod') ||
    files.includes('.git') ||
    files.includes('README.md')
  )
  const signals = []
  if (existingProject) signals.push('existing-project')
  for (const entry of stack) signals.push(`stack:${entry}`)
  for (const entry of languages) signals.push(`language:${entry}`)
  // The harness stack is the most specific fact: a DSH plugin should research
  // Cordis work, not generic JavaScript.
  const ordered = stack.includes('dsh-plugin') ? ['dsh-plugin', ...stack.filter((entry) => entry !== 'dsh-plugin')] : stack
  return { existingProject, stack: ordered.slice(0, 6), languages: languages.slice(0, 4), signals }
}

/**
 * Secret shapes that must never leave the machine.
 *
 * The list covers the credential forms a requirement realistically carries:
 * vendor-prefixed tokens, cloud key-id prefixes, GitLab and Google tokens,
 * JWTs, private key blocks, and `NAME=value` assignments for the names that
 * the generic api/secret/token vocabulary does not reach (AWS's
 * `AWS_SECRET_ACCESS_KEY=...` hides its `secret` in the middle of the name).
 */
const SECRET_PATTERNS = [
  // Bearer and scheme-prefixed tokens.
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*\b/giu,
  // Vendor-prefixed tokens: GitHub (classic, fine-grained), OpenAI/Anthropic-style, Slack, GitLab, Stripe, npm.
  /\b(?:sk|pk|rk)[-_](?:proj[-_]|ant[-_]|svcacct[-_]|live[-_]|test[-_])?[A-Za-z0-9_-]{16,}\b/gu,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/gu,
  /\bnpm_[A-Za-z0-9]{24,}\b/gu,
  // Cloud key ids and Google API keys.
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/gu,
  /\bAIza[0-9A-Za-z_-]{30,}\b/gu,
  // Signed JWTs: three base64url segments.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  // Private key blocks.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/gu,
  // Assignment forms, including the names whose keyword sits mid-name.
  /\b[A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd|credential)\s*[:=]\s*\S+/giu,
  /\baws[_-]?(?:secret[_-]?access[_-]?key|access[_-]?key[_-]?id|session[_-]?token|security[_-]?token)\s*[:=]\s*\S+/giu,
  /\b(?:ssh|git)_[a-z0-9_]*key\s*[:=]\s*\S+/giu,
]

/** A run of token-shaped characters long enough to be a credential, not a word. */
const HIGH_ENTROPY_TOKEN = /(?<![A-Za-z0-9+/=_@-])[A-Za-z0-9+/=_-]{24,}(?![A-Za-z0-9+/=_-])/gu

/** Rough per-character entropy above which a token reads as random, not human. */
const HIGH_ENTROPY_BITS = 3.5

/**
 * Shannon entropy of one string, in bits per character.
 * @param {string} text - the text to measure.
 * @returns {number} the entropy.
 */
function entropy(text) {
  if (text.length === 0) return 0
  const counts = new Map()
  for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1)
  let total = 0
  for (const count of counts.values()) {
    const probability = count / text.length
    total -= probability * Math.log2(probability)
  }
  return total
}

/**
 * Remove credential-shaped material from free text.
 *
 * Shared by the requirement sanitizer and by the provider outbound boundary:
 * both must answer "can this string leave the process?" the same way, and a
 * provider that receives an already-planned query still needs the same last
 * line of defence.
 *
 * @param {string} text - text that may carry secrets.
 * @returns {{ text: string, redacted: string[] }} the stripped text and what was removed.
 */
export function stripSecrets(text) {
  let safe = String(text ?? '')
  const redacted = []
  for (const pattern of SECRET_PATTERNS) {
    safe = safe.replace(pattern, () => {
      redacted.push('secret')
      return ' '
    })
  }
  // No prefix list keeps up with credential issuance, so any long token-shaped
  // run with random-looking content goes too. The bar is deliberately high
  // (length plus entropy plus mixed content) so words, versions and ordinary
  // identifiers survive.
  safe = safe.replace(HIGH_ENTROPY_TOKEN, (token) => {
    const mixed = /[0-9]/u.test(token) && (/[a-z]/u.test(token) || /[A-Z]/u.test(token)) || /[a-z]/u.test(token) && /[A-Z]/u.test(token)
    if (mixed && entropy(token) >= HIGH_ENTROPY_BITS) {
      redacted.push('secret')
      return ' '
    }
    return token
  })
  return { text: safe, redacted: [...new Set(redacted)] }
}

/**
 * Strip material that must never leave the machine.
 *
 * The engine sends *the requirement text* to a search provider. A requirement
 * typed into a chat can contain a path, a token, a key=value secret or a pasted
 * block of private code, and none of that belongs in a third-party query. The
 * sanitizer keeps the task's meaning (product words, technology words) and
 * removes the shapes that carry secrets, then caps the length.
 *
 * @param {string} text - raw requirement text.
 * @param {{ maxChars?: number }} [options] - cap.
 * @returns {{ text: string, redacted: string[] }} the safe text and what was removed.
 */
export function sanitizeForResearch(text, options = {}) {
  const maxChars = Math.max(40, options.maxChars ?? 600)
  let safe = String(text ?? '')
  const redacted = []

  // Fenced code blocks carry project source; they are not search material.
  if (/```[\s\S]*?```/u.test(safe)) {
    safe = safe.replace(/```[\s\S]*?```/gu, ' ')
    redacted.push('code-block')
  }
  // Inline code long enough to be an identifier soup is dropped rather than sent.
  safe = safe.replace(/`([^`]{40,})`/gu, () => {
    redacted.push('inline-code')
    return ' '
  })
  const stripped = stripSecrets(safe)
  safe = stripped.text
  redacted.push(...stripped.redacted)
  // Absolute local paths (Windows and POSIX) describe a machine, not a task.
  safe = safe.replace(/(?:[A-Za-z]:\\[^\s"']+|\/(?:home|Users|root|var|opt)\/[^\s"']+)/gu, () => {
    redacted.push('local-path')
    return ' '
  })
  // Collapse whitespace so the query is a sentence, not a transcript.
  safe = safe.replace(/\s+/gu, ' ').trim()
  if (safe.length > maxChars) {
    safe = safe.slice(0, maxChars)
    redacted.push('truncated')
  }
  return { text: safe, redacted: [...new Set(redacted)] }
}

/**
 * Classify one turn: its text, its claimed messages, and what it means for research.
 *
 * The last message is the current request; earlier claimed messages are setup
 * for it, so classification reads the last one that looks like a task and
 * reports both the chosen text and the verdict.
 *
 * @param {Array<object>} messages - claimed messages for the step.
 * @returns {{ text: string, kind: string, label: string, shouldResearch: boolean, angles: number, reasons: string[], redacted: string[], sanitized: string }} the decision.
 */
export function classifyMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { text: '', kind: 'chat', label: TASK_KINDS.chat.label, domain: 'generic', shouldResearch: false, angles: 0, reasons: ['no-claims'], redacted: [], sanitized: '' }
  }
  // The *newest* message states the user's current intent. When it withdraws
  // the work, an older task statement further back in the batch must not be
  // picked up again: a cancelled requirement stays cancelled.
  let newest = ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messageText(messages[index]).trim()
    if (text.length > 0) {
      newest = text
      break
    }
  }
  if (newest.length > 0 && CANCELLED_PATTERNS.some((pattern) => pattern.test(newest))) {
    const { text: sanitized, redacted } = sanitizeForResearch(newest)
    return {
      text: newest,
      kind: 'chat',
      label: TASK_KINDS.chat.label,
      domain: 'generic',
      shouldResearch: false,
      angles: 0,
      reasons: ['cancel-intent'],
      redacted,
      sanitized,
    }
  }
  let chosen = ''
  let verdict = { kind: 'chat', label: TASK_KINDS.chat.label, research: false, angles: 0, reasons: ['no-task'] }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messageText(messages[index]).trim()
    if (text.length === 0) continue
    const candidate = classifyText(text)
    if (candidate.research) {
      chosen = text
      verdict = candidate
      break
    }
    // Remember the most recent non-research verdict only when nothing else matched.
    if (chosen.length === 0) verdict = candidate
  }
  const { text: sanitized, redacted } = sanitizeForResearch(chosen)
  const domain = detectDomains(sanitized.length > 0 ? sanitized.toLowerCase() : chosen.toLowerCase()).domain
  return {
    text: chosen,
    kind: verdict.kind,
    label: verdict.label,
    domain,
    shouldResearch: verdict.research && sanitized.length >= 4,
    angles: verdict.angles,
    reasons: verdict.reasons,
    redacted,
    sanitized,
  }
}

/**
 * Whether a claimed message is a requirement statement (wish-detector parity).
 *
 * Kept so the older binary detector and this classifier cannot drift apart:
 * both answer the same question through the same vocabulary.
 *
 * @param {unknown} message - the message to judge.
 * @returns {boolean} true when the message reads as a task worth researching.
 */
export function isResearchableMessage(message) {
  return classifyText(messageText(message)).research
}
