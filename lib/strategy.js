/**
 * Research strategy: which angles to search, for which kind of task.
 *
 * One search system, many task shapes. A game needs comparable titles and its
 * economy; a web app needs a permission model and a caching design; a bug fix
 * needs the upstream issue that already describes the failure. Writing a
 * separate searcher per domain would rot, so the differences live here as data:
 * a *kind* strategy (what the task is) composed with a *domain* strategy (what
 * the task is about), plus a project-aware overlay that turns greenfield
 * queries into "how does this stack already solve it" queries.
 *
 * Every angle carries a `purpose`: the panel shows it, and the model gets it in
 * the briefing, so a result reads as "the licence question" rather than as an
 * anonymous list of links.
 *
 * Pure module: no I/O, so the plan is unit-testable.
 */

/** Domain strategies: angle id → query template and purpose. */
const DOMAIN_ANGLES = {
  game: [
    { id: 'similar', zh: '{kw} 同类游戏 推荐 玩法', en: 'games similar to {kw} recommendations', purpose: 'comparable titles' },
    { id: 'mechanics', zh: '{kw} 玩法 机制 设计 拆解', en: '{kw} game mechanics design breakdown', purpose: 'mechanics design' },
    { id: 'economy', zh: '{kw} 数值 经济 系统 平衡 设计', en: '{kw} game economy balance design', purpose: 'numbers and economy' },
    { id: 'saves', zh: '{kw} 存档 系统 设计 实现', en: '{kw} save system design implementation', purpose: 'persistence and saves' },
    { id: 'reference', zh: '{kw} 开源 复刻 github 源码', en: '{kw} open source clone github', purpose: 'open-source implementations' },
    { id: 'pitfalls', zh: '{kw} 开发 复盘 踩坑 经验', en: '{kw} postmortem lessons learned', purpose: 'known pitfalls' },
  ],
  web: [
    { id: 'similar', zh: '{kw} 网站 案例 参考 设计', en: '{kw} website examples reference design', purpose: 'comparable products' },
    { id: 'mechanics', zh: '{kw} 交互 流程 设计 最佳实践', en: '{kw} interaction flow best practices', purpose: 'interaction and flows' },
    { id: 'auth', zh: '{kw} 权限 认证 设计 最佳实践', en: '{kw} authorization authentication design best practice', purpose: 'auth and permissions' },
    { id: 'data', zh: '{kw} 缓存 数据处理 架构', en: '{kw} caching data layer architecture', purpose: 'caching and data' },
    { id: 'reference', zh: '{kw} github 开源 模板', en: '{kw} open source template github', purpose: 'open-source templates' },
    { id: 'pitfalls', zh: '{kw} 前端 踩坑 性能 兼容', en: '{kw} frontend pitfalls performance compatibility', purpose: 'known pitfalls' },
  ],
  desktop: [
    { id: 'similar', zh: '{kw} 桌面应用 开源 参考', en: '{kw} desktop app open source reference', purpose: 'comparable apps' },
    { id: 'mechanics', zh: '{kw} 系统 API 生命周期 设计', en: '{kw} system API lifecycle design', purpose: 'platform APIs and lifecycle' },
    { id: 'ux', zh: '{kw} 桌面 交互 设计 规范', en: '{kw} desktop UX patterns guidelines', purpose: 'desktop interaction patterns' },
    { id: 'compat', zh: '{kw} 兼容性 打包 签名 更新', en: '{kw} packaging signing auto-update compatibility', purpose: 'packaging and compatibility' },
    { id: 'reference', zh: '{kw} github 开源 实现 electron tauri', en: '{kw} github implementation electron tauri', purpose: 'open-source implementations' },
    { id: 'pitfalls', zh: '{kw} 桌面 踩坑 兼容 问题', en: '{kw} desktop pitfalls compatibility issues', purpose: 'known pitfalls' },
  ],
  mobile: [
    { id: 'similar', zh: '{kw} 移动应用 案例 参考', en: '{kw} mobile app examples reference', purpose: 'comparable apps' },
    { id: 'mechanics', zh: '{kw} 移动端 生命周期 权限 设计', en: '{kw} mobile lifecycle permissions design', purpose: 'lifecycle and permissions' },
    { id: 'ux', zh: '{kw} 移动 交互 设计 规范', en: '{kw} mobile UX guidelines', purpose: 'interaction patterns' },
    { id: 'compat', zh: '{kw} 机型 兼容 性能 适配', en: '{kw} device compatibility performance', purpose: 'device compatibility' },
    { id: 'reference', zh: '{kw} github 开源 实现', en: '{kw} github open source implementation', purpose: 'open-source implementations' },
    { id: 'pitfalls', zh: '{kw} 移动 踩坑 审核 问题', en: '{kw} mobile pitfalls app review issues', purpose: 'known pitfalls' },
  ],
  ai: [
    { id: 'similar', zh: '{kw} 开源 框架 对比', en: '{kw} open source framework comparison', purpose: 'comparable frameworks' },
    { id: 'mechanics', zh: '{kw} 架构 设计 Agent 工具调用', en: '{kw} architecture agent tool calling design', purpose: 'architecture and tool calling' },
    { id: 'rag', zh: '{kw} RAG 检索 向量 方案', en: '{kw} RAG retrieval embedding approach', purpose: 'retrieval approach' },
    { id: 'eval', zh: '{kw} 评测 效果 指标', en: '{kw} evaluation metrics', purpose: 'evaluation' },
    { id: 'reference', zh: '{kw} github 开源 实现', en: '{kw} github open source implementation', purpose: 'open-source implementations' },
    { id: 'pitfalls', zh: '{kw} 踩坑 幻觉 上下文 限制', en: '{kw} pitfalls hallucination context limits', purpose: 'known pitfalls' },
  ],
  data: [
    { id: 'docs', zh: '{kw} 官方文档 说明', en: '{kw} official documentation', purpose: 'official documentation' },
    { id: 'similar', zh: '{kw} 方案 对比 选型', en: '{kw} approach comparison trade-offs', purpose: 'comparable approaches' },
    { id: 'mechanics', zh: '{kw} 原理 机制 内部实现', en: '{kw} how it works internals', purpose: 'mechanics' },
    { id: 'benchmark', zh: '{kw} 性能 基准 测试 数据', en: '{kw} benchmark performance data', purpose: 'benchmarks' },
    { id: 'reference', zh: '{kw} github 开源 实现', en: '{kw} github open source implementation', purpose: 'open-source implementations' },
    { id: 'pitfalls', zh: '{kw} 踩坑 边界 问题', en: '{kw} pitfalls edge cases', purpose: 'known pitfalls' },
  ],
  automation: [
    { id: 'similar', zh: '{kw} 脚本 方案 参考', en: '{kw} script approach examples', purpose: 'comparable scripts' },
    { id: 'mechanics', zh: '{kw} 库 工具 系统调用', en: '{kw} library system tooling', purpose: 'reliable libraries' },
    { id: 'robust', zh: '{kw} 错误处理 重试 幂等', en: '{kw} error handling retry idempotency', purpose: 'error handling' },
    { id: 'reference', zh: '{kw} github 开源 实现', en: '{kw} github open source implementation', purpose: 'open-source implementations' },
    { id: 'pitfalls', zh: '{kw} 踩坑 兼容 权限', en: '{kw} pitfalls compatibility permissions', purpose: 'known pitfalls' },
  ],
  enterprise: [
    { id: 'similar', zh: '{kw} 企业系统 案例 参考', en: '{kw} enterprise system reference', purpose: 'comparable systems' },
    { id: 'mechanics', zh: '{kw} 权限模型 RBAC 设计', en: '{kw} RBAC permission model design', purpose: 'permission model' },
    { id: 'audit', zh: '{kw} 审计 日志 事务 一致性', en: '{kw} audit log transaction consistency', purpose: 'audit and consistency' },
    { id: 'compliance', zh: '{kw} 合规 安全 要求', en: '{kw} compliance security requirements', purpose: 'compliance' },
    { id: 'reference', zh: '{kw} github 开源 实现', en: '{kw} github open source implementation', purpose: 'open-source implementations' },
    { id: 'pitfalls', zh: '{kw} 踩坑 数据 一致 问题', en: '{kw} pitfalls data consistency issues', purpose: 'known pitfalls' },
  ],
  plugin: [
    { id: 'similar', zh: '{kw} 开源 类似实现', en: '{kw} open source alternative', purpose: 'comparable plugins' },
    { id: 'mechanics', zh: '{kw} 架构 注册 生命周期 设计', en: '{kw} architecture lifecycle design', purpose: 'architecture and lifecycle' },
    { id: 'reference', zh: '{kw} github 源码 实现', en: '{kw} github implementation source', purpose: 'open-source implementations' },
    { id: 'pitfalls', zh: '{kw} 踩坑 兼容 版本', en: '{kw} pitfalls compatibility versions', purpose: 'known pitfalls' },
  ],
  generic: [
    { id: 'similar', zh: '{kw} 类似 方案 案例', en: '{kw} similar solutions examples', purpose: 'comparable work' },
    { id: 'mechanics', zh: '{kw} 原理 机制 设计 思路', en: '{kw} how it works design', purpose: 'mechanics' },
    { id: 'reference', zh: '{kw} github 开源 实现', en: '{kw} github open source implementation', purpose: 'open-source implementations' },
    { id: 'pitfalls', zh: '{kw} 踩坑 经验 注意', en: '{kw} pitfalls lessons learned', purpose: 'known pitfalls' },
  ],
}

/** Kind strategies: extra angles that only make sense for that kind of work. */
const KIND_ANGLES = {
  bug: [
    { id: 'issue', zh: '{kw} 报错 issue 原因 解决', en: '{kw} error issue root cause fix', purpose: 'known failure causes' },
    { id: 'patch', zh: '{kw} 修复 补丁 commit', en: '{kw} fix patch commit', purpose: 'upstream patches' },
    { id: 'regression', zh: '{kw} 回归测试 复现', en: '{kw} regression test reproduce', purpose: 'reproduction and regression tests' },
  ],
  performance: [
    { id: 'bottleneck', zh: '{kw} 性能 瓶颈 分析', en: '{kw} performance bottleneck analysis', purpose: 'known bottlenecks' },
    { id: 'benchmark', zh: '{kw} 基准 测试 数据', en: '{kw} benchmark numbers', purpose: 'benchmarks' },
    { id: 'proven', zh: '{kw} 优化 实践 案例', en: '{kw} optimization proven techniques', purpose: 'proven optimizations' },
  ],
  architecture: [
    { id: 'similar', zh: '{kw} 架构 方案 对比', en: '{kw} architecture options comparison', purpose: 'architecture options' },
    { id: 'tradeoffs', zh: '{kw} 取舍 复杂度 权衡', en: '{kw} trade-offs complexity', purpose: 'trade-offs' },
    { id: 'reference', zh: '{kw} 开源 参考架构 github', en: '{kw} open source reference architecture github', purpose: 'reference architectures' },
  ],
  dependency: [
    { id: 'alternatives', zh: '{kw} 库 对比 替代', en: '{kw} library comparison alternatives', purpose: 'alternatives' },
    { id: 'license', zh: '{kw} 许可证 维护 状态', en: '{kw} license maintenance status', purpose: 'licence and maintenance' },
    { id: 'security', zh: '{kw} 漏洞 安全 公告 CVE', en: '{kw} vulnerability security advisory CVE', purpose: 'security advisories' },
  ],
  test: [
    { id: 'strategy', zh: '{kw} 测试 策略 用例 设计', en: '{kw} testing strategy test case design', purpose: 'test strategy' },
    { id: 'edge', zh: '{kw} 边界 场景 异常 用例', en: '{kw} edge cases boundary scenarios', purpose: 'edge cases' },
    { id: 'reference', zh: '{kw} 测试 框架 实践', en: '{kw} test framework practice', purpose: 'tooling and practice' },
  ],
  refactor: [
    { id: 'patterns', zh: '{kw} 重构 模式 实例', en: '{kw} refactoring patterns examples', purpose: 'refactoring patterns' },
    { id: 'migration', zh: '{kw} 迁移 兼容 步骤', en: '{kw} migration compatibility steps', purpose: 'migration path' },
  ],
  automation: [
    { id: 'robust', zh: '{kw} 错误处理 重试 幂等', en: '{kw} error handling retry idempotency', purpose: 'error handling' },
  ],
}

/** Kinds whose angles are already fully described by their kind strategy. */
const KIND_FIRST = new Set(['bug', 'performance', 'architecture', 'dependency', 'test'])

/** Cap on one generated query, in characters, matching search-engine habits. */
const MAX_QUERY_CHARS = 110

/**
 * Join the strongest keywords into the `{kw}` slot of a template.
 *
 * Two or three words read best: more than that and search engines start
 * matching unrelated pages.
 *
 * @param {string[]} keywords - extracted keywords, best first.
 * @param {number} [limit] - how many to keep.
 * @returns {string} a space-joined keyword phrase.
 */
export function keywordPhrase(keywords, limit = 3) {
  const words = Array.isArray(keywords) ? keywords.slice(0, Math.max(1, limit)) : []
  return words.join(' ').trim()
}

/**
 * Build the research plan for one task.
 *
 * Composition order: the kind's own angles first (a bug fix is about the bug),
 * then the domain's angles, then the generic fallbacks, de-duplicated by id and
 * capped. A project-aware overlay appends the stack's own name to a query so a
 * reference is relevant to *this* project rather than to the genre in general.
 *
 * @param {object} input - the task facts.
 * @param {string} input.kind - task kind from the classifier.
 * @param {string} input.domain - primary domain from the classifier.
 * @param {string[]} input.keywords - extracted keywords.
 * @param {string} input.language - 'zh' or 'en'.
 * @param {{ existingProject?: boolean, stack?: string[] }} [input.project] - project facts.
 * @param {{ maxAngles?: number }} [options] - cap.
 * @returns {{ kind: string, domain: string, language: string, keywords: string[], angles: Array<{ id: string, purpose: string, query: string }> }} the plan.
 */
export function buildPlan(input, options = {}) {
  const kind = typeof input.kind === 'string' && input.kind.length > 0 ? input.kind : 'feature'
  const domain = typeof input.domain === 'string' && DOMAIN_ANGLES[input.domain] !== undefined ? input.domain : 'generic'
  const keywords = Array.isArray(input.keywords) ? input.keywords : []
  const language = input.language === 'zh' ? 'zh' : 'en'
  const maxAngles = Math.max(1, options.maxAngles ?? 4)
  const project = input.project ?? {}

  const phrase = keywordPhrase(keywords) || String(input.requirement ?? '').replace(/\s+/gu, ' ').trim().slice(0, 48)
  const stackHint = Array.isArray(project.stack) && project.stack.length > 0
    ? project.stack.filter((entry) => entry !== 'dsh-plugin').slice(0, 1)
    : []

  const catalogue = []
  const seen = new Set()
  const push = (angle, extra = '') => {
    if (angle === undefined || seen.has(angle.id)) return
    seen.add(angle.id)
    const template = language === 'zh' ? angle.zh : angle.en
    const keywordPhraseText = extra.length > 0 ? `${phrase} ${extra}` : phrase
    catalogue.push({
      id: angle.id,
      purpose: angle.purpose,
      query: template.replace('{kw}', keywordPhraseText).slice(0, MAX_QUERY_CHARS),
    })
  }

  if (options.officialFirst === true) {
    push({
      id: 'official',
      zh: '{kw} 最新 官方文档 版本 迁移指南',
      en: '{kw} latest official documentation release migration guide',
      purpose: 'current official version and compatibility facts',
    })
  }

  if (KIND_FIRST.has(kind)) for (const angle of KIND_ANGLES[kind] ?? []) push(angle)

  // A project-aware overlay comes before the generic fallbacks: when the
  // repository already exists, "how does *this* stack solve it" is a better
  // question than a genre-wide one, so it must survive the angle cap.
  const stackAngle = project.existingProject === true && stackHint.length > 0
    ? {
        id: 'stack',
        purpose: 'this stack’s approach',
        query: (language === 'zh' ? '{kw} {stack} 实践 方案' : '{kw} {stack} implementation practice')
          .replace('{kw}', phrase)
          .replace('{stack}', stackHint[0])
          .slice(0, MAX_QUERY_CHARS),
      }
    : undefined
  if (stackAngle !== undefined) {
    const domainAngles = DOMAIN_ANGLES[domain]
    const firstDomain = domainAngles[0]
    if (firstDomain !== undefined) {
      if (seen.has(firstDomain.id)) {
        catalogue.push(stackAngle)
        seen.add(stackAngle.id)
      } else {
        push(firstDomain)
        catalogue.push(stackAngle)
        seen.add(stackAngle.id)
      }
    }
  }

  for (const angle of DOMAIN_ANGLES[domain]) push(angle)
  if (!KIND_FIRST.has(kind)) for (const angle of KIND_ANGLES[kind] ?? []) push(angle)
  for (const angle of DOMAIN_ANGLES.generic) push(angle)

  return {
    kind,
    domain,
    language,
    keywords,
    angles: catalogue.slice(0, maxAngles),
  }
}

/**
 * Describe a plan in one line, for the run record and the panel.
 * @param {{ kind: string, domain: string, angles: Array<object> }} plan - the plan.
 * @returns {string} the description.
 */
export function describePlan(plan) {
  const ids = plan.angles.map((angle) => angle.id).join(', ')
  return `${plan.kind} · ${plan.domain} · ${plan.angles.length} angle(s): ${ids}`
}
