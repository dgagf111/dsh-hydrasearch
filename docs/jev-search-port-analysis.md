# jev-search 的结合方式，以及能否搬到 dsh-hydrasearch

这份文档回答一个问题：`superagents-lab/jev-search` 是怎么把 **Jev 判断模型** 和 **搜索** 拼在一起的，同一套做法能不能用在 `dsh-hydrasearch` 上。

结论先给：**分工模式可以搬，但它的三个"产品级"特征搬不过来** —— 见 [第三节](#三搬不过来的三件事)。可搬的是那条更朴素、也更有价值的原则：**判断交给模型做结构化选择，生成与合并留在确定性代码里**。

具体建议：

| 问题 | 回答 |
| --- | --- |
| 同样的方式能否用在本仓库？ | **能，但只能搬到"检索之内"，搬不到"检索之外"。** Jev 可以在 provider 内部替换/强化"选源、选词、判切题、排序"，但 seam 只给了一个 `query` 入参和一个 `sources[]` 出参，所以流式、分数、交互三件产品级特性无处安放。 |
| 最值得先搬的是哪一块？ | **`candidates.ts` 的候选词生成**（纯函数、零依赖、可单测），以及 **`inferIntent` 的源/窗口判断**。这两块对现有代码零侵入。 |
| 最不值得搬的是哪一块？ | `rerank` 的阈值过滤——它会和"provider 不自己截断"这条已有纪律打架（见 2.2 / 3.2），而收益要拿中文实测来证明。 |
| 做之前必须先做的一件事？ | 拿一批真实中文查询做开/关对照实验（见 2.4）。TypeSafe 官方明确说 CJK 准确度不如英文。 |

> 方法与证据：jev-search 源码为 `git clone --depth 1` 到临时目录后逐文件阅读（引用格式 `文件:行`）；DSH 侧为仓库内 `node_modules` 的 rc.6 树 + 打包版 `app.asar` 里 0.1.7-alpha.1 树的实测；本机运行中的实例经 loopback bridge 实测。

---

## 一、jev-search 的分工：判断与检索彻底分离

一句话：**Jev 从不出结果，也从不生成答案；它只回答"去哪儿搜、搜什么词、什么时候的东西、这条结果算不算切题"。**

`src/lib/pipeline.ts:106` 的 `askStream()` 是整个流程的唯一入口，它做的事可以拆成两次判断夹一段检索：

| 阶段 | 谁做 | 产物 |
| --- | --- | --- |
| 0. 投机检索 | Search1API | Google + 用户原话，和判断**并发**发出 |
| 1. 理解请求 | **Jev** | 时间窗、想要哪些源、用哪个候选查询词、实体名 |
| 2. 逐 lane 检索 | Search1API | 每个源的每个引擎一个请求，各自独立 |
| 3. 逐条判题 | **Jev** | 每条结果"是否在讲用户问的那件事"的概率 |
| 4. 排序 / 折叠 / 缓存 | 纯代码 | 见 `rank.ts` / `merge.ts` / `cache.ts` |

### 1.1 第一次判断：`inferIntent()` —— 一个请求问四类问题

`src/lib/typesafe.ts:310`。state 是 `{ request, now, candidates: {c0, c1, …} }`，questions 是四组：

```ts
questions.window = {
  type: 'choice',
  instructions: 'Does the request in `request` ask for recent results, and if so how recent? …',
  criteria: windowCriteria,          // any / 24h / 7d / 30d，description 直接当 rubric
}
for (const s of SOURCES) {
  questions[`source_${s.id}`] = {
    type: 'noul',
    instructions: `About \`request\`: ${s.ask.question}`,
    criteria: { true: s.ask.yes, false: s.ask.no },
  }
}
questions.query  = { type: 'choice', instructions: '…best keyword query…', criteria }  // c0..cn
questions.entity = { type: 'choice', instructions: '…just the name or title…', criteria }
```

三个细节值得注意：

1. **源判断是"每源一个 noul"，不是"选一个源"**。12 个源就发 12 条独立的是/否问题，各带自己的 yes/no rubric（`src/lib/sources.ts:46`）。这是 Jev 官方的 speculative fan-out 用法：多问不增延迟，多余的答案由代码忽略。
2. **`now` 作为 state 的一部分显式给出**（`typesafe.ts:353`），因为 Jev 自己不知道今天几号。
3. **没有任何一个问题让 Jev 生成查询词**。见下。

### 1.2 候选查询词是代码生成的，Jev 只负责挑

`src/lib/candidates.ts:1` 的注释把设计意图写得很直白：

> The judge (TypeSafe) selects, it does not generate, so code proposes the candidates and the judge picks the one most likely to work as an engine query.

`buildCandidates()`（`candidates.ts:80`）用正则生成 1–4 个候选：原话（永远排 c0）→ 去掉时间词/平台词/filler 的版本 → 去虚词的内容词版本 → 大写词与版本号组成的专名版本。中英文都覆盖（`TIME_PHRASES`、`FILLER_PHRASES` 都有中文分支）。

**这是最值得照搬的一条**：把"生成"留在确定性代码里，把"选择"交给模型。可复现、可测试、不产生幻觉查询词。

### 1.3 lane：源是逻辑概念，引擎才是请求

`src/lib/sources.ts:25` 的 `Lane`：

```ts
interface Lane { service: string; site?: string; timeFilter?: boolean; entityQuery?: boolean }
```

- Reddit / HN / GitHub 各跑**两个** lane：Google 加 `include_sites` 限定站内 + 专用引擎（`sources.ts:86`、`:98`、`:110`）。两个引擎都命中同一个 URL → 排序时"引擎一致数"加权。
- `timeFilter: false` 给 Wikipedia / IMDb / WeChat 这种不接受 `time_range` 的引擎（`:29`）。
- 一个源的所有 lane 并发跑，**一个引擎挂掉不拖垮整个源**（`pipeline.ts:184-199` 把错误收成 lane 级 `error` 字段）。

### 1.4 投机 Google

`pipeline.ts:119`：

```ts
// 0. Speculate: Google with the words as typed, fired alongside the judge.
const speculative: SearchParams = { query: candidates[0]!, service: 'google', maxResults: RESULTS_PER_LANE }
const speculativePromise = … runSearch(speculative).catch(() => null)
```

判断还没回来，Google 已经用原话发出去了。如果 Jev 最后选的就是 c0 且不要时间窗（多数事实型问题），结果直接复用；否则丢掉。这是纯延迟优化，不影响正确性。

### 1.5 第二次判断：`rerank()` —— 一批 noul

`src/lib/typesafe.ts:407`，`RERANK_BATCH = 40`（`:405`）：

```ts
questions[`r${i}`] = {
  type: 'noul',
  instructions: `Is \`results[${i}]\` about the subject the user asked for in \`request\`?`,
  criteria: {
    true: '…discusses the same subject…even briefly or as one of several topics',
    false: '…about something else that only shares words with the request (a different meaning of the same word, a different product, a person with the same name)…',
  },
}
```

判词刻意写"只共享字面的不同东西"——这正是关键词检索最主要的失败模式。批内 40 条，批间 `Promise.all` 并发（`:422`）。

### 1.6 排序与折叠是纯代码

`rank.ts:34` 的 `compareItems()`，次序就是页面上看到的次序：

```
relevance 降序 → engines.length 降序（几个引擎都命中）→ position 升序（引擎原始排名）
```

`clusterItems()`（`rank.ts:97`）按 `canonicalUrl()`（去 tracking 参数、`twitter.com`→`x.com`）或前 8 个词的规范化标题聚类，避免一个故事占五个位置。`merge.ts:10` 的 `mergeItems()` 把同一 URL 的多 lane 结果折成一行：engines 取并集、relevance 取 max、position 取 min。

### 1.7 流的形状

`src/routes/api/ask.ts:27` 输出 NDJSON，事件顺序是 `intent` → 若干 `found`（引擎已答、还没判题）→ 若干 `lane`（已判题）→ `done`。`pipeline.ts:268-281` 用 `Promise.race([Promise.race(inFlight.values()), wakeup])` 实现"哪个先完成就发哪个"，所以页面能先亮 source chip，再逐 lane 填结果。

`use-ask.ts:53` 的客户端 reducer 把 lane 按 URL 折进一个 `items` 数组。**注意折叠发生在客户端**，服务端只保证"每个 lane 各自有序"。

### 1.8 Jev 供应商链

`typesafe.ts:22` 的 `ProviderConfig` 有 `typesafe` / `vercel` / `cloudflare` 三条路，`judge-config.ts:77` 从环境变量组装，`systemOne()`（`typesafe.ts:273`）只在**中断类**错误上换供应商：

```ts
export function isProviderOutage(error: unknown): boolean {
  return error instanceof TypeSafeError && (error.status === 402 || error.status === 429 || error.status >= 500)
}
```

`400/401/422` 不重试（重试也是白重试），`signal.aborted` 一律不重试。这个"只在值得重试的错误上换、取消绝不换"的判断，和本仓库 `lib/index.js:1105-1116` 的规则是同一套。

---

## 二、为什么这套能搬到 DSH：先看 seam 到底给了什么

`ctx.web` 的 provider 契约窄得超出直觉。`@deepseek-ai/dsh-web` 的 `types.d.ts`：

```ts
// types.d.ts:13
export interface WebSearchRequest { readonly query: string; readonly maxResults?: number }
// types.d.ts:45
export interface WebSearchSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly publishedAt?: string   // provider-supplied ISO-8601
}
// types.d.ts:31
export interface WebSearchResult {
  readonly content?: string       // 可选：provider 生成的答案/摘要文本
  readonly sources: readonly WebSearchSource[]
  readonly truncated: boolean
}
// types.d.ts:97
export interface WebSearchProvider {
  readonly id: string
  available(): boolean            // 必须无网络
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}
```

**入口只有 `query` 和 `maxResults`。出口只有 URL / 标题 / 摘要 / 日期，外加一段可选文本。**

于是 jev-search 的每个部件都有确定去向，但去向只有三类：**塞进 `query`（代码侧决定）**、**塞进 `sources` 的顺序**、**塞进 `content` 文本**。

### 2.1 逐件对照

| jev-search | dsh-hydrasearch 的落点 | 是否无损 |
| --- | --- | --- |
| Jev 供应商链（typesafe/vercel/cloudflare） | 新增一个 `jev` 传输层 + 凭据中心 ref；沿用现有 failover 语义 | ✅ |
| Search1API `POST /search` | 已有的 `searchTinyfish`（`lib/tinyfish.js:200`）/ `searchAnysearch`（`lib/anysearch.js:151`） | ✅ |
| `SOURCE_PROB_THRESHOLD = 0.6` 选源 | AnySearch 侧：`tag` + `params`（实测 40 个 sub-domain 全覆盖）；TinyFish 侧：`includeDomains` / `domainType` | ⚠️ 源集合缩水，见 2.3 |
| lane 的 `include_sites` + 专用引擎 | AnySearch `social_media.social_media` + `params.type=reddit_post/x_latest/wechatmp…`；TinyFish 只有 `domain_type` | ⚠️ 部分 |
| `inferIntent()` | provider 内的一次 Jev 调用，在走链之前 | ✅ |
| `rerank()` 一批 noul | 收齐 sources 之后、返回之前的一次 Jev 调用 | ✅ |
| `compareItems()` 的 relevance 排序 | **只能体现为 `sources[]` 的数组顺序** | ⚠️ 分数不可见 |
| `clusterItems()` / `mergeItems()` | provider 内部照做即可（seam 不关心） | ✅ |
| `now` 注入 state | 直接用 `new Date()` | ✅ |
| 时间窗 `window` | TinyFish 可映射：`afterDate` / `beforeDate` / `recencyMinutes` / `domainType=news`；**AnySearch 没有任何时间过滤能力** | ⚠️ 单边 |
| NDJSON 流（`intent`/`found`/`lane`） | **无对应物**（`search()` 返回单个 Promise） | ❌ |
| 结果上的 relevance 百分比、可编辑 chip | **无对应物**（`WebSearchSource` 没有分数字段，也没有交互面） | ❌ |
| `cache.ts` 的 KV 缓存 | 可用 `ctx.storage`（`KvFacet`）或进程内 Map | ✅ |

### 2.2 一个必须保留的纪律：provider 不要自己截断

`docs/integration-notes.md:229` 已经写明这条：

> `ctx.web` 会用 `maxResults` 截断并置 `truncated: true`……provider 如果自己先截断，结果永远 `truncated: false`，**模型就不知道还有更多结果**。

Jev 层必须服从同一条：**判题 + 排序，但不切片**。让 seam 的 `capSources()`（`dsh-web/lib/index.js:134`）去切。这正是 jev-search"每个 lane 取 8 条、多源合并后交给上层"的翻版。

### 2.3 源集合要缩：TinyFish 没有站点限定，AnySearch 没有时间过滤

这是搬迁中最实际的一处降级，两条都经实测确认：

- **TinyFish**（`lib/tinyfish.js:129` 的 `searchParams`）只有 `domain_type`（`web`/`news`/`research_paper`）和 `include_domains`，**没有 `time_range`**，时间过滤靠 `after_date`/`before_date`/`recency_minutes`。
- **AnySearch**（实测 + Go struct 探针）请求结构里只有 `query`/`tag`/`params`/`zone`/`language`/`max_results` 六个字段。`time_range`/`freshness`/`start_date`/`end_date`/`include_sites`/`exclude_sites`/`sort` **全部被服务端静默忽略**；站内限定只能靠 query 里的 `site:` 算符。

所以：

- Jev 判出的时间窗，**只能对 TinyFish 生效**；AnySearch 侧要么忽略，要么拼进 query 文本（后者会污染查询词，不推荐）。
- Jev 判出的"想要 Reddit/GitHub/arXiv/微信"这类源，**AnySearch 侧有真实 vertical 可用**（`social_media.social_media` + `params.type=reddit_post`、`code.snippet`、`academic.preprint`、`wechatmp`），**TinyFish 侧只能用 `include_domains` 近似**。
- **例外：Hacker News / YouTube / Wikipedia / 新闻没有 AnySearch vertical**（实测只返回互联网杂站），只能走 general；站内限定要么拼 `site:` 进 query，要么交给 TinyFish 的 `include_domains`。所以 jev-search 那 12 个源 (`sources.ts:46-191`) 的尺度搬不过来：AnySearch 侧能**真正指定**的是 Reddit / GitHub / arXiv(+preprint/biomedical) / X / 微博 / 知乎 / 微信公众号 这 7 类（IMDb 弱），其余 5 类退化成"查询词里提到它"。
- 结论：**源选择交给 AnySearch 承担，TinyFish 承担时间窗**。这也正好贴合两个后端各自的强项。

### 2.4 判断精度的一个真实风险：中文

TypeSafe 官方 `docs.typesafe.ai/models` 明确写：

> English is the primary training language and where accuracy is currently best. Other languages, including CJK scripts, are handled but not equally well; test on your own content before relying on Jev.

本仓库的用户主要是中文查询。搬之前应当拿一批真实中文查询做一次对照（同一 query，开/关 Jev，看前 8 条的切题率），而不是默认它一定变好。

---

## 三、搬不过来的三件事

### 3.1 流式：seam 是 Promise，不是 AsyncGenerator

jev-search 的 UX 建立在"判断先出、结果后到"上（`pipeline.ts:146` 先 yield `intent`）。`WebSearchProvider.search()` 只有一个 Promise，中途没有任何回调面。

**替代**：把"判断摘要"塞进 `content`。`WebSearchResult.content` 是 seam 上唯一的自由文本通道，而本仓库**已经有这个先例**——fetch 路径的故障切换说明就是拼进 body 的（`lib/index.js:1157`、`integration-notes.md:235`）。可以写：

```
Sources chosen for this query: reddit, arxiv (general web not requested).
Time window: past week. 14 of 23 retrieved results judged on-topic; off-topic results dropped.
```

代价：模型会把这行当正文读，所以措辞要显式声明这是注解、不是答案。这与 jev-search"no generated answers"的品牌承诺并不冲突——Jev 本来就不生成答案。

### 3.2 分数不可见：只有数组顺序能承载排序

`WebSearchSource` 没有 `relevance` 字段，`web_search` 的渲染（`dsh-tool-web/lib/index.js:48` 的 `formatSearchOutput`）也只输出 `- [title](url) — snippet (date)`。

**替代**（按推荐度）：

1. **只靠顺序**（推荐）：`sources[]` 按判题分降序排列就是全部信息。零改动、零污染。
2. **阈值过滤 + 顺序**：低于阈值的直接丢弃（这就是 jev-search 的 "Lower-scoring results are grouped separately"）。注意这会和 2.2 的"不截断"纪律冲突——**丢弃 ≠ 截断**：丢弃是质量决策（并应在 `content` 里说明丢了几条），截断是数量决策（必须留给 seam）。
3. 把分数拼进 `snippet`：可行但脏，会污染模型读到的摘要原文。

### 3.3 交互面：没有 chip，也没有本地排序开关

"Best match / Newest" 切换、时间窗 chip、源 chip 在 DSH 里都没有对应 UI。窗口与源**只能由 Jev 从自然语言推断**，用户无法事后覆盖。

**替代**：这些变成配置项（下面 4.2 的 `judge.*`），或在系统提示里告诉模型"想要特定时间窗/站点时，请把限定词写进 query"。后者更符合 DSH 的形态——模型自己就是那个能改查询的人。

---

## 四、落地方案：在 hydrasearch 内部加一层 Jev

### 4.1 为什么放在 `hydrasearch` 里面，而不是新注册一个 provider

`integration-notes.md:245` 已经把理由写死了：provider id 是全局命名空间，注册多个 provider 会在未配置时抛 `WEB_PROVIDER_AMBIGUOUS`，也会把"内部实现细节"错误地提升成 seam 层公民。

Jev 在这里是**排序与选择策略**，是 `hydrasearch` 的内部实现，所以：

- 仍然只注册 `hydrasearch` 一个 provider；
- Jev 是它的一个可选前置阶段，不是第 3 个 backend；
- 新配置全部挂在 `hydrasearch.judge.*` 下（命名沿用 jev-search 的 `deps.judge`）。

### 4.2 新增的配置面

```yaml
# 顶层新增；默认关闭
- id: hydrasearch
  config:
    judgeEnabled: false        # 关掉时行为与今天完全一致
    judge:
      enabled: true
      baseURL: https://api.typesafe.ai/
      model: jev-latest        # 别名；响应会回传版本化 ID，日志记它
      # 以下都是判断参数，不是 backend 参数
      sourceThreshold: 0.6     # 对应 SOURCE_PROB_THRESHOLD
      relevanceDrop: 0.35      # 低于此判定为跑题并丢弃；0 = 不丢
      maxSources: 4            # 一次最多跑几个源，控成本
      timeoutMs: 8000
      verbose: false
```

> 卡片侧：`lib/client.js` 的字段表是**数据驱动**的（`TINYFISH_FIELDS` / `ANYSEARCH_FIELDS`，见 `lib/client.js:326-361`），且 `BACKENDS` 是硬编码的 `['tinyfish', 'anysearch']`（`:48`）。判题不是第三个 backend，所以**不该**塞进这张表；它属于顶层字段，卡片要新增一小块"判题"区域，`pickEditable()`（`:369`）与 `diffOps()`（`:384`）各加几行即可。`describe` 路由（`lib/index.js:1343-1397`）也要相应地多回一段判题状态。

凭据：新增 `HYDRASEARCH_TYPESAFE_API_KEY`（沿用 `lib/tinyfish.js:38-53` 说明的命名约定——引用名不能与常见环境变量同名，否则会被环境变量永久遮蔽且写不进去）。**没有 key 时 `judge.enabled` 自动视为不可用**，退回今天的纯检索链。

### 4.3 调用链

在 `HydraSearchProvider.search()`（`lib/index.js:1079`）的**循环之外**包一层：

```
1. 候选词生成        buildCandidates(request.query)          ← 纯代码，照搬 jev-search
2. inferIntent       Jev 一次调用（window + source_* noul + query choice）
3. 判定实际用哪个后端查询词 + 哪几个源 + 什么时间窗
4. 走现有 failover 链检索（可能对同一个后端发多个 lane 请求）
5. 合并去重           canonicalUrl / titleKey           ← 照搬 rank.ts / merge.ts
6. rerank             Jev 一次调用（每源每批 ≤40 条 noul）
7. 过滤 + 排序        然后返回，**不切片**
8. content 里写注解   选了什么源 / 什么窗口 / 丢了几条
```

关键点：

- **第 4 步复用现有 `BackendRuntime`**，不新写传输。每个 lane 就是一次 `backend.search({query, maxResults})`。
- **第 6 步合并成一次 Jev 调用**，不要每个 lane 调一次（官方实测：13 题一次请求比 13 次单题请求 **便宜 12.2 倍、快 10 倍，答案无差异**）。全部结果放一个 state 需要控制 token：`RESULTS_PER_LANE = 8` × 4 源 × 约 200 token ≈ 6.4k input token，远低于 64k 上限。
- **取消必须穿透**：Jev 的 `fetch` 要带 `signal`，abort 时**不换供应商、不换后端**，直接抛 `WEB_ABORTED`。规则与 `lib/index.js:1105` 一致。

### 4.4 代码骨架

新增 `lib/jev.js`（与 `tinyfish.js` / `anysearch.js` 同级，同样的形状：纯 transport + 类型化错误 + 可注入 `fetch`）：

```js
export const TYPESAFE_API_KEY_REF = 'HYDRASEARCH_TYPESAFE_API_KEY'
export const TYPESAFE_API_KEY_ENV = 'TYPESAFE_API_KEY'
export const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai/'
export const JEV_DEFAULT_MODEL = 'jev-latest'

export class JevError extends Error {
  constructor(message, code, status) { super(message); this.name = 'JevError'; this.code = code; if (status !== undefined) this.status = status }
}

/** 判断类故障：值得换供应商。400/401/422 不值得。 */
export function isJevOutage(error) {
  return error instanceof JevError && (error.status === 402 || error.status === 429 || error.status >= 500)
}

async function systemOne({ baseURL, model, apiKey, state, questions, signal, fetchImpl = fetch }) {
  // POST {baseURL}v1/systemone，Authorization: Bearer
  // 非 2xx → JevError('JEV_HTTP_ERROR', status)，abort → JevError('JEV_ABORTED')
}

export async function inferIntent(deps, { request, candidates, now, signal }) { /* 照搬 typesafe.ts:310 */ }
export async function rerank(deps, request, items, signal) { /* 照搬 typesafe.ts:407，批 40 */ }
```

`lib/candidates.js`：从 `candidates.ts` 直译（正则、`FUNCTION_WORDS`、`tidy`）。**这是纯函数，可以单元测试**，也是移植里最省事的一块。

`lib/index.js` 的改动：

```js
// makeConfig() 里加（注意：与现有 30+ 字段同样处理，root 已 volatile，无需逐字段标记）
judge: JevConfig.default({}),

// HydraSearchProvider.search() 开头
const judge = this.judgeRuntime()
if (judge.available()) {
  const intent = await judge.inferIntent(request.query, signal)   // 失败 → 记录原因，退回原 query
  lanes = judge.planLanes(intent, backend)                        // 可能多 lane
}
// …现有 failover 循环改为对每个 lane 跑一遍…
const judged = judge.available() ? await judge.rerank(request.query, merged, signal) : merged
return { sources: orderByRelevance(judged), truncated: false, content: judge.note(...) }
```

`available()` 的写法与 `BackendRuntime.available()`（`lib/index.js:879`）逐字同构：读凭据快照、不看网络。

### 4.5 降级与诚实性

沿用本仓库既有的三条规则，不新发明：

1. **`skipped` 与 `failed` 分开**。没有 Jev key → "judging not available (no key)"，而不是"judging failed"。
2. **Jev 挂了不等于搜索挂了**。判题失败时退回未排序的检索结果，并在 `content` 里说明"judging unavailable: <原因>"。绝不能整条搜索失败。
3. **取消不触发任何切换**。

### 4.6 系统提示

`lib/index.js:1812` 的 `refreshPrompt()` 已经按 live config 生成提示段。加一行即可：

```
- judging: Jev (${model}) selects sources and ranks results; results below ${relevanceDrop} are dropped. Judging unavailable — results are in retrieval order.   ← 无 key 时
```

---

## 五、成本、延迟、风险

| 项 | 数值 | 来源 |
| --- | --- | --- |
| Jev 输入价 | **$0.042 / Mtok**，输出 token 免费 | [docs.typesafe.ai/models](https://docs.typesafe.ai/models) |
| 单次搜索的 Jev 成本（估算） | 约 `500 + 8 × 4 × 200 ≈ 6.9k` input token ≈ **$0.0003** | 本仓库估算，非实测 |
| 单次 Jev 延迟 | 约 **100–150 ms**（官方口径 ~100ms；cookbook 实测 14 题 111ms、choice 114ms） | [System One](https://docs.typesafe.ai/concepts/system-one)、[parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions) |
| 本插件两次 Jev 的净增延迟 | **约 200–350 ms**（判断可与投机检索并发，摊掉一部分） | 估算 |
| `web_search` 的超时预算 | 本会话为 **60000 ms**（`app.asar` 里 `dsh-base/cordis.patch.yml:490` 与 `dsh-web-app/presets/standard.patch.yml:142` 都写 `searchTimeoutMs: 60000`）；`dsh-tool-web` 自身的默认是 30000（rc.6 树 `lib/index.js:739` = `DEFAULT_WEB_TOOL_TIMEOUT_MS = 3e4`） | 实测 `app.asar` 0.1.7 树 |
| 限流 | 250,000 tokens/s 且 1,200 req/min（官方注：**正在动态调整，可能不通知就变**） | [Models](https://docs.typesafe.ai/models) |

> 预算结论：60s 的窗口对 200–350ms 的净增延迟**完全不紧张**，成本也在噪声级。真正的约束不是钱和延迟，而是 2.4 的精度问题和第 3 节的三处结构性缺口。

**可选：投机并发**。jev-search 最漂亮的一处是"判断还没回来，Google 已经发出去了"（`pipeline.ts:119`）。本仓库可以照做：`inferIntent` 与"用原话打第一个后端"并发，若 Jev 最后选的正是 c0，就复用那次结果。这样判题延迟基本被完全藏掉。

风险清单：

1. **中文判断精度未知**（2.4）。搬之前先做对照实验。
2. **多一次外部依赖**：Jev 不可用时必须优雅降级，否则搜索比今天更容易失败。
3. **`maxResults` 语义变化**：判题后丢弃低分结果会让 `sources.length` 小于 `maxResults` 而 `truncated: false`，模型会以为"就这么多"。若被丢弃的是"跑题但有用"的结果，信息就丢了。建议 `relevanceDrop` 默认保守（或 0，即只排序不过滤）。
4. **AnySearch 的时间过滤不存在**（2.3），所以"窗口"这件事在两个后端行为不一致——要在 `content` 注解里说清楚，否则模型会以为窗口生效了。
5. **Jev 不是生成模型**，不能拿它写摘要。它只回答结构化问题；`content` 里放的必须是"判断结果的转述"，不是"答案"。
6. **多 lane 会放大计费**。每个 lane 是一次后端调用；`maxSources: 4` 意味着一次 `web_search` 最多打 4 次检索 + 2 次判题，比今天贵。这也是为什么要把 `maxSources` 做成配置而不是常数。

---

## 六、怎么验证

本仓库已有四套验证（`integration-notes.md:278`），移植后应当扩到这些点：

| 套件 | 新增断言 |
| --- | --- |
| `verify.mjs` | `lib/jev.js` 的请求形状（`state`/`model`/`questions`、`Authorization` 头）、`choice`/`noul` 答案解析、`isJevOutage` 的拒绝表（400/401/422 不换供应商）、abort 映射为 `JEV_ABORTED` |
| `verify.mjs` | `lib/candidates.js` 的中英文候选词表（照搬 jev-search `test/candidates.test.ts` 的用例） |
| `verify.mjs` | **不切片**：判题后返回的 sources 多于 `maxResults` 时 `truncated` 仍由 seam 决定 |
| `verify-integration.mjs` | 无 key 时判题被标记为 `skipped-unavailable` 且搜索结果与今天逐字节一致 |
| `verify-integration.mjs` | Jev 抛错时搜索仍返回结果，`content` 里带降级说明 |
| `verify-integration.mjs` | `settings` 卡片能写 `judge.*` 并可热生效 |
| `verify-profile.mjs` | 无改动（部署形状不变） |

新增真实网络段：`TYPESAFE_API_KEY` 存在时跑一次真 `inferIntent` + `rerank`，无 key 自动跳过。注意本仓库的 live 段此刻**是跳过的**——`scripts/verify.mjs:792-805` 用的是内存里的 `credentialsDouble`（`testCredentials` Map），**不读真实凭据中心**，所以即使本机 `~/.dsh/.credentials.yaml` 里已有 `HYDRASEARCH_TINYFISH_API_KEY`，live 段仍然报 `SKIPPED (no TinyFish or AnySearch key found)`。要真正跑 live 段，需要把 `scripts/verify.mjs:1674-1675` 接上真实凭据服务（或让 double 从凭据中心装载种子）。

---

## 七、顺带发现：本机 `web_search` / `web_fetch` 当前是坏的

本次分析全程无法使用内置的 `web_search` / `web_fetch`，两者都返回：

```
Error: configured web provider "hydrasearch" is not registered
```

对应 `dsh-web` 的 `WEB_PROVIDER_CONFIGURED_MISSING`（`dsh-web/lib/index.js:123`）。这与仓库源码无关，是**运行中实例的状态问题**，但证据很有意思，值得记一笔：

| 探针 | 结果 |
| --- | --- |
| `POST /api/dsh-hydrasearch-settings/describe` | ✅ 200，`version: 0.3.0`、`priority: [tinyfish, anysearch]`、`chain.providerId: hydrasearch` |
| `POST /api/dsh-hydrasearch-settings/test` | ✅ `ok: true`，`backend: tinyfish`，9 条结果，2851ms — **链路本身是活的** |
| `ctx.web.search()`（agent 侧） | ❌ `hydrasearch is not registered` |
| profile patch | `- id: web, config: {searchProvider: hydrasearch, fetchProvider: hydrasearch}` 已就位（`~/.dsh/profiles/desktop/cordis.patch.yml:103-108`），且 `- id: hydrasearch` 覆盖行在 `:107` |
| profile 清单改动时间 | `~/.dsh/profiles/desktop/package.json` 写入 `dsh-hydrasearch` bundle 的时间是 **22:48:35**，而**容器启动于 22:00:07** —— 晚 48 分钟 |
| 运行中的树 | `app.asar` → `dsh/package.json` 报 **0.1.7-alpha.1**；asar 内 `schemastery` = **3.18.3**、`dsh-tools` = 0.1.7-alpha.1 |
| profile 回退链接 | `~/.dsh/profiles/node_modules/@deepseek-ai/*` 全是 Junction，指向 `npm-cache/_npx/…` 的一棵 **rc.6 树**（`dsh-web`、`dsh-settings`、`dsh-tool-web`、`schemastery@3.18.1`）。仓库自身 devDeps 也是 rc.6 |
| 部署副本 | `~/.dsh/profiles/desktop/node_modules/dsh-hydrasearch` 与仓库源码 **SHA-256 逐文件一致**（`lib/index.js`、`lib/client.js`、`cordis.patch.yml`、`package.json`） |
| 源码健康度 | `verify.mjs` **92/92**、`verify-integration.mjs` **25/25** 全绿（本机跑过）。两者的 live 段都跳过：`verify.mjs` 的 live 判据读的是内存 double 而不是真实凭据中心（见 `scripts/verify.mjs:1674-1677`、`:792-805`），`verify-integration.mjs` 则用独立 scratch 文档 |

**推断（未验证）**：`apply()` 里的顺序是"先注册 provider（`lib/index.js:1655`）、后挂 bridge（`:1693`）"。所以 **bridge 能应答 ⟹ `apply()` 至少跑到了那一行 ⟹ `registerSearchProvider` 已经被调用过**。于是症状唯一自洽的解释是：**注册发生的 `ctx.web` 实例，和 agent turn 里解析到的 `ctx.web` 不是同一个**。候选成因，按可能性排序：

1. **运行中实例的 profile 在容器启动后被改过**（最可能）。`desktop/package.json` 的 `dsh.profile.bundles` 含 `dsh-hydrasearch` 的写入时间是 **22:48:35**，而容器**启动于 22:00:07**，两者相差 48 分钟；`cordis.patch.yml`（含 `- id: web` 指向 hydrasearch）在启动时虽已存在，但 `dsh-hydrasearch` 当时是否已在 bundles 里无法从此处回溯。若启动时不在，`cordis.patch.yml` 里那条 `- id: hydrasearch` 只是**对一个不存在的 entry 做覆盖**，会被跳过；而 bridge 与 provider 都来自同一个 `apply()`，无法只活一个——除非 profile 被热重载后 `web` 被重新挂载成新实例、而插件行没有一起重挂。
2. **两棵树混载**：profile 回退链接 `~/.dsh/profiles/node_modules/@deepseek-ai/*` 指向 `npm-cache/_npx/…` 的 **rc.6** 树，而运行中的容器是 **0.1.7-alpha.1**（asar）。rc.6 的 `dsh-web` 与 0.1.7 的 `dsh-web` 若各挂了一个 `web` service，就会出现"一个实例上有 provider、另一个上没有"。
3. `0.1.7` 的 preset `isolate` —— **证据不支持**：我把 `standard` / `ptc` / `minimal` / `cordis` 四个 preset 与 `dsh-base`、`dsh-web-app`、agent-team-profile 的 patch 全部枚举过，`isolate:` 只出现在 `planMode`、`compaction`+`toolResultPruner`、`workflowEngine`、`terminals` 四处，**没有 `web`**。

**排查顺序建议**（都属于运行环境，不在源码里）：

1. 用 `dsh` 在前台启动一次，看 `hydrasearch:` 开头的行——`apply()` 的降级路径会打 `error`（`lib/index.js:1688`），takeover 成功会打 `info`（`:1664`）；本机 `%APPDATA%\@deepseek-ai\dsh-desktop` 与 `~/.dsh` 下**没有落盘的运行日志**，所以必须前台跑才能看到。
2. **重启一次再测**。改动 `dsh.profile.bundles` 属于 boot-time 读取（`dsh-app-boot` 的 `loadProfile()`），启动后写入的那一行在当前进程里可能从未生效；重启是最便宜的一次判定。
3. 若重启后仍坏，检查是否**同时**存在 bundle 的 `hydrasearch` insert row 与用户层的重复 row（`deploy.mjs:235` 专门警告过；本次检查：用户层那条是 `- id: hydrasearch` 覆盖，**不是** `insert`，所以不是这一条）。
4. 最后才怀疑 scoping：把 `apply()` 里的 `ctx.web` 与工具侧解析到的实例各打一次 `provider.id` 列表对比。

---

## 八、证据清单

**jev-search（`--depth 1` clone 后阅读）**

- `src/lib/pipeline.ts:106` `askStream` · `:119-125` 投机 Google · `:128` `inferIntent` · `:137` 源阈值 · `:168-259` `runLane` · `:261-281` 并发与流 · `:283` done
- `src/lib/typesafe.ts:22` 供应商配置 · `:268` `isProviderOutage` · `:273` `systemOne` · `:310` `inferIntent` · `:405-407` `RERANK_BATCH` / `rerank` · `:457` 结束
- `src/lib/candidates.ts:1-6` "selects, it does not generate" · `:80` `buildCandidates`
- `src/lib/sources.ts:25` `Lane` · `:46` `SOURCES`（共 12 个源，`:48-191`）· `:86/98/110` 双 lane 源 · `:193` `DEFAULT_SOURCE_IDS` · `:219` `WINDOWS`
- `src/lib/rank.ts:34` `compareItems` · `:76` `canonicalUrl` · `:97` `clusterItems`
- `src/lib/merge.ts:10` `mergeItems`
- `src/lib/pipeline.ts:86-89` `SOURCE_PROB_THRESHOLD` / `RESULTS_PER_LANE` / `WINDOW_TOLERANCE`
- `src/lib/cache.ts:10-15` TTL · `:33` `cachedSearch`
- `src/routes/api/ask.ts:27-30` NDJSON 契约 · `:63` 30s 总时限
- `src/lib/use-ask.ts:53` 客户端 reducer
- `src/lib/search1api.ts:53` lane 15s 时限

**dsh-hydrasearch（本仓库）**

- `lib/index.js:78` `inject: ['web']` · `:85` provider id · `:211` `makeConfig` · `:828` `BackendRuntime` · `:879` `available()` · `:901/957` search/fetch transport 适配 · `:1012` `HydraSearchProvider` · `:1079/1135` 链式 search/fetch · `:1655-1656` 注册 · `:1662-1669` takeover 守卫 · `:1812-1881` 系统提示段
- `lib/tinyfish.js:129` `searchParams`（无 `time_range`）· `:200` `searchTinyfish`
- `lib/anysearch.js:151` `searchAnysearch`（无时间/站点字段）
- `cordis.patch.yml:55-124` row 与全部默认值
- `docs/integration-notes.md:229` 不自己截断 · `:235` fetch 注解写进 body · `:245` 只注册一个 provider · `:278` 四套验证

**DSH（依赖树 + 打包树）**

- `@deepseek-ai/dsh-web/lib/types/types.d.ts:13/31/45/97` 请求、结果、source、provider 契约
- `@deepseek-ai/dsh-web/lib/index.js:123` `WEB_PROVIDER_CONFIGURED_MISSING` · `:134` `capSources`
- `@deepseek-ai/dsh-tool-web/lib/index.js:19` `WEB_SEARCH_MAX_RESULTS = 8` · `:48` `formatSearchOutput` · `:739` 默认 30s
- `app.asar` → `dsh/package.json` = `0.1.7-alpha.1`；`dsh/node_modules/@deepseek-ai/schemastery/package.json` = **3.18.3**（对比 profile 回退链接里的 3.18.1 —— `.volatile()` 存在与否的分界，见 `docs/dsh-0.1.7-plugin-interface-audit.md:120`）
- `app.asar` → `dsh-base/cordis.patch.yml:472-490` 的 `web` 行（`:475` `searchProvider: deepseek-official`、`:476` `fetchProvider: http`）与 `tool-web`（`:490` `searchTimeoutMs: 60000`）
- `app.asar` → `dsh-web-app/cordis.patch.yml:535` `- id: tool-web / disabled: true`（host 行被禁用，由 preset 重新组合）
- `app.asar` → `dsh-web-app/presets/standard.patch.yml:138-142` `tool-web`（`fetch: true`, `searchTimeoutMs: 60000`）
- `app.asar` → `dsh-web-app/presets/{standard,ptc,minimal,cordis}.patch.yml` 与 agent-team-profile patch 全量枚举：`isolate:` 只出现在 `planMode` / `compaction` / `workflowEngine` / `terminals`，**无 `web`**
- `~/.dsh/profiles/desktop/cordis.patch.yml:103-148` 的 `- id: web` 与 `- id: hydrasearch` 两段（`:105-106` 两个 provider id）

**实测命令（可复现）**

```powershell
# 插件设置桥活着（本机 127.0.0.1:19387）
Invoke-WebRequest -Uri 'http://127.0.0.1:19387/api/dsh-hydrasearch-settings/describe' -Method Post `
  -ContentType 'application/json' -Body '{}' -UseBasicParsing
Invoke-WebRequest -Uri 'http://127.0.0.1:19387/api/dsh-hydrasearch-settings/test' -Method Post `
  -ContentType 'application/json' -Body '{"query":"DeepSeek Harness"}' -UseBasicParsing

# 四套验证
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node scripts\verify.mjs              # 92/92
& $node scripts\verify-integration.mjs  # 25/25

# 读 0.1.7 打包树（app.asar 内不可直接 Glob，用 16 字节头 + JSON 目录表）
# 辅助脚本：<temp>\asar-peek.mjs  <app.asar>  list|cat  [路径或子串]
```

**外部一手来源**

[TypeSafe API reference](https://docs.typesafe.ai/api) · [OpenAPI](https://api.typesafe.ai/openapi.json) · [Models](https://docs.typesafe.ai/models) · [Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out) · [Parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions) · [Re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe) · [Confidence](https://docs.typesafe.ai/confidence) · [Search1API Search](https://www.search1api.com/docs/basic/search) · [Search1API Credits and limits](https://www.search1api.com/docs/essentials/credits-and-limits)
