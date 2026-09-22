[English](./README.en.md) | **中文**

# dsh-hydrasearch

**TinyFish + AnySearch 双后端搜索插件（DeepSeek Harness）。** 注册进 `ctx.web` seam，让内置的 `web_search` / `web_fetch` 走两个可自动故障切换的后端，优先级可在插件页拖动调整，两个后端各自支持其 API 的全部参数，全部配置持久化。

兼容 **DSH 0.1.6-alpha.2**（`@deepseek-ai/*` 0.1.0-rc.6）。

- [它做什么](#它做什么)
- [安装](#安装)
- [优先级与故障切换](#优先级与故障切换)
- [配置项](#配置项)
- [已验证的 API 行为](#已验证的-api-行为)
- [设计说明](#设计说明)
- [验证](#验证)

---

## 它做什么

插件向 `ctx.web` 注册三个 provider：

| provider id | 行为 |
| --- | --- |
| `hydrasearch` | **故障切换链**：按 `priority` 顺序依次尝试，失败自动切下一个。默认指向它。 |
| `tinyfish` | 只用 TinyFish，不切换（供"钉死单一后端"场景） |
| `anysearch` | 只用 AnySearch，不切换 |

因为三个都注册了，所以既可以用链（默认），也可以把 `web.searchProvider` 改成 `tinyfish` 或 `anysearch` 精确钉死一个后端——**不需要卸载插件**。

实际生效的能力：

- `web_search` → 按优先级依次尝试两个后端，返回归一化后的 `{url, title, snippet, publishedAt}`
- `web_fetch` → 同上（可用 `fetchBackend` 单独钉死一个后端）
- 插件页配置卡片：拖动优先级、填 key、调每个后端的全部 API 参数

---

## 安装

插件**必须作为 bundle 安装**（而不是只往 `cordis.patch.yml` 里加一行），并且必须落在真实目录里。两条都不是风格问题，是能否被看见/能否加载的硬约束。

```powershell
# 用 DSH 自带的 node 运行部署脚本：它会把包镜像进 profile 并按 bundle 接线
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node scripts\deploy.mjs --profile desktop
```

脚本做的事：

1. 把包镜像到 `<profile>\plugins\dsh-hydrasearch\`（真实目录，先写 `.staging` 再 rename，避免半更新状态被加载）
2. 在 profile 的 `package.json` 写入两条：
   ```json
   "dependencies": { "dsh-hydrasearch": "file:plugins/dsh-hydrasearch" },
   "dsh": { "profile": { "bundles": ["...", "dsh-hydrasearch"] } }
   ```
3. 用 pnpm 物化 `node_modules\dsh-hydrasearch`，并**拒绝** symlink 结果

然后在 profile 的用户层 `cordis.patch.yml` 里**只需要**把 web seam 指过来（这一步脚本会提示）：

```yaml
- id: web
  config:
    searchProvider: hydrasearch
    fetchProvider: hydrasearch
```

重启 DeepSeek Harness。插件页 → 已安装 → `dsh-hydrasearch` → 行内配置入口。

### 为什么必须作为 bundle 安装

插件页的包列表来自 `listBundles()`，枚举的是 profile `package.json` 里的 **`dsh.profile.bundles` ∪ `dependencies`**（见 `plugin-manager/src/index.ts` 的 `listBundles`、`app-boot/src/profile-plugins.ts` 的 `readProfilePlugins`）。

只在 `cordis.patch.yml` 里加 `- insert: [- id: hydrasearch, ...]` **只是加了一个 row，不是包**。row 既不在 bundles 也不在 dependencies，所以：

- 插件页**永远不显示**它；
- 客户端 `plugins.row.config` 的 key 是 `<包名>#<行 id>`，而页面按包派发 —— 包不存在，**slot 永不被 dispatch**，配置卡片即使注册了也打不开。

结果就是：功能其实在跑，但用户**看不见、也配不了**。（同名的 `settings.plugin.item` slot 在 0.1.6-alpha.2 已被删除，不能退回去用它。）

### row 的 `name` 必须是路径，且**基准是 patch 文件自身所在目录**

**这是两个独立要求**，缺一个都不可用：

| 要求 | 作用 | 手段 |
| --- | --- | --- |
| bundle 成员资格 | 插件页**可见** + `plugins.row.config` 能被派发 | profile `package.json` 的 `dependencies` + `dsh.profile.bundles` |
| row 用**路径** | **可加载** | bundle 的 `cordis.patch.yml` 里 `name: ./lib/index.js` |

只满足前者 = **看得见但启不动**（报 `failed to import`）；只满足后者 = **能跑但看不见**。

#### 锚定基准（踩过的坑）

行的 `name` 分两种情况：

- **裸包名** `dsh-hydrasearch` → 由「挂载 root include 的那个 Loader」解析，而**打包版桌面 App 的 Loader 在 `app.asar` 内**，位于 profile 之外 → 从 App 自己的安装树解析，永远到不了 `<profile>/node_modules` → 失败。
- **相对路径** `./lib/index.js` → 由 `app-boot` 的 `anchorInsertedPluginNames()` 锚定，基准是**声明它的那个 patch 文件所在目录**：

  ```js
  // app-boot/lib/index.js
  function anchorInsertedPluginNames(patches, file) {
    const base = dirname(resolve(file))          // ← patch 文件所在目录
    if (… entry.name.startsWith('./') …) entry.name = pathToFileURL(resolve(base, entry.name)).href
  }
  ```

  本 bundle 的 patch 文件位于包目录 `<profile>/node_modules/dsh-hydrasearch/`，所以入口就是 `./lib/index.js`。

#### 曾经的错误

旧值 `./node_modules/dsh-hydrasearch/lib/index.js` 假设「基准 = profile 根」。实际按上面的规则锚定到**包目录**，于是多套了一层：

```
<profile>/node_modules/dsh-hydrasearch/node_modules/dsh-hydrasearch/lib/index.js   ← 不存在
```

这正是 App 横幅里那条 `failed to import` 的路径（banner 里是 `.../node_modules/dsh-hydrasearch/node_modules/dsh-hydrasearch/lib/index.js`）。

> 注意：profile 自己的 `cordis.patch.yml` 用同样的 `./` 相对路径规则，但那个文件**本身就在 profile 根**，所以 `./plugins/…` 恰好成立。**同一条规则、两种结果** —— 不要把一层的路径复制到另一层。

`failed to import` 这个提示在 `app-boot` 里对应 `entry.fiber === undefined`，即**导入阶段**就失败，而不是 `apply` 抛错 —— 这个区别决定了排查方向。可用 `dsh --dump-config` 或 `composeEntries()` 查看锚定后的绝对 `file:` URL。

### `@deepseek-ai/*` 的导入必须是**跨版本安全**的

`failed to import` 有**两个独立的成因**，上面的路径是一个，这是另一个，且与路径无关。修好路径后如果仍报同样错误，多半是它。

打包版 App 会安装一个 **enforce 模式的解析钩子**，把 profile 内的 `@deepseek-ai/*` 导入**强制**映射到 App 自带的 alpha 树上：

```js
// app-boot/lib/index.js
function installProfileResolution(generation, behavior = 'enforce') { … }
// profile-boot: behavior = resolutionMode === 'dual' ? 'verify' : 'enforce'
```

于是**插件静态 import 的每个名字，都必须在那棵树上真实存在**。ESM 的具名导入在 **link 阶段**校验，缺一个就整模块报错：

```
SyntaxError: The requested module '.../dsh-settings/lib/index.js'
does not provide an export named 'installSettingsSection'
```

**不要静态 import 版本专属的符号。** 已实测的差异（`dsh-settings`）：

| 符号 | rc.6 | 0.1.6-alpha.2 |
| --- | --- | --- |
| `settingsNamespace()` （导出函数） | ✅ | ❌ **已移除**（校验内联为 `parseSettingsNamespace`） |
| `installSettingsSection()` （导出函数） | ✅ | ❌ **已移除**，改为 provider 方法 `settings.installSection(owner, ns, schema, entry, hooks)` |
| `SettingsProvider.register(ns, schema, {base, validate})` | ✅ | ✅ 语义一致 |
| `describe / update / replace / mutate / section` | ✅ | ✅ 语义一致 |

因此 `lib/index.js` 自己导出 `settingsNamespace()` 与 `installSettingsSection()`，内部**只用两代都有的 `settings.register()`**，并优先走 `installSection`（若存在）。这样 rc 与 alpha 都能加载。

**同 profile 的对照证据**：`dsh-free-search` 一直正常，因为它只 import 了 `SettingsConflictError` / `SettingsProvider`（两代都有）；`dsh-hydrasearch` 失败，是因为它 import 了 alpha 里不存在的两个符号。

> **为什么本地测试会漏掉**：裸 `node` 从插件真实路径向上走，会命中 `%DSH_HOME%\profiles\node_modules\@deepseek-ai\*` —— 那是**指向另一棵树（rc.6）的 junction**，导入因此成功。App 用 enforce 钩子覆盖了这个走法。**验证必须在 alpha 树上做**，不能只跑裸 node。

### 为什么不能用 symlink / junction

插件里写着 `import { WebError } from '@deepseek-ai/dsh-web'`。Node 解析模块时沿**真实路径**（realpath）向上找 `node_modules`：

- 把 `E:\project\dsh-hydrasearch` 用 junction 链进 profile → realpath 回到 `E:\project` → 那里没有 `@deepseek-ai` 树 → **`ERR_MODULE_NOT_FOUND`，插件加载即失败**
- 落到 `<profile>\node_modules\dsh-hydrasearch` 真实目录 → 沿 `node_modules` → `desktop` → `profiles` 向上，命中 `%DSH_HOME%\profiles\node_modules`，拿到完整依赖闭包 → 正常

本机 Node 24.21.0 实测：junction **失败**；真实目录拷贝成功；pnpm 的 `file:` 依赖物化的就是真实目录（非 symlink），所以脚本走 pnpm 并校验这一点。

**不要**在用户层重复声明 `hydrasearch` row —— bundle 自带的 `cordis.patch.yml` 已经提供它，重复的 row id 会被组合两次、后层静默胜出。

---

## 优先级与故障切换

### 优先级

`config.priority` 是一个持久化的有序后端 id 列表，例如 `["tinyfish", "anysearch"]`。

- **拖动**插件卡片里的行即可调整顺序（也支持 `↑`/`↓` 按钮和聚焦行上的 `Alt+↑`/`Alt+↓`，键盘可达）
- 拖动只改**草稿**，点"保存"才落盘 —— 顺序改动可复核，且和别的字段共用一次 revision 校验
- **每次搜索都重新读取该列表**，所以改序后**下一次搜索立即生效，无需重启**

列表会被归一化：未知 id 丢弃、重复去重、缺失的后端按默认序补回。这一步在**每次读取**时都跑，所以手改坏的 `settings.yaml` 也不会让某个后端凭空消失。

### 故障切换

搜索时自上而下遍历：

1. `available()` 为假（没 key / 被禁用 / 端点非法）→ 记 `skipped-unavailable`，**跳过，不尝试**
2. 尝试 → 失败 → 记 `failed` + 原因 → 切下一个
3. 成功 → 返回结果，并在结果里附注实际服务的后端与前面失败/跳过的原因

两条诚实性规则：

- **"没试" 与 "试了并失败" 严格区分**。前者只说明本地缺配置，后者才是后端有问题的证据。合并两者会误导运维。
- **取消（`AbortSignal`）不触发切换**。用户中止请求必须停下，不能偷偷换个后端重试——那是无视用户意图。

关闭 `failover` 后，只使用顺序里第一个可用后端，它的失败就是最终结果。

全部后端失败时抛**第一个**失败（让运维看到根因），而不是合成一个模糊的聚合错误。

---

## 配置项

全部字段都持久化在 settings 命名空间 `hydrasearch`（写进 profile 的 settings 文档，重启保留）。每个字段用**独立路径**写入（如 `['tinyfish','language']`），所以编辑一个后端永远不会覆盖另一个后端的整段配置。

### 链（顶层）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `priority` | `[tinyfish, anysearch]` | 后端顺序，板卡拖动调整 |
| `failover` | `true` | 失败时是否切下一个 |
| `takeOverSearch` | `true` | 组合未指定 `web.searchProvider` 时接管 |
| `takeOverFetch` | `true` | 同上，针对 fetch |
| `fetchBackend` | `auto` | `auto` 跟随优先级，或钉死某个后端 id |

### TinyFish（`tinyfish.*`）

| 字段 | 默认 | 对应 API 参数 |
| --- | --- | --- |
| `enabled` | `true` | — |
| `apiKey` | `''` | `X-API-Key`；空则回退 env / CLI 配置 |
| `apiKeyEnv` | `TINYFISH_API_KEY` | 凭据中心的引用名 |
| `searchBaseURL` | `https://api.search.tinyfish.ai/` | 搜索端点 |
| `fetchBaseURL` | `https://api.fetch.tinyfish.ai/` | 抓取端点 |
| `purpose` | `''` | `purpose` 搜索意图提示 |
| `language` | `''` | `language` |
| `location` | `''` | `location` |
| `domainType` | `''` | `domain_type`：`web` / `news` / `research_paper` |
| `includeDomains` | `''` | `include_domains`（逗号分隔） |
| `excludeDomains` | `''` | `exclude_domains`（逗号分隔） |
| `afterDate` | `''` | `after_date`（`YYYY-MM-DD`） |
| `beforeDate` | `''` | `before_date`（`YYYY-MM-DD`） |
| `recencyMinutes` | `0` | `recency_minutes`（0=不发） |
| `pubYearMin` | `0` | `pub_year_min`（0=不发，发送时补零到 4 位） |
| `pubYearMax` | `0` | `pub_year_max`（同上） |
| `maxPages` | `3` | 每次搜索最多翻几页（1–10，每页一次计费请求） |
| `fetchFormat` | `markdown` | 抓取格式：`markdown` / `html` / `json` |
| `fetchLinks` | `false` | 抓取时同时返回页面链接 |
| `verbose` | `false` | 打印每次搜索/抓取日志 |

### AnySearch（`anysearch.*`）

| 字段 | 默认 | 对应 API 参数 |
| --- | --- | --- |
| `enabled` | `true` | — |
| `apiKey` | `''` | `Authorization: Bearer`；**空则匿名访问**（额度较低） |
| `apiKeyEnv` | `ANYSEARCH_API_KEY` | 凭据中心的引用名 |
| `baseURL` | `''` | API 地址；空则用 `ANYSEARCH_API_BASE_URL` 或公共地址 |
| `tag` | `''` | `tag` 垂直子域（如 `finance.quote`）；空=通用网页搜索 |
| `params` | `''` | `params` 垂直参数（JSON 对象字符串）；需先填 `tag` |
| `zone` | `''` | `zone` |
| `language` | `''` | `language` |
| `maxResults` | `10` | `max_results`（1–10） |
| `verbose` | `false` | 打印日志 |

写路径会校验：端点必须是绝对 URL、`maxPages` 在 1–10、`fetchFormat` 合法、日期是 `YYYY-MM-DD`、`params` 是合法 JSON 对象且必须同时有 `tag`、`tag` 形如 `domain.sub_domain`。坏值在**卡片层就被拒**，不会静默禁用某个后端直到重启。

### API Key 来源优先级

两个后端都是：**插件配置 → 环境变量 → 本地文件**

- TinyFish：`TINYFISH_API_KEY` env → `~/.tinyfish/config.json`（`tinyfish auth login` 写入）
- AnySearch：`ANYSEARCH_API_KEY` env → skill 的 `~/.agents/skills/anysearch/.env`

也可以在卡片里"写入凭据中心"（`~/.dsh/.credentials.yaml`，优先级最高）。key 是**每次调用现读**、不缓存的，所以存了 key **下一次请求立即生效，无需重启**。

> **注意**：如果你是在 shell 里 `export` 了 `TINYFISH_API_KEY` / `ANYSEARCH_API_KEY` 然后启动 dsh 的，凭据中心会**拒绝写入**并报
> `"... is supplied read-only by the launching environment, so set would be shadowed; unset it in the shell you start dsh from instead"`。
> 这是正确的保护——否则写入会"看起来成功"但解析时仍被环境变量遮蔽。卡片会把这条错误原样显示出来。想用凭据中心管理 key，就先从 shell 里 unset 掉。

---

## 已验证的 API 行为

### TinyFish

| 操作 | 请求 | 响应 |
| --- | --- | --- |
| 搜索 | `GET https://api.search.tinyfish.ai/?query=…&page=0`，头 `X-API-Key` | `{query, results:[{position, site_name, snippet, title, url, date?, publisher?}], total_results, page}` |
| 抓取 | `POST https://api.fetch.tinyfish.ai/`，体 `{urls:[…], format:'markdown'}` | `{results:[{url, final_url, title, description, language, author, published_date, text, latency_ms, format, links?}], errors:[{url, error}]}` |

要点：

- 两个操作在**各自独立的 host** 上，且都在**根路径**（不是 `/v1`）
- `pub_year_*` 必须补零到 4 位（`500` → `"0500"`），与官方 SDK 一致
- `page` 从 0 开始，0 时不发送该参数
- `date` 是 `"Aug 17, 2026"` 这类人读字符串 → 归一化为 ISO-8601；**解析不了就丢掉**（不编造 `publishedAt`）
- **TinyFish 不返回源站的 HTTP 状态码**：抓不到的 URL 出现在 `errors[]` 里。所以成功一律 `statusCode: 200`，失败抛错——而不是伪造一个状态码

### AnySearch

| 操作 | 请求 | 响应 |
| --- | --- | --- |
| 搜索 | `POST /v1/search`，体 `{query, tag?, params?, zone?, language?, max_results?}` | `{code, message, request_id, data:{results:[{title,url,snippet,content}], metadata:{total_results, search_time_ms}}}` |
| 抓取 | `POST /v1/extract`，体 `{url}` | `data:{url, title, content}` |
| 子域发现 | `GET /v1/sub-domains?domain=…`（可重复，最多 5 个） | `data:{domains:[{domain, sub_domains:[{sub_domain, description, params}]}]}` |

要点：

- **信封 `code === 0` 才算成功**——HTTP 200 也可能带非 0 `code`，所以判成功看 `code`，不看 HTTP 状态
- Auth 可选：无 key 走匿名（低限流）。**缺 key 不算后端不可用**，否则全新安装时整条链会静默降级
- **配额耗尽时服务会自动注册账号**：返回 `error_code: "daily_free_quota_exhausted"`，并把新凭据内嵌在 `message` 里（`username=… password=… api_key=as_sk_…`）。请求虽然失败了，但这把 key 是**唯一凭据**，插件会把它解析出来交给卡片，可一键存入凭据中心或 skill 的 `.env`
- `extract` 不支持 PDF / DOCX / 图片 / 音视频
- 结果同时有 `snippet` 和更长的 `content`；短的那个更适合当 seam 的 snippet

---

## 设计说明

### provider 不自己截断到 `maxResults`

`ctx.web` 会用 `maxResults` 截断并置 `truncated: true`，`web_search` 据此告诉模型"还有更多结果，可以细化查询"。

provider 如果自己先截断，结果永远 `truncated: false`，**模型就不知道还有更多结果**。所以 provider 只按 `maxResults` 决定翻几页，返回整页内容由 seam 去截。`maxPages` 是成本/延迟上界，seam 明确允许 provider 做这种优化。

### `web_fetch` 的附注写进 body

`WebFetchResult` 没有承载"答案文本"的字段（那是 `WebSearchResult.content` 才有的）。所以 fetch 路径上的故障切换说明拼进 body 文本开头，否则模型拿到内容却不知道它来自哪个后端。

### Patch 语义（为什么默认不写 `web.searchProvider`）

profile 的 `- id: web` patch 是**整行替换 config**。如果只写 `fetchProvider: hydrasearch`，bundle 里原有的 `searchProvider` 会被**静默抹掉**，搜索就解析不到 provider。

所以插件在 `apply()` 里做了兜底：**只有在 `ctx.web.searchProviderId` 未定义时才接管**；用户显式配了别的 provider 就不动。要钉死单一后端时，两个 id 一起写：

```yaml
- id: web
  config:
    searchProvider: anysearch
    fetchProvider: anysearch
```

### 插件页 slot

配置卡片注册在 `plugins.row.config`，key 是 **`<包名>#<row id>`** = `dsh-hydrasearch#hydrasearch`（见 `ui-plugin-manager` 的 `rowConfigKey`）。**改行 id 时必须同步改 `lib/client.js`**，否则插件页上的配置入口会静默消失。

而且这个 key 只有在**包本身出现在插件页的包列表里**时才会被派发 —— 这就是"必须作为 bundle 安装"的第二个理由（见上文安装章节）。`settings.plugin.item` 在 0.1.6-alpha.2 里**已被删除**（它的替代 `plugins.item` 由官方的 `ui-settings-plugins` 占用），第三方插件的配置入口就是 `plugins.row.config`。

### `apply()` 的注册顺序是刻意的

三个 provider 的注册放在 `apply()` **最前面**，在任何可能抛错的步骤之前。

原因：`apply` 抛错会让 Cordis 失败该插件的 fiber，并**回滚这个 fiber 已做的全部 effect 级注册** —— 包括 provider 注册。而 profile 的 `web` 配置指名了 `hydrasearch`，于是症状会变成"seam 指向一个没人注册的 provider"，真因（比如某个端点非法、settings 命名空间冲突）却被埋在后面一行。

先注册意味着：次要界面（设置卡片、bridge 路由）失败时，搜索依旧可用，且日志会明确说明降级了什么。

### 浏览器半不需要构建

`lib/client.js` 手写成了 DSH 客户端模块加载器期望的闭包工厂形态（`window.__ModuleLoader__.load({ id, factory })`），与 tsdown 客户端预设的输出一致。所以改这个文件不需要任何构建步骤——重启（或 HMR）即可。

---

## 验证

四个套件，都用 DSH 自带的 node 运行（必须从 profile 内运行，才能解析 `@deepseek-ai/*`）：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$p = "$env:USERPROFILE\.dsh\profiles\desktop\plugins\dsh-hydrasearch"

& $node "$p\scripts\verify.mjs"              # 服务端单元 + 真实网络
& $node "$p\scripts\verify-client.mjs"       # 浏览器半
& $node "$p\scripts\verify-profile.mjs"      # profile 组合（用 DSH 自己的 loader）
& $node "$p\scripts\verify-integration.mjs"  # 进程内集成（挂真实 DSH 服务）
```

### `verify.mjs` — 服务端单元 + 真实网络

- 两个 transport 的 URL/方法/头/请求体形状、分页、去重、日期归一化、错误映射（含 AnySearch "HTTP 200 + 非 0 code"）
- 真实 `WebRuntime` 上的 provider 注册与选择语义（含 `WEB_DUPLICATE_PROVIDER`、`WEB_PROVIDER_AMBIGUOUS`）
- 故障切换：顺序生效、改序改变结果、失败切换、"没试 vs 失败"的区分、取消不切换、`failover` 关闭后不切换、全失败抛根因
- 优先级归一化、配置校验拒绝表、bridge 路由的 loopback/POST 守卫、revision 冲突
- **真实网络**：真搜/真抓 TinyFish、真搜/真抓 AnySearch、子域发现，以及**真实故障切换**（故意指向坏端点，验证落到 AnySearch）

### `verify-client.mjs` — 浏览器半

在模拟的 `window.__ModuleLoader__` + 真实 React 下求值客户端 bundle，用 `react-dom/server` 渲染卡片，断言：slot key 正确、summary 保持 inline（它渲染在 `<p>` 里）、每个 API 参数都有对应表单字段、per-backend 写入走两段路径、key 路由带后端标识、自动注册的 key 有落盘入口。

### `verify-profile.mjs` — 安装形态（可见性）

用 DSH 自己的 `loadOverlayPatches` / `composeEntries` / `resolveBundleDir` 跑真实 profile，断言：包在 `dsh.profile.bundles` 与 `dependencies` 里（即**插件页会列出它**）、安装是**真实目录而非 symlink**、安装副本与源码逐字节一致、bundle 声明了两个 face、bundle patch 提供了 row 且用户层没重复声明、row id 与客户端 slot key 一致、`web` seam 指向链、三处版本号一致。

这一层抓的是"功能能跑但用户看不见"，以及**部署后才暴露的语法错误**（它真的 `import()` 那个模块）——源码级单测做不到。

### `verify-integration.mjs` — 进程内集成

在**真实 Cordis 根上下文**上挂真实的 `WebRuntime` / `FileSettingsProvider` / `LocalCredentialProvider` / `SystemPrompt`，然后调用插件自己的 `apply()`，验证：

- `apply()` 能在真实上下文完成（inject 图真的解析得开）并注册全部三个 provider
- `ctx.web.search()` 经链派发，seam 自己截断并置 `truncated`
- **设置写入落盘且下一次调用立即读到**（"持久化 + 免重启生效"）
- **经 bridge 改 `priority` 顺序后，下一个请求真的换后端回答**
- 陈旧 revision 被拒、per-backend 写入不碰另一个后端、非法值被拒且不污染已存配置
- 凭据中心往返：存进去的 key 就是 provider 实际发出去的那个
- 真实故障切换（首个后端指向不可达地址，落到第二个并附注原因）
- 改序后**重新挂载仍保持**（持久化的最强断言）

---

## 目录

```
dsh-hydrasearch/
├── lib/
│   ├── index.js      # 插件主体：三个 provider、故障切换链、settings、bridge 路由、系统提示
│   ├── tinyfish.js   # TinyFish transport
│   ├── anysearch.js  # AnySearch transport
│   └── client.js     # 浏览器半：优先级拖动 + 各后端参数表单（无需构建）
├── scripts/
│   ├── deploy.mjs             # 部署进 profile（真实目录拷贝）
│   ├── verify.mjs             # 服务端单元 + 真实网络
│   ├── verify-client.mjs      # 浏览器半
│   ├── verify-profile.mjs     # profile 组合
│   └── verify-integration.mjs # 进程内集成
├── .github/workflows/ci.yml   # CI：离线套件 + npm pack 校验
├── cordis.patch.yml  # Bundle patch（含全部默认值说明）
└── package.json
```

---

## 开发与发布

### 不装 DSH 也能跑测试

`verify-profile.mjs` 需要一个真实 profile，其余三个套件**可以脱离 DSH 独立运行**：

```bash
npm install --legacy-peer-deps   # 见下方说明
npm run verify        # 服务端单元 + 契约（无 key 时自动跳过真实网络段）
npm run verify:client # 浏览器半
npm run verify:integration  # 进程内集成
```

`--legacy-peer-deps` 不是可选项：DSH 的 peer 依赖图跨代自引用（`dsh-tools@rc.6` 声明 peer `dsh-agent@^0.1.0-rc.6`，而后者的 peer 链又拉到 rc.8），所以即使每个包都正常发布，npm 的严格解析器仍会报 `ERESOLVE`。

`devDependencies` 里的 `@deepseek-ai/*` 全部**精确锁版本**（无 `^`）。原因见 [已知坑](#已知坑npm-的-latest-标签是过期的)。

### 已知坑：npm 的 `latest` 标签是过期的

DSH 这一族包在 npm 上的 `latest` dist-tag 仍指向 `0.0.1-rc.1`，而实际当前代是 `0.1.0-rc.6`（本机运行中的应用即 rc.6）。所以：

- **不要**写 `npm install @deepseek-ai/dsh-web` —— 会装到 `0.0.1-rc.1`，那是一年前的接口。
- 用精确版本：`@deepseek-ai/dsh-web@0.1.0-rc.6`。
- 这也是 CI 里全部锁死版本号、且 `peerDependencies` 保持 `^0.1.0-rc.6` 的原因。

另注：`^0.1.0-rc.6` 这类 range 在 npm 语义下**默认不匹配预发布版**（`0.1.6-alpha.2` 不满足它，除非加 `includePrerelease`），所以它实际只锁在 `0.1.0-rc.x` 这条线上——对当前目标是正确的，升级 DSH 代际时需要同步更新。

### CI 覆盖什么

`.github/workflows/ci.yml` 在 Node 20 / 22 上跑三个可移植套件，并额外断言：

- 所有随包发布的模块都能 `node --check`
- `package.json` 里 `files` 列出的字面量文件都真实存在
- `cordis.patch.yml` 的 row `name` 能按其**所在目录**解析（`./lib/index.js` 是相对 patch 文件，不是 profile 根——写错即加载失败，单元测试看不见）
- `npm pack` 产物包含全部宣称文件，且没有混进 `.staging/`

`verify-profile.mjs` 不跑 CI（它组合的是真实 profile）。想跑真实网络段，在仓库 secrets 里加 `TINYFISH_API_KEY` / `ANYSEARCH_API_KEY` 即可，否则该段自动跳过。

## License

MIT
