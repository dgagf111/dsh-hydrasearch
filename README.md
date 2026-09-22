[English](./README.en.md) | **中文**

# dsh-hydrasearch

**TinyFish + AnySearch 双后端搜索插件（DeepSeek Harness）。** 注册进 `ctx.web` seam，让内置的 `web_search` / `web_fetch` 走两个可自动故障切换的后端。优先级可在插件页拖动调整，两个后端各自支持其 API 的全部参数，全部配置持久化。

兼容 **DSH 0.1.6-alpha.2**（`@deepseek-ai/*` 0.1.0-rc.6 与 0.1.6-alpha.2）和 **DSH 0.1.7-alpha.1**（`@deepseek-ai/*` 0.1.7-alpha.1）。同一份源码同时适配两代，无需按版本切换分支。

- [它做什么](#它做什么)
- [安装](#安装)
- [优先级与故障切换](#优先级与故障切换)
- [配置](#配置)
- [API Key 来源](#api-key-来源)
- [开发](#开发)

---

## 它做什么

插件只向 `ctx.web` 注册**一个** provider —— `hydrasearch`，同时承担 search 与 fetch。两个后端的全部逻辑都封闭在它内部：故障切换链、各自的参数、凭据解析、配置卡片。TinyFish 与 AnySearch 对 seam 不可见。

实际生效的能力：

- `web_search` → 按优先级依次尝试两个后端，返回归一化的 `{url, title, snippet, publishedAt}`
- `web_fetch` → 同上
- 插件页配置卡片：拖动优先级、填 key、调每个后端的全部 API 参数
- 要把某个能力钉死在单一后端，用 `searchBackend` / `fetchBackend`（默认 `auto` 即走链）

---

## 安装

```sh
dsh plugin --profile web add github:dgagf111/dsh-hydrasearch
```

然后重启 `dsh web`。

<details>
<summary>从源码安装 / 手动部署</summary>

```powershell
# 用 DSH 自带的 node 运行部署脚本：它会把包镜像进 profile 并按 bundle 接线
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node scripts\deploy.mjs --profile desktop
```

脚本会把包装成 **bundle** 镜像到 profile（真实目录，非 symlink），并写入 `dsh.profile.bundles` 与 `dependencies`——这两条是插件页能列出它的前提。

</details>

然后在 profile 的用户层 `cordis.patch.yml` 里把 web seam 指过来（**两个 id 必须一起写**，只写一个会静默抹掉另一个）：

```yaml
- id: web
  config:
    searchProvider: hydrasearch
    fetchProvider: hydrasearch
```

> 插件只注册 `hydrasearch` 这一个 id，所以这里没有别的可选值。要换后端请改 `searchBackend` / `fetchBackend`，而不是改 provider。

重启 DeepSeek Harness，然后打开 **插件页 → 已安装 → `dsh-hydrasearch` → 行内配置入口**。

> `$DSH_HOME` 默认是 Windows 的 `%USERPROFILE%\.dsh`、macOS/Linux 的 `~/.dsh`；profile 布局为 `$DSH_HOME/profiles/<profile>/`。上面是 PowerShell，其他 shell 请自行调整路径写法。
>
> 为什么必须作为 bundle 安装、为什么不能用 symlink——见 [集成笔记](./docs/integration-notes.md)。

### 凭据（TinyFish 必需，AnySearch 可选）

**API Key 只存一处：凭据中心**（`~/.dsh/.credentials.yaml`）。在卡片里点"写入凭据中心"即可，存完**下一次请求立即生效，无需重启**。

```powershell
# 打开 插件页 → 已安装 → dsh-hydrasearch → 行内配置入口 → 填 key → 写入凭据中心
```

TinyFish 需要 key；AnySearch 无 key 可用匿名档（额度较低）。

> 环境变量（`TINYFISH_API_KEY` / `ANYSEARCH_API_KEY`）、`~/.tinyfish/config.json`、skill 的 `.env` **都不再是 key 来源**——插件读、写、清都只认凭据中心。这样"清除"才真的能把 key 清掉。

---

## 优先级与故障切换

`config.priority` 是持久化的有序后端 id 列表，例如 `["tinyfish", "anysearch"]`。

- **拖动**卡片里的行即可调序（也支持 `↑`/`↓` 与 `Alt+↑`/`Alt+↓`）
- 拖动只改草稿，点"保存"才落盘，与其他字段共用一次 revision 校验
- **每次搜索都重新读取**，所以改序后**下一次搜索立即生效，无需重启**
- 未知 id 会被丢弃、重复去重、缺失的后端按默认序补回——所以手改坏的 `settings.yaml` 也不会让某个后端凭空消失

搜索时自上而下遍历：

1. `available()` 为假（没 key / 被禁用 / 端点非法）→ 记 `skipped-unavailable`，**跳过，不尝试**
2. 尝试 → 失败 → 记 `failed` + 原因 → 切下一个
3. 成功 → 返回结果，并附注实际服务的后端与前面失败/跳过的原因

两条诚实性规则：

- **"没试" 与 "试了并失败" 严格区分**。前者只说明本地缺配置，后者才是后端有问题的证据。
- **取消（`AbortSignal`）不触发切换**。用户中止请求必须停下，不能偷偷换个后端重试。

关闭 `failover` 后只使用顺序里第一个可用后端，它的失败就是最终结果。全部失败时抛**第一个**失败（让运维看到根因），不合成模糊的聚合错误。

要把某个能力完全钉死在一个后端（不参与切换），把 `searchBackend` / `fetchBackend` 从 `auto` 改成后端 id 即可。填了不存在的 id 会退回正常的链式遍历，不会让能力失效。

---

## 配置

全部字段持久化在 settings 命名空间 `hydrasearch`，每个字段用**独立路径**写入（如 `['tinyfish','language']`），所以编辑一个后端永远不会覆盖另一个。

### 链（顶层）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `priority` | `[tinyfish, anysearch]` | 后端顺序，卡片拖动调整 |
| `failover` | `true` | 失败时是否切下一个 |
| `takeOverSearch` | `true` | 组合未指定 `web.searchProvider` 时接管 |
| `takeOverFetch` | `true` | 同上，针对 fetch |
| `searchBackend` | `auto` | `auto` 跟随优先级，或钉死某个后端 id |
| `fetchBackend` | `auto` | 同上，针对 `web_fetch` |

### TinyFish（`tinyfish.*`）

| 字段 | 默认 | 对应 API 参数 |
| --- | --- | --- |
| `enabled` | `true` | — |
| `searchBaseURL` | `https://api.search.tinyfish.ai/` | 搜索端点 |
| `fetchBaseURL` | `https://api.fetch.tinyfish.ai/` | 抓取端点 |
| `purpose` | 见下 | `purpose` 意图提示（搜索与抓取都发） |
| `language` | `''` | `language` |
| `location` | `''` | `location` |
| `domainType` | `''` | `domain_type`：`web` / `news` / `research_paper` |
| `includeDomains` | `''` | `include_domains`（逗号分隔） |
| `excludeDomains` | `''` | `exclude_domains`（逗号分隔） |
| `afterDate` | `''` | `after_date`（`YYYY-MM-DD`） |
| `beforeDate` | `''` | `before_date`（`YYYY-MM-DD`） |
| `recencyMinutes` | `0` | `recency_minutes`（0=不发） |
| `pubYearMin` | `0` | `pub_year_min`（0=不发） |
| `pubYearMax` | `0` | `pub_year_max`（0=不发） |
| `maxPages` | `3` | 每次搜索最多翻几页（1–10） |
| `fetchFormat` | `markdown` | 抓取格式：`markdown` / `html` / `json` |
| `fetchLinks` | `false` | 抓取时同时返回页面链接 |
| `fetchImageLinks` | `false` | `image_links`：抓取时同时返回图片链接 |
| `fetchPerUrlTimeoutMs` | `0` | `per_url_timeout_ms`（0=不发；服务接受 1–110000） |
| `fetchTtlSeconds` | `-1` | `ttl`：`-1`=不发（接受任何缓存）、`0`=强制实时、`N`=接受 N 秒内的缓存 |
| `verbose` | `false` | 打印每次搜索/抓取日志 |

> `purpose` **默认非空**：`Gather current, citable web sources to answer a user question`。TinyFish 把它当作请求的"为什么"——结果要喂给什么任务——而一个给 agent 用的 `web_search` / `web_fetch` 永远有这层意图，光靠关键词或裸 URL 表达不出来，所以默认替你写上。想回到服务端默认排序，把它清空即可（清空后该字段完全不发送）。
>
> `fetchTtlSeconds` 的三态是刻意的：服务端把**缺省** `ttl` 当作"接受任何缓存"，而显式 `0` 是"强制实时抓取"，两者不能合并——否则默认值会让每次抓取都变成实时。

### AnySearch（`anysearch.*`）

| 字段 | 默认 | 对应 API 参数 |
| --- | --- | --- |
| `enabled` | `true` | — |
| `baseURL` | `''` | API 地址；空则用公共地址 |
| `tag` | `''` | `tag` 垂直子域（如 `finance.quote`）；空=通用网页搜索 |
| `params` | `''` | `params` 垂直参数（JSON 对象字符串）；需先填 `tag` |
| `zone` | `''` | `zone` |
| `language` | `''` | `language` |
| `maxResults` | `10` | `max_results`（1–10） |
| `verbose` | `false` | 打印日志 |

写路径会校验：端点必须是绝对 URL、`maxPages` 在 1–10、`fetchFormat` 合法、`fetchPerUrlTimeoutMs` 为 0 或 1–110000、`fetchTtlSeconds` ≥ -1、日期是 `YYYY-MM-DD`、`params` 是合法 JSON 对象且必须同时有 `tag`。坏值在**卡片层就被拒**，不会静默禁用某个后端直到重启。

---

## API Key 来源

**只有凭据中心一处**，读写清三者对齐：

| 动作 | 目标 |
| --- | --- |
| 读取（每次请求现读，不缓存） | `ctx.credentials.resolve(ref)` |
| 写入（卡片"写入凭据中心"） | 同上 ref |
| 清除（卡片"清除"） | 同上 ref |

引用名由插件自己拥有，**故意不叫** `TINYFISH_API_KEY` / `ANYSEARCH_API_KEY`：

- TinyFish：`HYDRASEARCH_TINYFISH_API_KEY`
- AnySearch：`HYDRASEARCH_ANYSEARCH_API_KEY`

> **为什么要换名字**：凭据中心的引用名一旦和常见环境变量同名，任何 `export` 过它的机器上该 ref 都会被环境变量**永久遮蔽**；而凭据中心**故意拒绝**写入被遮蔽的 ref（"写入看似成功、解析仍返回被遮蔽值"比报错更糟）。结果就是卡片既存不进、也清不掉。改用插件自有名字后这个死结不存在了。

卡片上的徽标会写明 key 来自凭据中心的哪一层（本地文件 / 环境变量层 / `.env` 层）。若某层是只读的，点"清除"会**如实告知**"已从可写存储删除，但仍有只读层在提供此 key"，而不是假装清除成功。

> TinyFish 在无 key 时会被链路跳过（记 `skipped-unavailable`，不尝试），自动回退到 AnySearch。

---

## 开发

```bash
npm install --legacy-peer-deps
npm run verify              # 服务端单元 + 契约（无 key 时跳过真实网络段）
npm run verify:client       # 浏览器半
npm run verify:integration  # 进程内集成
npm run verify:all          # 全部
npm run deploy              # 部署进 profile
```

`verify-profile.mjs` 需要真实 profile，用 DSH 自带的 node 跑；其余三个可脱离 DSH 独立运行。

四个套件的覆盖范围、DSH 集成坑（bundle 安装、row 锚定、跨版本符号、symlink）以及依赖代际问题，见 [集成笔记](./docs/integration-notes.md)。

---

## 目录

```
dsh-hydrasearch/
├── lib/
│   ├── index.js      # 插件主体：hydrasearch provider、故障切换链、settings、bridge 路由、系统提示
│   ├── tinyfish.js   # TinyFish transport
│   ├── anysearch.js  # AnySearch transport
│   └── client.js     # 浏览器半：优先级拖动 + 各后端参数表单（无需构建）
├── scripts/          # deploy + 四个验证套件
├── docs/             # 集成笔记
├── cordis.patch.yml  # Bundle patch（含全部默认值说明）
└── package.json
```

## License

MIT
