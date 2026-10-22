/**
 * Requirement → association plan.
 *
 * The panel is not a keyword search box: a requirement is *translated into the
 * angles a person would actually look at while borrowing from the web*. A
 * management-sim game asks for comparable titles, the mechanics other games
 * borrow, the economy numbers, open-source implementations, and postmortems —
 * not for the words of the sentence itself.
 *
 * Everything here is pure so the plan can be unit tested without a host.
 */

/** Words that put a requirement in the game domain. */
const GAME_WORDS = [
  '游戏', 'game', 'games', '关卡', '玩法', 'roguelike', 'roguelite', 'rpg', 'slg', 'sim',
  '模拟', '经营', '塔防', '卡牌', '像素', 'unity', 'godot', 'unreal', 'rts', 'fps', 'galgame',
]

/** Words that put a requirement in the DSH/plugin domain. */
const PLUGIN_WORDS = [
  '插件', 'plugin', 'extension', '扩展', 'dsh', 'harness', 'tool', '工具', '技能', 'skill',
  'mcp', 'hook', '中间件', 'middleware', 'bundle',
]

/** Words that put a requirement in the web/frontend domain. */
const WEB_WORDS = [
  '网页', '网站', '前端', 'web', 'webapp', 'app', '界面', 'ui', 'ux', '页面', 'dashboard',
  '后台', '管理台', '小程序', 'electron', 'react', 'vue',
]

/**
 * One association angle: an id (translated by the client), a rationale key, and
 * a query template. `{kw}` is replaced with the requirement's keywords and
 * `{topic}` with the matched domain phrase.
 *
 * `zh` templates are used for Chinese requirements and `en` for the rest.
 */
const ANGLES = {
  game: [
    {
      id: 'similar',
      zh: '{kw} 同类游戏 推荐 玩法',
      en: 'games similar to {kw} recommendations',
    },
    {
      id: 'mechanics',
      zh: '{kw} 玩法 机制 设计 拆解',
      en: '{kw} game mechanics design breakdown',
    },
    {
      id: 'economy',
      zh: '{kw} 数值 经济 系统 平衡 设计',
      en: '{kw} game economy balance design',
    },
    {
      id: 'reference',
      zh: '{kw} 开源 复刻 github 源码',
      en: '{kw} open source clone github',
    },
    {
      id: 'pitfalls',
      zh: '{kw} 开发 复盘 踩坑 经验',
      en: '{kw} postmortem lessons learned',
    },
  ],
  plugin: [
    {
      id: 'similar',
      zh: '{kw} 开源 类似实现',
      en: '{kw} open source alternative',
    },
    {
      id: 'mechanics',
      zh: '{kw} 架构 注册 生命周期 设计',
      en: '{kw} architecture lifecycle design',
    },
    {
      id: 'reference',
      zh: '{kw} github 源码 实现',
      en: '{kw} github implementation source',
    },
    {
      id: 'pitfalls',
      zh: '{kw} 踩坑 兼容 版本',
      en: '{kw} pitfalls compatibility versions',
    },
  ],
  web: [
    {
      id: 'similar',
      zh: '{kw} 网站 案例 参考 设计',
      en: '{kw} website examples reference design',
    },
    {
      id: 'mechanics',
      zh: '{kw} 交互 流程 设计 最佳实践',
      en: '{kw} interaction flow best practices',
    },
    {
      id: 'reference',
      zh: '{kw} github 开源 模板',
      en: '{kw} open source template github',
    },
    {
      id: 'pitfalls',
      zh: '{kw} 前端 踩坑 性能 兼容',
      en: '{kw} frontend pitfalls performance',
    },
  ],
  generic: [
    {
      id: 'similar',
      zh: '{kw} 类似 方案 案例',
      en: '{kw} similar solutions examples',
    },
    {
      id: 'mechanics',
      zh: '{kw} 原理 机制 设计 思路',
      en: '{kw} how it works design',
    },
    {
      id: 'reference',
      zh: '{kw} github 开源 实现',
      en: '{kw} github open source implementation',
    },
    {
      id: 'pitfalls',
      zh: '{kw} 踩坑 经验 注意',
      en: '{kw} pitfalls lessons learned',
    },
  ],
}

/** Angles that always run, whatever the domain. */
const CORE_ANGLES = ['similar', 'reference', 'pitfalls']

/** Cap on one generated query, in characters, matching search-engine habits. */
const MAX_QUERY_CHARS = 96

/**
 * Pick the domain whose vocabulary the keywords hit.
 * @param {string[]} keywords - extracted keywords.
 * @returns {'game' | 'plugin' | 'web' | 'generic'} the winning domain.
 */
export function detectDomain(keywords) {
  const score = (words) => keywords.filter((keyword) => words.some((word) => keyword.includes(word) || word.includes(keyword))).length
  const scores = [
    ['game', score(GAME_WORDS)],
    ['plugin', score(PLUGIN_WORDS)],
    ['web', score(WEB_WORDS)],
  ]
  scores.sort((left, right) => right[1] - left[1])
  return scores[0][1] > 0 ? /** @type {'game'} */ (scores[0][0]) : 'generic'
}

/**
 * Join the strongest keywords into the `{kw}` slot of a template.
 *
 * Game and plugin requirements read best with two or three words; more than
 * that and search engines start matching unrelated pages.
 *
 * @param {string[]} keywords - extracted keywords, best first.
 * @param {number} [limit] - how many to keep.
 * @returns {string} a space-joined keyword phrase.
 */
export function keywordPhrase(keywords, limit = 3) {
  return keywords.slice(0, Math.max(1, limit)).join(' ').trim()
}

/**
 * Build the association plan for one requirement.
 *
 * @param {string} requirement - the user's requirement.
 * @param {string[]} keywords - output of `extractKeywords`.
 * @param {{ maxAngles?: number }} [options] - caps.
 * @returns {{ domain: string, language: 'zh' | 'en', keywords: string[], angles: Array<{ id: string, query: string }> }} the plan.
 */
export function buildAssociationPlan(requirement, keywords, options = {}) {
  const maxAngles = Math.max(1, options.maxAngles ?? 4)
  const language = /[\u3400-\u9fff]/u.test(String(requirement ?? '')) ? 'zh' : 'en'
  const domain = detectDomain(keywords)
  const catalogue = ANGLES[domain] ?? ANGLES.generic

  // `{kw}` falls back to the requirement itself when extraction found nothing,
  // so a one-word requirement still produces usable queries.
  const phrase = keywordPhrase(keywords) || String(requirement ?? '').replace(/\s+/gu, ' ').trim().slice(0, 40)

  const chosen = []
  // Always run the core angles first, then the domain's remaining ones.
  for (const id of CORE_ANGLES) {
    const angle = catalogue.find((entry) => entry.id === id)
    if (angle !== undefined) chosen.push(angle)
  }
  for (const angle of catalogue) if (!chosen.includes(angle)) chosen.push(angle)

  return {
    domain,
    language,
    keywords,
    angles: chosen.slice(0, maxAngles).map((angle) => ({
      id: angle.id,
      query: (language === 'zh' ? angle.zh : angle.en).replace('{kw}', phrase).slice(0, MAX_QUERY_CHARS),
    })),
  }
}
