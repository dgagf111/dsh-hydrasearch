# 0.1.6-alpha.2 → 0.1.7-alpha.1 插件接口逐包审计

这份文档记录 **DSH 0.1.7-alpha.1 相对 0.1.6-alpha.2（本机打包桌面版）在插件接口上到底改了什么**，
以决定 `dsh-hydrasearch` 是否需要改、改哪里。

面向：想升级到 0.1.7 的插件作者，以及以后要复现这套比对的维护者。

> 方法与基准：两代 `@deepseek-ai/*` 包各自解包后**逐文件 SHA-256 比对**，再用 npm 装真实 0.1.7-alpha.1
> 组树**实际加载运行**（不是静态阅读）。所以「未受影响」的结论有运行验证背书，不只是看代码。

---

## 结论速览

| 接口面 | 结论 | 依据 |
| --- | --- | --- |
| `ctx.settings`（`dsh-settings`） | **破坏性变更** | `SettingsProvider` → `SettingsForms`，`register`/`installSection`/`get` 全消失；新增 volatile 闸门 |
| `ctx.web`（`dsh-web`） | 无变化 | 文件字节级相同 |
| `ctx.credentials`（+local） | 无变化 | 文件字节级相同 |
| `ctx.systemPrompt.section` | 无变化 | 函数体逐字节相同 |
| `ctx.webServer.register` | 无变化 | 整体 diff 只有 1 行 multipart 压缩判断 |
| `plugins.row.config` slot | 兼容 | key 派生 `rowConfigKey` 相同；新增可选 `form?` prop |
| `window.__ModuleLoader__.load` + `exports.inject` | 无变化 | bootstrap queue 逐字节相同 |
| bundle/patch row 相对路径锚定 | 无变化 | `anchorInsertedPluginNames` 逐字节相同 |
| profile 注册表枚举（`listBundles` 等） | 无变化/仅新增 | 仍是 `bundles ∪ dependencies`，只多了 `meta` 字段 |
| `dsh.bundle.patch` | 兼容性放宽 | 0.1.7 起接受 `string \| string[]`，字符串仍受支持 |

**一句话**：只有 **settings 一个面**坏了，坏得很彻底；其余面要么没动，要么只是加字段。

---

## 一、破坏性变更：settings 服务

### 1.1 类与方法集整个换了

| 代际 | 类 | 注册方法 |
| --- | --- | --- |
| rc 线 | `SettingsProvider`（+ 自由函数 `installSettingsSection`） | `register(ns, schema, {base, validate})` |
| 0.1.6-alpha.2 | `SettingsProvider` | `installSection(owner, ns, schema, entry, hooks)` |
| **0.1.7-alpha.1+** | **`SettingsForms`** | **无** |

0.1.7 的方法集恰好是：
`configure` / `invalidate` / `describe` / `update` / `replace` / `mutate` / `write` / `schema`
加上 `writable` / `documentPath` 两个 getter 与 `prepareDocument`。

**表单不再由插件注册进来，而是从 Loader entry 的 `Config` schema 自动派生**，命名空间取 `entry.options.id`。
⇒ row id 与设置命名空间必须一致，这从「恰好相同」变成**硬约束**。

### 1.2 闸门一：没有 volatile 祖先 → 条目从 `describe()` 消失

```js
// SettingsForms.describe()
const form = volatileForm(schema)
if (form === undefined) return []        // ← 整条 entry 被跳过
```

```js
function volatileForm(schema) {
  if (schema.meta.volatile) return plainSchema(schema)
  if (schema.type === 'object') {
    const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = volatileForm(child)
      return field === undefined ? [] : [[key, field]]
    }))
    return Object.keys(dict).length === 0 ? undefined : z.object(dict)
  }
  return undefined
}
```

**症状极其隐蔽**：插件功能正常、日志无错，但配置卡片一片空白。

### 1.3 闸门二：非 volatile 路径的写入被拒

```js
// SettingsForms.write()
for (const path of paths) {
  if (path.length && !isVolatilePath(schema, path)) {
    throw new Error(`Config field "${path.join('.')}" is not volatile`)
  }
}
```

卡片是按路径写单个字段的（`mutate` + `['tinyfish','language']` 这类 path op），
所以**每个被编辑字段的路径都必须落在 volatile 子树内**——否则每次保存都抛错。

`isVolatilePath` 遇第一个 volatile 祖先即返回 `true`，所以**在根上打一个标记即可覆盖全部字段**。

### 1.4 打标记不能打成 ref

`volatile` 节点被调用时返回 **cordis ref 而不是普通值**：

```js
const out = Config(raw)      // 打了 volatile → out 是 ref
out.priority                 // undefined  ✗
out.get().priority           // 有值        ✓
```

而 loader 正是把 `fiber.config`（ref）交给 `apply()`。
⇒ **根可以打标记；嵌套子 schema 不要打**，否则 `TinyfishConfig({})` 这类「取默认值」的调用会从返回 section 变成返回 ref。
⇒ 插件内部读配置一律走 `resolveConfigObject()` 包装。

**保留 ref 是免重启的机制**：cordis 把新值原地写回同一个 ref
（`cordis-plugin-loader` 的 `_commitVolatile` → `target[write](source.get())`），
插件每次 `.get()` 就看到新值。存快照会把插件钉死在挂载瞬间。

检测用符号，不要 import：

```js
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
const isVolatileRef = (v) => v !== null && typeof v === 'object' && VOLATILE_WRITE in v
```

`@deepseek-ai/cosmokit` 是 cordis 的传递依赖，不保证能从 profile 插件解析到；`Symbol.for` 注册表让跨包副本的检测依然成立。

### 1.5 volatile 是成组到达的，且旧树没有

| 组件 | 0.1.6-alpha.2（桌面版现役） | 0.1.7-alpha.1 |
| --- | --- | --- |
| `schemastery` | 3.18.2 —— **无 `.volatile()`** | 3.18.3 |
| `cosmokit` | 无 volatile | 1.8.4 |
| `cordis-plugin-loader` | 1.0.3 | 1.0.4（`_commitVolatile` 在这） |
| `cordis` | 4.0.2 | 4.0.3 |

`z.string().volatile` 在 3.18.2 上是 `undefined`。直接调用会在**模块求值阶段**抛
`TypeError: ... .volatile is not a function`，把整个插件在 import 时打死——**比卡片打不开严重得多**。

⇒ 标记必须特性探测：

```js
export function volatile(schema) {
  return typeof schema?.volatile === 'function' ? schema.volatile() : schema
}
```

---

## 二、未受影响的接口

以下均已逐包比对（多数是**文件字节级相同**），不需要改动：

- **`ctx.web`** —— `registerSearchProvider` / `registerFetchProvider` / `searchProviderId` / `fetchProviderId` 全部不变（`dsh-web` 两代文件 SHA 相同）。
- **`ctx.credentials` 与 `dsh-credentials-local`** —— `describe` / `resolve` / `set` / `unset` 不变；
  `inherited` 与 `assertUnshadowed` 的分层逻辑逐字节相同。
- **`ctx.systemPrompt.section`** —— 函数体逐字节相同；`SECTION_ORDERS` 未变。
- **`ctx.webServer.register`** —— 表体相同；两代整体 diff 只有一行 multipart 压缩判断。
- **`plugins.row.config`** —— slot 仍声明为 `kind: 'keyed'`；key 派生函数 `rowConfigKey` 相同
  （`` `${bundle}#${rowId}` ``）；`view: 'summary'` 与 `view: 'page'` 两种渲染都还在。
  0.1.7 给 page 视图多传了一个**可选** `form?: ConfigPageForm`——插件忽略它、用自己的 loopback bridge，仍有效。
- **客户端模块装载** —— `window.__ModuleLoader__.load({ id, factory })` 的 bootstrap queue 逐字节相同；
  `dsh.client.inject` 边仍被 `arriveGraphRow` 消费（缺失的依赖行会被静默跳过）。
- **bundle 装载链路** —— `anchorInsertedPluginNames` 与 `mountRootInclude` 逐字节相同，
  row `name: ./lib/index.js` 仍按**声明它的 patch 文件所在目录**锚定。
- **profile 枚举** —— `readProfilePlugins` 逐行相同，仍是 `dsh.profile.bundles ∪ dependencies`，
  所以 bundle 插件仍会出现在插件页；只新增了 `meta` / `readOnlyReason` 字段。
- **`dsh.bundle.patch`** —— 0.1.7 起额外接受数组，字符串写法仍受支持（本项目用的就是字符串）。
- **`dsh.engines` / `dsh.compatibility`** —— 两代**都没有任何代码读取**（全树 grep `dshReleases` 零命中），
  纯声明性数据，不会被更严格地校验。

### 顺带一提：0.1.7 的 profile 解析改成了内存态

0.1.6 会往 `%DSH_HOME%\profiles\node_modules` **写 symlink/junction**（`healProfilesModuleFallback` 等），
导致「pnpm 装的真实目录」与「托管回退链接」需要区分。
0.1.7 换成 `createRuntimeResolution`，**不再往磁盘写解析文件**，并 `removeLinkProjections` 清掉旧链接。

对一个用 pnpm `file:` 依赖安装的插件来说这是**变好**：真实目录就是权威，歧义消失。

---

## 三、兼容改法（按能力分派，不按版本号）

`installSettingsSection` 现在三分支，缺一不可：

1. `service.installSection` 存在 → **0.1.6 路径**，provider 自己管注册与清理。
2. `service.register` 存在 → **rc 路径**，手工对齐 effect 契约。
3. 都没有 → **0.1.7 路径**：不注册任何东西，只订阅 `settings/document-updated` 做变更通知。

第 3 支里 `setSource` **刻意不调用**——`apply()` 已经把 live thunk 指向 volatile ref，
在这里用快照覆盖它反而会把配置钉死。

按**能力**而非版本号分派，使未来某个树只要保留任一旧方法就仍然走得通。

---

## 四、复现这套验证

```powershell
# 1. 装一棵真实 0.1.7-alpha.1 的树
mkdir probe; cd probe
npm install @deepseek-ai/dsh-web@0.1.7-alpha.1 `
            @deepseek-ai/dsh-settings@0.1.7-alpha.1 `
            @deepseek-ai/schemastery@3.18.3 `
            @deepseek-ai/cordis@4.0.3

# 2. 真 Cordis root 挂真 WebRuntime + 真 SettingsForms，跑插件自己的 apply()
#    再驱动 makeBridgeRoutes() 的 /describe 与 /mutate，检查：
#      - describe() 里能拿到该命名空间的条目与表单字段
#      - mutate(path op) 成功且写值直达 live config
```

修前实拍症状（0.1.7 上）：

```
apply() 不抛错
日志：TypeError: provider.register is not a function
provider 照常注册、搜索照常可用
describe() 里 hydrasearch 条目数 = 0     ← 卡片彻底消失
```

修后：条目可见、表单字段齐全、path op 保存成功、写值直达 live config。
0.1.6 与 0.1.7 两棵树同时全绿。
