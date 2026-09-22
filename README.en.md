**English** | [中文](./README.md)

# dsh-hydrasearch

**A TinyFish + AnySearch dual-backend search plugin for DeepSeek Harness.** It registers into the `ctx.web` seam so the built-in `web_search` / `web_fetch` run against two backends with automatic failover. The priority order can be changed by dragging in the plugin page, each backend supports the full parameter set of its API, and all configuration is persisted.

Compatible with **DSH 0.1.6-alpha.2** (`@deepseek-ai/*` 0.1.0-rc.6).

- [What it does](#what-it-does)
- [Installation](#installation)
- [Priority and failover](#priority-and-failover)
- [Configuration](#configuration)
- [Verified API behavior](#verified-api-behavior)
- [Design notes](#design-notes)
- [Verification](#verification)

---

## What it does

The plugin registers three providers into `ctx.web`:

| provider id | behavior |
| --- | --- |
| `hydrasearch` | **Failover chain**: tries each backend in `priority` order and switches to the next on failure. Defaults to this one. |
| `tinyfish` | TinyFish only, no switchover (for "pin a single backend" scenarios) |
| `anysearch` | AnySearch only, no switchover |

Because all three are registered, you can either use the chain (the default) or point `web.searchProvider` at `tinyfish` or `anysearch` to pin exactly one backend — **without uninstalling the plugin**.

What actually takes effect:

- `web_search` → tries both backends in priority order and returns the normalized `{url, title, snippet, publishedAt}`
- `web_fetch` → same as above (use `fetchBackend` to pin a single backend on its own)
- Plugin page configuration card: drag the priority order, enter keys, tune every API parameter of each backend

---

## Installation

The plugin **must be installed as a bundle** (not merely by adding one line to `cordis.patch.yml`), and it must live in a real directory. Neither is a style preference; both are hard constraints on whether it can be seen and whether it can load.

> **Path conventions.** Throughout this document, `$DSH_HOME` denotes the DSH home directory: it defaults to `%USERPROFILE%\.dsh` on Windows and `~/.dsh` on macOS/Linux, and the profile layout is written generically as `$DSH_HOME/profiles/<profile>/...`. The command examples are PowerShell; on macOS/Linux, adapt the path syntax to your shell.

```powershell
# Run the deploy script with the node bundled with DSH: it mirrors the package into the profile and wires it up as a bundle
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node scripts\deploy.mjs --profile desktop
```

What the script does:

1. Mirrors the package into `$DSH_HOME/profiles/<profile>/plugins/dsh-hydrasearch/` (a real directory; it writes `.staging` first and then renames, so a half-updated state is never loaded)
2. Writes two entries into the profile's `package.json`:
   ```json
   "dependencies": { "dsh-hydrasearch": "file:plugins/dsh-hydrasearch" },
   "dsh": { "profile": { "bundles": ["...", "dsh-hydrasearch"] } }
   ```
3. Materializes `node_modules\dsh-hydrasearch` with pnpm and **rejects** a symlink result

Then, in the profile's user-layer `cordis.patch.yml`, you **only** need to point the web seam at it (the script prints a reminder for this step):

```yaml
- id: web
  config:
    searchProvider: hydrasearch
    fetchProvider: hydrasearch
```

Restart DeepSeek Harness. Plugin page → Installed → `dsh-hydrasearch` → inline configuration entry.

### Why it must be installed as a bundle

The package list on the plugin page comes from `listBundles()`, which enumerates **`dsh.profile.bundles` ∪ `dependencies`** in the profile's `package.json` (see `listBundles` in `plugin-manager/src/index.ts` and `readProfilePlugins` in `app-boot/src/profile-plugins.ts`).

Adding `- insert: [- id: hydrasearch, ...]` only to `cordis.patch.yml` **adds a row, not a package**. The row is in neither bundles nor dependencies, so:

- the plugin page **never displays it**;
- the client-side `plugins.row.config` key is `<package name>#<row id>`, and the page dispatches by package — if the package does not exist, **the slot is never dispatched**, and the configuration card cannot be opened even though it is registered.

The result: the functionality is running, but the user **cannot see it or configure it**. (The same-named `settings.plugin.item` slot was removed in 0.1.6-alpha.2, so it cannot be used as a fallback.)

### The row `name` must be a path, and its base is the directory of the patch file itself

**These are two independent requirements**; missing either one makes it unusable:

| Requirement | Effect | Means |
| --- | --- | --- |
| Bundle membership | Plugin page **visibility** + `plugins.row.config` can be dispatched | `dependencies` + `dsh.profile.bundles` in the profile's `package.json` |
| The row uses a **path** | **Loadability** | `name: ./lib/index.js` in the bundle's `cordis.patch.yml` |

Satisfying only the first = **visible but not startable** (reports `failed to import`); satisfying only the second = **runs but invisible**.

#### Anchoring base (a pitfall we hit)

The row's `name` has two cases:

- **Bare package name** `dsh-hydrasearch` → resolved by "the Loader that mounts the root include", and **the Loader of the packaged desktop app lives inside `app.asar`**, outside the profile → it resolves from the app's own installation tree and can never reach `<profile>/node_modules` → failure.
- **Relative path** `./lib/index.js` → anchored by `anchorInsertedPluginNames()` in `app-boot`, with the base being **the directory of the patch file that declares it**:

  ```js
  // app-boot/lib/index.js
  function anchorInsertedPluginNames(patches, file) {
    const base = dirname(resolve(file))          // ← the directory of the patch file
    if (… entry.name.startsWith('./') …) entry.name = pathToFileURL(resolve(base, entry.name)).href
  }
  ```

  This bundle's patch file lives in the package directory `<profile>/node_modules/dsh-hydrasearch/`, so the entry is `./lib/index.js`.

#### The previous mistake

The old value `./node_modules/dsh-hydrasearch/lib/index.js` assumed "base = profile root". In reality it is anchored to the **package directory** by the rule above, so it gained an extra level:

```
<profile>/node_modules/dsh-hydrasearch/node_modules/dsh-hydrasearch/lib/index.js   ← does not exist
```

This is exactly the path shown by the `failed to import` message in the app banner (in the banner it is `.../node_modules/dsh-hydrasearch/node_modules/dsh-hydrasearch/lib/index.js`).

> Note: the profile's own `cordis.patch.yml` uses the same `./` relative-path rule, but that file **is itself at the profile root**, so `./plugins/…` happens to hold. **One rule, two outcomes** — do not copy a path from one level to the other.

In `app-boot`, the `failed to import` message corresponds to `entry.fiber === undefined`, i.e. the failure happens at the **import stage**, not when `apply` throws — that distinction determines where to look. Use `dsh --dump-config` or `composeEntries()` to inspect the anchored absolute `file:` URL.

### `@deepseek-ai/*` imports must be cross-version safe

`failed to import` has **two independent causes**. The path above is one of them; this is the other, and it has nothing to do with paths. If the same error still appears after fixing the path, this is most likely it.

The packaged app installs a **resolution hook in `enforce` mode** that **forces** `@deepseek-ai/*` imports from inside the profile onto the app's own alpha tree:

```js
// app-boot/lib/index.js
function installProfileResolution(generation, behavior = 'enforce') { … }
// profile-boot: behavior = resolutionMode === 'dual' ? 'verify' : 'enforce'
```

Consequently, **every name the plugin statically imports must actually exist on that tree**. ESM named imports are checked at **link time**, and one missing name fails the whole module:

```
SyntaxError: The requested module '.../dsh-settings/lib/index.js'
does not provide an export named 'installSettingsSection'
```

**Do not statically import version-specific symbols.** Measured differences (`dsh-settings`):

| Symbol | rc.6 | 0.1.6-alpha.2 |
| --- | --- | --- |
| `settingsNamespace()` (exported function) | ✅ | ❌ **removed** (the validation is inlined as `parseSettingsNamespace`) |
| `installSettingsSection()` (exported function) | ✅ | ❌ **removed**, replaced by the provider method `settings.installSection(owner, ns, schema, entry, hooks)` |
| `SettingsProvider.register(ns, schema, {base, validate})` | ✅ | ✅ identical semantics |
| `describe / update / replace / mutate / section` | ✅ | ✅ identical semantics |

Therefore `lib/index.js` exports `settingsNamespace()` and `installSettingsSection()` itself, internally uses **only `settings.register()`, which exists in both generations**, and prefers `installSection` when it is present. This way it loads under both rc and alpha.

**Contrasting evidence from the same profile**: `dsh-free-search` has always worked because it imports only `SettingsConflictError` / `SettingsProvider` (present in both generations); `dsh-hydrasearch` failed because it imported the two symbols that do not exist in alpha.

> **Why local testing misses this**: bare `node` walks up from the plugin's real path and hits `$DSH_HOME/profiles/node_modules/@deepseek-ai/*` — a **junction pointing at another tree (rc.6)** — so the import succeeds. The app overrides this walk with the enforce hook. **Verification must be performed on the alpha tree**, not with bare node alone.

### Why a symlink / junction cannot be used

The plugin contains `import { WebError } from '@deepseek-ai/dsh-web'`. When resolving modules, Node walks up along the **real path** (realpath) looking for `node_modules`:

- Junctioning the source checkout `E:\project\dsh-hydrasearch` into the profile → realpath goes back to `E:\project` → there is no `@deepseek-ai` tree there → **`ERR_MODULE_NOT_FOUND`, the plugin fails on load**
- Landing in the real directory `$DSH_HOME/profiles/<profile>/node_modules/dsh-hydrasearch` → walking up through `node_modules` → `desktop` → `profiles` hits `$DSH_HOME/profiles/node_modules`, which provides the complete dependency closure → works normally

Measured on this machine with Node 24.21.0: a junction **fails**; copying to a real directory succeeds; pnpm materializes `file:` dependencies as real directories (not symlinks), which is why the script uses pnpm and asserts this point.

**Do not** declare the `hydrasearch` row again at the user layer — the bundle's own `cordis.patch.yml` already provides it, and a duplicate row id is composed twice, with the later layer silently winning.

---

## Priority and failover

### Priority

`config.priority` is a persisted, ordered list of backend ids, for example `["tinyfish", "anysearch"]`.

- **Dragging** the rows in the plugin card reorders them (the `↑`/`↓` buttons and `Alt+↑`/`Alt+↓` on a focused row also work, so it is keyboard accessible)
- Dragging changes only the **draft**; the change is persisted when you click "Save" — so a reorder can be reviewed, and it shares a single revision check with the other fields
- **The list is re-read on every search**, so after changing the order **the next search takes effect immediately, with no restart**

The list is normalized: unknown ids are dropped, duplicates are removed, and missing backends are re-added in default order. This runs on **every read**, so a hand-edited, broken `settings.yaml` cannot make a backend vanish into thin air.

### Failover

A search walks the list from top to bottom:

1. `available()` is false (no key / disabled / invalid endpoint) → record `skipped-unavailable`, **skip without attempting**
2. Attempt → fail → record `failed` plus the reason → move to the next one
3. Succeed → return the result, annotated with the backend that actually served it and the reasons for the preceding failures/skips

Two honesty rules:

- **"Not attempted" and "attempted and failed" are strictly distinguished.** The former only means local configuration is missing; only the latter is evidence of a backend problem. Merging the two would mislead operators.
- **Cancellation (`AbortSignal`) does not trigger failover.** A user-aborted request must stop; silently retrying on another backend would disregard user intent.

With `failover` turned off, only the first available backend in the list is used, and its failure is the final result.

When every backend fails, the **first** failure is thrown (so operators see the root cause), rather than a synthesized, vague aggregate error.

---

## Configuration

All fields are persisted in the settings namespace `hydrasearch` (written into the profile's settings document and kept across restarts). Each field is written through an **independent path** (such as `['tinyfish','language']`), so editing one backend never overwrites the whole configuration block of another backend.

### Chain (top level)

| Field | Default | Description |
| --- | --- | --- |
| `priority` | `[tinyfish, anysearch]` | Backend order, adjusted by dragging in the card |
| `failover` | `true` | Whether to switch to the next backend on failure |
| `takeOverSearch` | `true` | Take over when the composition does not specify `web.searchProvider` |
| `takeOverFetch` | `true` | Same as above, for fetch |
| `fetchBackend` | `auto` | `auto` follows the priority order, or pin a backend id |

### TinyFish (`tinyfish.*`)

| Field | Default | Corresponding API parameter |
| --- | --- | --- |
| `enabled` | `true` | — |
| `apiKey` | `''` | `X-API-Key`; if empty, falls back to env / CLI config |
| `apiKeyEnv` | `TINYFISH_API_KEY` | Reference name in the credential center |
| `searchBaseURL` | `https://api.search.tinyfish.ai/` | Search endpoint |
| `fetchBaseURL` | `https://api.fetch.tinyfish.ai/` | Fetch endpoint |
| `purpose` | `''` | `purpose` search intent hint |
| `language` | `''` | `language` |
| `location` | `''` | `location` |
| `domainType` | `''` | `domain_type`: `web` / `news` / `research_paper` |
| `includeDomains` | `''` | `include_domains` (comma-separated) |
| `excludeDomains` | `''` | `exclude_domains` (comma-separated) |
| `afterDate` | `''` | `after_date` (`YYYY-MM-DD`) |
| `beforeDate` | `''` | `before_date` (`YYYY-MM-DD`) |
| `recencyMinutes` | `0` | `recency_minutes` (0 = not sent) |
| `pubYearMin` | `0` | `pub_year_min` (0 = not sent; zero-padded to 4 digits when sent) |
| `pubYearMax` | `0` | `pub_year_max` (same as above) |
| `maxPages` | `3` | Maximum number of pages per search (1–10; each page is one billed request) |
| `fetchFormat` | `markdown` | Fetch format: `markdown` / `html` / `json` |
| `fetchLinks` | `false` | Also return page links when fetching |
| `verbose` | `false` | Log every search/fetch |

### AnySearch (`anysearch.*`)

| Field | Default | Corresponding API parameter |
| --- | --- | --- |
| `enabled` | `true` | — |
| `apiKey` | `''` | `Authorization: Bearer`; **empty means anonymous access** (lower quota) |
| `apiKeyEnv` | `ANYSEARCH_API_KEY` | Reference name in the credential center |
| `baseURL` | `''` | API address; if empty, uses `ANYSEARCH_API_BASE_URL` or the public address |
| `tag` | `''` | `tag` vertical sub-domain (such as `finance.quote`); empty = general web search |
| `params` | `''` | `params` vertical parameters (a JSON object string); `tag` must be filled in first |
| `zone` | `''` | `zone` |
| `language` | `''` | `language` |
| `maxResults` | `10` | `max_results` (1–10) |
| `verbose` | `false` | Log output |

The write path validates: endpoints must be absolute URLs, `maxPages` must be within 1–10, `fetchFormat` must be legal, dates must be `YYYY-MM-DD`, `params` must be a valid JSON object and must be accompanied by `tag`, and `tag` must have the form `domain.sub_domain`. Bad values are **rejected at the card level**, so a backend is never silently disabled until a restart.

### API key source priority

For both backends: **plugin configuration → environment variable → local file**

- TinyFish: `TINYFISH_API_KEY` env → `~/.tinyfish/config.json` (written by `tinyfish auth login`)
- AnySearch: `ANYSEARCH_API_KEY` env → the skill's `~/.agents/skills/anysearch/.env`

You can also "write to the credential center" from the card (`~/.dsh/.credentials.yaml`, highest priority). Keys are **read fresh on every call** and never cached, so storing a key **takes effect on the next request, with no restart**.

> **Note**: if you `export`ed `TINYFISH_API_KEY` / `ANYSEARCH_API_KEY` in your shell and then started dsh, the credential center **refuses the write** and reports
> `"... is supplied read-only by the launching environment, so set would be shadowed; unset it in the shell you start dsh from instead"`.
> This is correct protection — otherwise the write would "appear to succeed" while the environment variable still shadows it during resolution. The card displays this error verbatim. If you want to manage keys through the credential center, unset them in your shell first.

---

## Verified API behavior

### TinyFish

| Operation | Request | Response |
| --- | --- | --- |
| Search | `GET https://api.search.tinyfish.ai/?query=…&page=0`, header `X-API-Key` | `{query, results:[{position, site_name, snippet, title, url, date?, publisher?}], total_results, page}` |
| Fetch | `POST https://api.fetch.tinyfish.ai/`, body `{urls:[…], format:'markdown'}` | `{results:[{url, final_url, title, description, language, author, published_date, text, latency_ms, format, links?}], errors:[{url, error}]}` |

Key points:

- The two operations live on **separate hosts**, and both are at the **root path** (not `/v1`)
- `pub_year_*` must be zero-padded to 4 digits (`500` → `"0500"`), matching the official SDK
- `page` starts at 0, and the parameter is not sent when it is 0
- `date` is a human-readable string such as `"Aug 17, 2026"` → normalized to ISO-8601; **if it cannot be parsed it is dropped** (no fabricated `publishedAt`)
- **TinyFish does not return the origin site's HTTP status code**: a URL that cannot be fetched appears in `errors[]`. Success is therefore always `statusCode: 200` and failure throws — rather than forging a status code

### AnySearch

| Operation | Request | Response |
| --- | --- | --- |
| Search | `POST /v1/search`, body `{query, tag?, params?, zone?, language?, max_results?}` | `{code, message, request_id, data:{results:[{title,url,snippet,content}], metadata:{total_results, search_time_ms}}}` |
| Fetch | `POST /v1/extract`, body `{url}` | `data:{url, title, content}` |
| Sub-domain discovery | `GET /v1/sub-domains?domain=…` (repeatable, at most 5) | `data:{domains:[{domain, sub_domains:[{sub_domain, description, params}]}]}` |

Key points:

- **Only envelope `code === 0` counts as success** — an HTTP 200 can also carry a non-zero `code`, so success is judged by `code`, not by HTTP status
- Auth is optional: without a key the request is anonymous (lower rate limits). **A missing key does not count as the backend being unavailable**, otherwise a fresh installation would silently degrade the whole chain
- **When the quota is exhausted the service registers an account automatically**: it returns `error_code: "daily_free_quota_exhausted"` and embeds the new credentials in `message` (`username=… password=… api_key=as_sk_…`). The request did fail, but that key is the **only credential**; the plugin parses it out and hands it to the card, where it can be stored into the credential center or the skill's `.env` in one click
- `extract` does not support PDF / DOCX / images / audio and video
- A result carries both a `snippet` and a longer `content`; the shorter one is the better fit for the seam's snippet

---

## Design notes

### The provider does not truncate to `maxResults` itself

`ctx.web` truncates by `maxResults` and sets `truncated: true`, and `web_search` uses that to tell the model "there are more results, you can refine the query".

If the provider truncated first, results would always be `truncated: false`, and **the model would not know that more results exist**. So the provider uses `maxResults` only to decide how many pages to fetch, and returns full pages for the seam to truncate. `maxPages` is the cost/latency bound, and the seam explicitly permits the provider to make this optimization.

### The `web_fetch` annotation is written into the body

`WebFetchResult` has no field that carries "answer text" (only `WebSearchResult.content` does). So the failover explanation on the fetch path is concatenated onto the beginning of the body text; otherwise the model receives the content without knowing which backend it came from.

### Patch semantics (why `web.searchProvider` is not written by default)

The profile's `- id: web` patch **replaces the entire config row**. If you write only `fetchProvider: hydrasearch`, the bundle's existing `searchProvider` is **silently wiped**, and search can no longer resolve a provider.

That is why the plugin has a fallback in `apply()`: **it takes over only when `ctx.web.searchProviderId` is undefined**; if the user explicitly configured another provider, it leaves it alone. To pin a single backend, write both ids:

```yaml
- id: web
  config:
    searchProvider: anysearch
    fetchProvider: anysearch
```

### Plugin page slot

The configuration card is registered under `plugins.row.config`, with the key **`<package name>#<row id>`** = `dsh-hydrasearch#hydrasearch` (see `rowConfigKey` in `ui-plugin-manager`). **If you change the row id you must change `lib/client.js` accordingly**, otherwise the configuration entry on the plugin page disappears silently.

Moreover, this key is dispatched only when **the package itself appears in the plugin page's package list** — this is the second reason it "must be installed as a bundle" (see the installation section above). `settings.plugin.item` **was removed** in 0.1.6-alpha.2 (its replacement, `plugins.item`, is taken by the official `ui-settings-plugins`), and the configuration entry for third-party plugins is `plugins.row.config`.

### The registration order in `apply()` is deliberate

The three providers are registered at the **very start** of `apply()`, before any step that can throw.

The reason: an error thrown by `apply` makes Cordis fail the plugin's fiber and **roll back every effect-level registration that fiber has already made** — including provider registrations. Since the profile's `web` config names `hydrasearch`, the symptom becomes "the seam points at a provider nobody registered", while the real cause (an invalid endpoint, a settings namespace conflict) is buried a line later.

Registering first means: when the secondary surfaces (the settings card, the bridge routes) fail, search still works, and the log states exactly what was degraded.

### The browser half needs no build

`lib/client.js` is hand-written in the closure-factory shape the DSH client module loader expects (`window.__ModuleLoader__.load({ id, factory })`), matching the output of tsdown's client preset. So editing this file needs no build step — a restart (or HMR) is enough.

---

## Verification

Four suites, all run with the node bundled with DSH (they must run from inside the profile in order for `@deepseek-ai/*` to resolve). As above, `$p` denotes `$DSH_HOME/profiles/<profile>/plugins/dsh-hydrasearch`; the example spells it out with the Windows default.

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$p = "$env:USERPROFILE\.dsh\profiles\desktop\plugins\dsh-hydrasearch"

& $node "$p\scripts\verify.mjs"              # server-side unit + real network
& $node "$p\scripts\verify-client.mjs"       # browser half
& $node "$p\scripts\verify-profile.mjs"      # profile composition (with DSH's own loader)
& $node "$p\scripts\verify-integration.mjs"  # in-process integration (mounts real DSH services)
```

### `verify.mjs` — server-side unit + real network

- URL/method/header/request-body shape for both transports, pagination, deduplication, date normalization, error mapping (including AnySearch's "HTTP 200 + non-zero `code`")
- provider registration and selection semantics on a real `WebRuntime` (including `WEB_DUPLICATE_PROVIDER`, `WEB_PROVIDER_AMBIGUOUS`)
- failover: the order takes effect, reordering changes the result, switching on failure, the "not attempted vs failed" distinction, no switching on cancellation, no switching after `failover` is turned off, root cause thrown when everything fails
- priority normalization, the configuration validation rejection table, the bridge routes' loopback/POST guards, revision conflicts
- **Real network**: real TinyFish search/fetch, real AnySearch search/fetch, sub-domain discovery, and **real failover** (deliberately pointing at a bad endpoint to verify it lands on AnySearch)

### `verify-client.mjs` — browser half

Evaluates the client bundle under a simulated `window.__ModuleLoader__` plus real React, renders the card with `react-dom/server`, and asserts: the slot key is correct, the summary stays inline (it renders inside a `<p>`), every API parameter has a corresponding form field, per-backend writes go through two-segment paths, key routing carries the backend identifier, and auto-registered keys have an entry point for persisting them.

### `verify-profile.mjs` — installation shape (visibility)

Runs the real profile through DSH's own `loadOverlayPatches` / `composeEntries` / `resolveBundleDir` and asserts: the package is in `dsh.profile.bundles` and `dependencies` (i.e. **the plugin page will list it**), the installation is a **real directory and not a symlink**, the installed copy is byte-for-byte identical to the source, the bundle declares two faces, the bundle patch provides the row and the user layer does not declare it twice, the row id matches the client slot key, the `web` seam points at the chain, and the version numbers agree in all three places.

This layer catches "the functionality works but the user cannot see it", as well as **syntax errors that only surface after deployment** (it really does `import()` that module) — which source-level unit tests cannot do.

### `verify-integration.mjs` — in-process integration

Mounts the real `WebRuntime` / `FileSettingsProvider` / `LocalCredentialProvider` / `SystemPrompt` on a **real Cordis root context**, then calls the plugin's own `apply()`, verifying:

- `apply()` completes on a real context (the inject graph really resolves) and registers all three providers
- `ctx.web.search()` dispatches through the chain, and the seam truncates and sets `truncated` itself
- **Settings writes land on disk and are read by the very next call** ("persistence + effective without restart")
- **After changing the `priority` order through the bridge, the next request really answers from a different backend**
- A stale revision is rejected, a per-backend write does not touch the other backend, and invalid values are rejected without polluting the stored configuration
- Credential center round trip: the key that was stored is the one the provider actually sends
- Real failover (the first backend points at an unreachable address, and it lands on the second with the reason annotated)
- After reordering, **a remount still preserves the order** (the strongest assertion of persistence)

---

## Layout

```
dsh-hydrasearch/
├── lib/
│   ├── index.js      # Plugin body: the three providers, failover chain, settings, bridge routes, system prompt
│   ├── tinyfish.js   # TinyFish transport
│   ├── anysearch.js  # AnySearch transport
│   └── client.js     # Browser half: priority dragging + per-backend parameter forms (no build needed)
├── scripts/
│   ├── deploy.mjs             # Deploy into the profile (real directory copy)
│   ├── verify.mjs             # Server-side unit + real network
│   ├── verify-client.mjs      # Browser half
│   ├── verify-profile.mjs     # Profile composition
│   └── verify-integration.mjs # In-process integration
├── .github/workflows/ci.yml   # CI: offline suites + npm pack sanity
├── cordis.patch.yml  # Bundle patch (documents all default values)
└── package.json
```

---

## Development and publishing

### Running the tests without DSH installed

`verify-profile.mjs` needs a real profile, but the other three suites **run standalone**:

```bash
npm install --legacy-peer-deps   # see the note below
npm run verify               # server-side units + contracts (skips live-network when no key)
npm run verify:client        # browser half
npm run verify:integration   # in-process integration
```

`--legacy-peer-deps` is not optional. The DSH peer graph is self-referential across generations: `dsh-tools@rc.6` declares a peer on `dsh-agent@^0.1.0-rc.6`, whose own peer chain pulls rc.8. npm's strict resolver therefore reports `ERESOLVE` even though every package involved is published and installable.

Every `@deepseek-ai/*` entry in `devDependencies` is pinned **exactly** (no `^`). The reason is below.

### Known trap: npm's `latest` tag is stale

For this family of DSH packages, npm's `latest` dist-tag still points at `0.0.1-rc.1`, while the current generation is `0.1.0-rc.6` (the desktop app on this machine runs rc.6). Therefore:

- Do **not** run `npm install @deepseek-ai/dsh-web` — you will get `0.0.1-rc.1`, a long-obsolete interface.
- Use exact versions: `@deepseek-ai/dsh-web@0.1.0-rc.6`.
- This is why CI pins every version, while `peerDependencies` stays at `^0.1.0-rc.6`.

Also note: an npm range like `^0.1.0-rc.6` does **not** match prereleases by default (`0.1.6-alpha.2` does not satisfy it unless `includePrerelease` is set), so in practice it stays on the `0.1.0-rc.x` line. That is correct for the current target, but it must be updated when moving to a new DSH generation.

### What CI covers

`.github/workflows/ci.yml` runs the three portable suites on Node 20 and 22, and additionally asserts:

- every shipped module passes `node --check`
- every literal file listed in `package.json`'s `files` actually exists
- the bundle patch's row `name` resolves relative to **the patch file's own directory** (`./lib/index.js`, not the profile root — getting this wrong is a load failure that no unit test can see)
- the `npm pack` tarball contains everything it claims, and no `.staging/` directory leaks in

`verify-profile.mjs` is not run in CI, because it composes a live profile. To exercise the real-network section, add `TINYFISH_API_KEY` / `ANYSEARCH_API_KEY` repository secrets; otherwise that section skips itself.

## License

MIT
