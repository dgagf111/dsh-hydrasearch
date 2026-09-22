# 集成笔记

这份文档记录 dsh-hydrasearch **为什么这样实现**，以及踩过的 DSH 集成坑。面向维护者和想照搬这套做法的插件作者。

如果你只是想用它，看 [README](../README.md) 就够了。

---

## 为什么必须作为 bundle 安装

插件页的包列表来自 `pluginManager.listBundles()`，枚举的是 profile `package.json` 里的 **`dsh.profile.bundles` ∪ `dependencies`**（见 `plugin-manager/src/index.ts` 的 `listBundles`、`app-boot/src/profile-plugins.ts` 的 `readProfilePlugins`）。

只在 `cordis.patch.yml` 里加 `- insert: [- id: hydrasearch, ...]` **只是加了一个 row，不是包**。row 既不在 bundles 也不在 dependencies，所以：

- 插件页**永远不显示**它；
- 客户端 `plugins.row.config` 的 key 是 `<包名>#<行 id>`，而页面按包派发 —— 包不存在，**slot 永不被 dispatch**，配置卡片即使注册了也打不开。

结果：功能其实在跑，但用户**看不见、也配不了**。

> `settings.plugin.item` slot 在 0.1.6-alpha.2 已被删除（替代它的 `plugins.item` 由官方 `ui-settings-plugins` 占用），第三方插件的配置入口只能是 `plugins.row.config`。

## row 的 `name` 必须是路径，且基准是 patch 文件所在目录

**两个独立要求，缺一个都不可用**：

| 要求 | 作用 | 手段 |
| --- | --- | --- |
| bundle 成员资格 | 插件页**可见** + `plugins.row.config` 能被派发 | profile `package.json` 的 `dependencies` + `dsh.profile.bundles` |
| row 用**路径** | **可加载** | bundle 的 `cordis.patch.yml` 里 `name: ./lib/index.js` |

只满足前者 = **看得见但启不动**（报 `failed to import`）；只满足后者 = **能跑但看不见**。

行的 `name` 分两种情况：

- **裸包名** `dsh-hydrasearch` → 由「挂载 root include 的那个 Loader」解析，而**打包版桌面 App 的 Loader 在 `app.asar` 内**，位于 profile 之外 → 从 App 自己的安装树解析，永远到不了 `<profile>/node_modules` → 失败。
- **相对路径** `./lib/index.js` → 由 `app-boot` 的 `anchorInsertedPluginNames()` 锚定，基准是**声明它的那个 patch 文件所在目录**：

  ```js
  function anchorInsertedPluginNames(patches, file) {
    const base = dirname(resolve(file))          // ← patch 文件所在目录
    if (… entry.name.startsWith('./') …) entry.name = pathToFileURL(resolve(base, entry.name)).href
  }
  ```

  本 bundle 的 patch 位于包目录 `<profile>/node_modules/dsh-hydrasearch/`，所以入口是 `./lib/index.js`。

**曾经的错误**：旧值 `./node_modules/dsh-hydrasearch/lib/index.js` 假设「基准 = profile 根」，实际锚定到**包目录**，于是多套一层，路径根本不存在。

> profile 自己的 `cordis.patch.yml` 用同样的 `./` 规则，但那个文件**本身就在 profile 根**，所以 `./plugins/…` 恰好成立。**同一条规则、两种结果** —— 别把一层的路径复制到另一层。

`failed to import` 在 `app-boot` 里对应 `entry.fiber === undefined`，即**导入阶段**就失败，而不是 `apply` 抛错。这个区别决定排查方向。

## `@deepseek-ai/*` 的导入必须跨版本安全

`failed to import` 有**两个独立成因**，上面是路径，这是另一个，与路径无关。修好路径后如果仍报同样错误，多半是它。

打包版 App 安装了一个 **enforce 模式的解析钩子**，把 profile 内的 `@deepseek-ai/*` 导入**强制**映射到 App 自带的 alpha 树上。于是**插件静态 import 的每个名字，都必须在那棵树上真实存在**。ESM 具名导入在 **link 阶段**校验，缺一个就整模块报错：

```
SyntaxError: The requested module '.../dsh-settings/lib/index.js'
does not provide an export named 'installSettingsSection'
```

已实测的差异（`dsh-settings`）：

| 符号 | rc.6 | 0.1.6-alpha.2 |
| --- | --- | --- |
| `settingsNamespace()` | ✅ | ❌ **已移除** |
| `installSettingsSection()` | ✅ | ❌ **已移除**，改为 provider 方法 `settings.installSection(...)` |
| `SettingsProvider.register(ns, schema, {base, validate})` | ✅ | ✅ 语义一致 |
| `describe / update / replace / mutate / section` | ✅ | ✅ 语义一致 |

因此 `lib/index.js` **只用两代都有的 `settings.register()`**，并优先走 `installSection`（若存在）。这样 rc 与 alpha 都能加载。

> **为什么本地测试会漏掉**：裸 `node` 从插件真实路径向上走，会命中 `%DSH_HOME%\profiles\node_modules\@deepseek-ai\*` —— 那是**指向另一棵树（rc.6）的 junction**，导入因此成功。App 用 enforce 钩子覆盖了这个走法。**验证必须在 alpha 树上做**。

## 为什么不能用 symlink / junction

插件里写着 `import { WebError } from '@deepseek-ai/dsh-web'`。Node 解析模块时沿**真实路径**（realpath）向上找 `node_modules`：

- 把源码目录用 junction 链进 profile → realpath 回到源码目录 → 那里没有 `@deepseek-ai` 树 → **`ERR_MODULE_NOT_FOUND`，加载即失败**
- 落到 `<profile>\node_modules\dsh-hydrasearch` 真实目录 → 沿 `node_modules` → `desktop` → `profiles` 向上，命中 `%DSH_HOME%\profiles\node_modules`，拿到完整依赖闭包 → 正常

Node 24.21.0 实测：junction **失败**；真实目录拷贝成功。pnpm 的 `file:` 依赖物化的就是真实目录（非 symlink），所以部署脚本走 pnpm 并**校验这一点**。

**不要**在用户层重复声明 `hydrasearch` row —— bundle 自带的 `cordis.patch.yml` 已提供它，重复的 row id 会被组合两次、后层静默胜出。

## 设计取舍

### provider 不自己截断到 `maxResults`

`ctx.web` 会用 `maxResults` 截断并置 `truncated: true`，`web_search` 据此告诉模型"还有更多结果，可以细化查询"。

provider 如果自己先截断，结果永远 `truncated: false`，**模型就不知道还有更多结果**。所以 provider 只按 `maxResults` 决定翻几页，返回整页由 seam 去截。`maxPages` 是成本/延迟上界，seam 明确允许这种优化。

### `web_fetch` 的附注写进 body

`WebFetchResult` 没有承载"答案文本"的字段（那是 `WebSearchResult.content` 才有的）。所以 fetch 路径上的故障切换说明拼进 body 文本开头，否则模型拿到内容却不知道它来自哪个后端。

### 默认不写 `web.searchProvider`

profile 的 `- id: web` patch 是**整行替换 config**。只写 `fetchProvider` 会**静默抹掉**原有的 `searchProvider`，搜索就解析不到 provider。

所以插件在 `apply()` 里做兜底：**只有 `ctx.web.searchProviderId` 未定义时才接管**；用户显式配了别的 provider 就不动。

### 只注册一个 provider（而不是每个后端一个）

早期版本把 `tinyfish` 和 `anysearch` 也注册成 provider，好让运维把 `web.searchProvider` 指过去"钉死"某个后端。这带来两个问题：

1. **未配置时必然会歧义**。seam 的选择语义是"未配置且恰好一个可用才自动选，多个可用则抛 `WEB_PROVIDER_AMBIGUOUS`"。注册三个 provider 后，只要有两个后端可用，未配置 `web.searchProvider` 就会直接失败——而配置它是运维的额外负担，不是本意。
2. **后端变成了 seam 层的公民**。provider id 是全局命名空间，两个纯内部实现细节占用它，既可能与别的插件撞名，也把"换后端"这件事错误地表达成了"换 provider"。

现在只注册 `hydrasearch` 一个，钉死后端改由内部配置承担（`searchBackend` / `fetchBackend`，默认 `auto`）。这样：

- 未配置 `web.searchProvider` 时**永远不会歧义**（候选唯一）；
- 后端的增删完全不影响 seam 可见的 provider 集合；
- 钉死这件事语义正确——它一直是**配置**问题，不是注册问题。

`pinnedOrChain()` 是唯一的落点：`auto`、未知 id、非法值都退回链式遍历，所以卡片里填错一个 id 只会退化成默认行为，不会让能力失效。

### `apply()` 的注册顺序是刻意的

provider 的注册放在 `apply()` **最前面**，在任何可能抛错的步骤之前。

原因：`apply` 抛错会让 Cordis 失败该插件的 fiber，并**回滚这个 fiber 已做的全部 effect 级注册** —— 包括 provider 注册。而 profile 的 `web` 配置指名了 `hydrasearch`，症状就变成"seam 指向一个没人注册的 provider"，真因（端点非法、命名空间冲突）却被埋在后面一行。

先注册意味着：次要界面（卡片、bridge 路由）失败时搜索依旧可用，日志会明确说明降级了什么。

### 插件页 slot

配置卡片注册在 `plugins.row.config`，key 是 **`<包名>#<row id>`** = `dsh-hydrasearch#hydrasearch`。**改行 id 时必须同步改 `lib/client.js`**，否则配置入口会静默消失。

### 浏览器半不需要构建

`lib/client.js` 手写成 DSH 客户端模块加载器期望的闭包工厂形态（`window.__ModuleLoader__.load({ id, factory })`）。所以改这个文件不需要构建步骤，重启（或 HMR）即可。

---

## 验证

四个套件。`verify-profile.mjs` 必须用 DSH 自带的 node 且从 profile 内运行；其余三个**可脱离 DSH 独立运行**（`npm run verify` / `verify:client` / `verify:integration`）。

| 套件 | 覆盖 |
| --- | --- |
| `verify.mjs` | 两个 transport 的请求形状、分页、去重、日期归一化、错误映射；`WebRuntime` 上的 provider 注册与选择语义；故障切换全部分支；配置校验拒绝表；bridge 的 loopback/POST 守卫；**真实网络**真搜真抓 + 真实故障切换 |
| `verify-client.mjs` | 在模拟 `__ModuleLoader__` + 真实 React 下渲染卡片：slot key、summary 保持 inline、每个参数都有表单字段、per-backend 写入走两段路径、key 路由带后端标识 |
| `verify-profile.mjs` | 用 DSH 自己的 `loadOverlayPatches` / `composeEntries` / `resolveBundleDir` 跑真实 profile：包在 bundles 与 dependencies 里、安装是真实目录而非 symlink、副本与源码逐字节一致、row 未被重复声明、row id 与 slot key 一致 |
| `verify-integration.mjs` | 在真实 Cordis 根上下文挂真实 `WebRuntime` / `FileSettingsProvider` / `LocalCredentialProvider` / `SystemPrompt`，调用 `apply()`：搜索经链派发、设置落盘且下次调用即读到、改序后真的换后端、陈旧 revision 被拒、凭据中心往返、改序后重新挂载仍保持 |

`verify-profile.mjs` 抓的是"功能能跑但用户看不见"，以及**部署后才暴露的导入错误**（它真的 `import()` 那个模块）——源码级单测做不到。

### CI

`.github/workflows/ci.yml` 在 Node 20 / 22 上跑三个可移植套件，并额外断言：所有发布模块能 `node --check`；`package.json` 的 `files` 都真实存在；`cordis.patch.yml` 的 row `name` 能按其**所在目录**解析；`npm pack` 产物完整且没有混进 `.staging/`。

`verify-profile.mjs` 不跑 CI（它组合真实 profile）。想跑真实网络段，在仓库 secrets 里加 `TINYFISH_API_KEY` / `ANYSEARCH_API_KEY`，否则该段自动跳过。

### 依赖代际的坑

DSH 包在 npm 上的 `latest` dist-tag **仍指向 `0.0.1-rc.1`**，而当前代是 `0.1.0-rc.6`。所以 `devDependencies` 与 CI 全部**精确锁版本**，不要用 `^`。

另外 `^0.1.0-rc.6` 这类 range 在 npm 语义下**默认不匹配预发布版**，实际只锁在 `0.1.0-rc.x` 线上——对当前目标正确，升代际时需同步更新。

安装测试依赖需要 `--legacy-peer-deps`：DSH 的 peer 图跨代自引用（`dsh-tools@rc.6` 声明 peer `dsh-agent@^0.1.0-rc.6`，后者又拉 rc.8），严格解析器会报 `ERESOLVE`。
