/**
 * Pure helpers for the requirement-to-web search panel.
 *
 * Nothing here performs I/O, so the module can be unit tested without a host:
 * keyword extraction (what the user's requirement is actually about), the
 * query builder, the Bing RSS parser used as the keyless fallback, and the
 * source normalizer that both providers feed into.
 */

/** Function words and filler that carry no search signal in Chinese. */
const ZH_STOPWORDS = new Set([
  '的', '了', '和', '与', '及', '或', '是', '而', '就', '都', '也', '又', '还', '很', '更', '最',
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '咱们', '自己', '大家',
  '一个', '一种', '一些', '一样', '这个', '那个', '这些', '那些', '这样', '那样', '这里', '那里',
  '什么', '怎么', '怎样', '如何', '为什么', '哪些', '哪个', '多少',
  '可以', '需要', '应该', '必须', '能够', '希望', '想要', '打算', '准备', '要求',
  '帮', '帮我', '请', '麻烦', '写', '做', '搞', '弄', '实现', '支持', '提供', '使用', '用',
  '带', '带有', '加上', '增加', '要有', '要有', '需要', '想要', '做个', '做一个',
  '一下', '一点', '以及', '还有', '并且', '而且', '但是', '不过', '因为', '所以', '如果',
  '的时候', '之后', '以后', '之前', '现在', '然后', '还是', '就是', '不是', '没有', '不会',
  '里', '中', '上', '下', '等', '让', '把', '被', '对', '从', '到', '在', '向', '给', '跟',
  '其', '之', '于', '为', '以', '并', '则', '吧', '呢', '吗', '啊', '呀', '哦', '嗯',
  '功能', '东西', '这样', '那样', '问题', '情况', '时候', '方面', '提出', '需求',
  '要能', '能够', '可以', '还要', '然后', '比如', '例如', '同时', '以及', '并且',
  '最好', '尽量', '至少', '全部', '所有', '其他', '其它', '这样', '如何', '是否',
])

/** Function words that carry no search signal in English. */
const EN_STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'and', 'or', 'to', 'in', 'on', 'at', 'by', 'as', 'from',
  'with', 'without', 'that', 'this', 'these', 'those', 'it', 'its', 'we', 'you', 'i', 'me',
  'my', 'our', 'your', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
  'build', 'create', 'make', 'write', 'implement', 'add', 'need', 'needs', 'want', 'wants',
  'please', 'help', 'using', 'use', 'used', 'about', 'into', 'via', 'per', 'than', 'then',
  'so', 'if', 'when', 'where', 'what', 'which', 'who', 'how', 'why', 'all', 'any', 'some',
  'one', 'two', 'also', 'just', 'like', 'get', 'got', 'let', 'make',
])

/** Caps on one generated query, in characters, matching search-engine habits. */
const MAX_QUERY_CHARS = 120
/** Caps on one keyword, in characters; longer tokens are identifiers, not topics. */
const MAX_KEYWORD_CHARS = 32

/**
 * Domain compounds ICU splits apart (侧边栏 → 侧边 | 栏), plus the loanwords a
 * requirement in this space keeps using. Matching these before segmentation
 * keeps the query readable to a search engine.
 *
 * Longest first, so a shorter entry cannot pre-empt a longer one.
 */
const KNOWN_COMPOUNDS = [
  '模拟经营', '角色扮演', '经营策略', 'roguelike', 'roguelite', '开放世界',
  '侧边栏', '侧栏', '工作区', '插件市场', '插件管理器', '工具调用', '系统提示词',
  '管理后台', '仪表盘', '响应式', '拖拽排序', '实时协作',
  '开源实现', '数值平衡', '关卡设计', '游戏循环', '经济系统',
  // Technical compounds ICU splits into single ideographs, which would either
  // be dropped as too short or glued onto a neighbouring verb ("带" + "鉴权").
  '鉴权', '认证', '权限', '登录', '注册', '数据库', '缓存', '部署', '测试', '接口',
  '架构', '性能', '并发', '事务', '多租户', '审计', '日志', '导出', '导入', '上传',
  '下载', '搜索', '推荐', '支付', '订阅', '消息', '队列', '定时', '爬虫', '解析',
].sort((left, right) => right.length - left.length)

/**
 * Split known compounds out of a segment stream.
 *
 * @param {string} text - the source text.
 * @returns {Array<{ start: number, end: number, word: string }>} compound hits, left to right.
 */
function findCompounds(text) {
  const hits = []
  for (const compound of KNOWN_COMPOUNDS) {
    let from = 0
    for (;;) {
      const at = text.indexOf(compound, from)
      if (at === -1) break
      // Overlapping hits cannot both be real: the earlier, longer one wins.
      if (!hits.some((hit) => at < hit.end && hit.start < at + compound.length)) {
        hits.push({ start: at, end: at + compound.length, word: compound })
      }
      from = at + compound.length
    }
  }
  return hits.sort((left, right) => left.start - right.start)
}

/**
 * Whether the text uses CJK ideographs (which decides the fallback market).
 * @param {string} text - arbitrary text.
 * @returns {boolean} true when at least one CJK ideograph is present.
 */
export function hasCjk(text) {
  return /[\u3400-\u9fff]/u.test(text)
}

/**
 * Turn a free-form requirement into search keywords.
 *
 * Chinese has no spaces, so word segmentation comes from `Intl.Segmenter`
 * when the runtime provides it; otherwise the text is split on whitespace and
 * punctuation, which still works for English and for mixed inputs.
 *
 * @param {string} text - the user's requirement.
 * @param {number} [limit] - maximum keywords kept, in first-occurrence order.
 * @returns {string[]} lowercased, de-duplicated keywords.
 */
export function extractKeywords(text, limit = 6) {
  const source = String(text ?? '')
  const keywords = []
  const seen = new Set()
  const push = (raw) => {
    const word = raw.trim().toLowerCase()
    if (word.length === 0) return
    const cjk = /^[\u3400-\u9fff]+$/u.test(word)
    if (cjk) {
      if (word.length < 2 || ZH_STOPWORDS.has(word)) return
    } else {
      if (word.length < 2 || word.length > MAX_KEYWORD_CHARS || EN_STOPWORDS.has(word)) return
      if (!/[a-z0-9]/i.test(word)) return
    }
    if (seen.has(word)) return
    seen.add(word)
    keywords.push(word)
  }

  // Domain compounds ICU would split (侧边栏 → 侧边 | 栏) are matched first and
  // removed from the text so segmentation cannot produce their fragments.
  const compounds = findCompounds(source)
  let remaining = source
  if (compounds.length > 0) {
    const chars = [...source]
    for (const hit of compounds) for (let at = hit.start; at < hit.end; at += 1) chars[at] = ' '
    remaining = chars.join('')
  }
  // Latin-script identifiers and technical terms are the strongest signal in a
  // mixed sentence, and they must not be crowded out by generic Chinese words:
  // 「用 Rust 写一个命令行工具，解析 CSV」 is about Rust and CSV, not about
  // 解析. They therefore take the front of the capped list, in their original
  // order; domain compounds come next, then the segmented CJK words.
  for (const match of remaining.matchAll(/[A-Za-z][A-Za-z0-9.+#_-]{1,}/gu)) push(match[0])
  for (const hit of compounds) push(hit.word)

  let segmented = false
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      const segmenter = new Intl.Segmenter(hasCjk(remaining) ? 'zh-Hans' : 'en', { granularity: 'word' })
      // ICU leaves some common two-character words unsplit (插件 → 插 | 件), so a
      // run of neighbouring single ideographs is joined before it is filtered:
      // dropping one-character tokens would lose exactly those words. A single
      // ideograph that is a known function word ends the run instead of joining
      // it, so 「帮我写」 does not become one long token.
      let pending = ''
      const flush = () => {
        if (pending.length > 0) push(pending)
        pending = ''
      }
      for (const part of segmenter.segment(remaining)) {
        if (!part.isWordLike) {
          flush()
          continue
        }
        if (/^[\u3400-\u9fff]$/u.test(part.segment)) {
          if (ZH_STOPWORDS.has(part.segment)) flush()
          else pending += part.segment
          continue
        }
        flush()
        push(part.segment)
      }
      flush()
      segmented = true
    } catch {
      // Fall through to the punctuation split below.
    }
  }
  if (!segmented) {
    for (const part of source.split(/[^\p{L}\p{N}_]+/u)) push(part)
  }

  return keywords.slice(0, Math.max(1, limit))
}

/**
 * Build the single query sent to the search provider.
 *
 * @param {string} text - the user's requirement, used verbatim when it yields no keywords.
 * @param {string[]} keywords - output of {@link extractKeywords}.
 * @returns {string} a non-empty query, at most {@link MAX_QUERY_CHARS} characters.
 */
export function buildQuery(text, keywords) {
  const joined = keywords.join(' ').trim()
  const basis = joined.length > 0 ? joined : String(text ?? '').replace(/\s+/gu, ' ').trim()
  return basis.slice(0, MAX_QUERY_CHARS)
}

/**
 * Decode the XML entities Bing's RSS feed uses.
 * @param {string} value - raw element text.
 * @returns {string} plain text.
 */
function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gu, '&')
    .replace(/<[^>]*>/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Parse a Bing RSS result document into sources.
 *
 * The RSS form is used instead of the HTML page because it is a stable,
 * documented shape and it needs no key: one `<item>` carries title, link and
 * description.
 *
 * @param {string} xml - the feed body.
 * @returns {Array<{ url: string, title: string, snippet?: string }>} parsed sources.
 */
export function parseBingRss(xml) {
  const sources = []
  for (const match of String(xml ?? '').matchAll(/<item>([\s\S]*?)<\/item>/gu)) {
    const block = match[1]
    const pick = (tag) => {
      const found = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'u'))
      return found === null ? '' : decodeXml(found[1])
    }
    const url = pick('link')
    if (!/^https?:\/\//iu.test(url)) continue
    const snippet = pick('description')
    sources.push({
      url,
      title: pick('title') || url,
      ...(snippet.length > 0 ? { snippet } : {}),
    })
  }
  return sources
}

/**
 * Normalize one source object from any provider, dropping malformed entries.
 * @param {unknown} value - a provider source.
 * @returns {{ url: string, title?: string, snippet?: string, publishedAt?: string } | undefined} the source.
 */
export function normalizeSource(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const { url, title, snippet, publishedAt } = /** @type {Record<string, unknown>} */ (value)
  if (typeof url !== 'string' || !/^https?:\/\//iu.test(url)) return undefined
  return {
    url,
    ...(typeof title === 'string' && title.length > 0 ? { title } : {}),
    ...(typeof snippet === 'string' && snippet.length > 0 ? { snippet } : {}),
    ...(typeof publishedAt === 'string' && publishedAt.length > 0 ? { publishedAt } : {}),
  }
}

/**
 * Validate, de-duplicate (by URL) and cap a source list.
 * @param {unknown} list - provider sources, possibly malformed.
 * @param {number} max - result cap.
 * @returns {Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>} clean sources.
 */
export function normalizeSources(list, max) {
  const sources = []
  const seen = new Set()
  for (const entry of Array.isArray(list) ? list : []) {
    const source = normalizeSource(entry)
    if (source === undefined) continue
    const key = source.url.replace(/#.*$/u, '')
    if (seen.has(key)) continue
    seen.add(key)
    sources.push(source)
    if (sources.length >= max) break
  }
  return sources
}

/**
 * Normalize one `ctx.web.search()` result.
 * @param {unknown} result - the provider's outcome.
 * @param {number} max - result cap.
 * @returns {{ sources: Array<object>, truncated: boolean, answer?: string }} clean result pieces.
 */
export function normalizeWebResult(result, max) {
  const outcome = typeof result === 'object' && result !== null ? /** @type {Record<string, unknown>} */ (result) : {}
  const sources = normalizeSources(outcome.sources, max)
  const answer = typeof outcome.content === 'string' && outcome.content.trim().length > 0 ? outcome.content : undefined
  return {
    sources,
    truncated: outcome.truncated === true || (Array.isArray(outcome.sources) && outcome.sources.length > max),
    ...(answer === undefined ? {} : { answer }),
  }
}

/**
 * Render sources as a markdown list, for the panel's copy action.
 * @param {Array<{ url: string, title?: string, snippet?: string }>} sources - clean sources.
 * @returns {string} markdown with one link per line.
 */
export function sourcesToMarkdown(sources) {
  return sources
    .map((source, index) => {
      const label = source.title ?? source.url
      const suffix = source.snippet === undefined ? '' : ` — ${source.snippet}`
      return `${index + 1}. [${label}](${source.url})${suffix}`
    })
    .join('\n')
}
