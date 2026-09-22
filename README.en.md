**English** | [中文](./README.md)

# dsh-hydrasearch

**A TinyFish + AnySearch dual-backend search plugin for DeepSeek Harness.** It registers into the `ctx.web` seam so the built-in `web_search` / `web_fetch` run against two backends with automatic failover. The priority order can be changed by dragging in the plugin page, each backend supports the full parameter set of its API, and all configuration is persisted.

Compatible with **DSH 0.1.6-alpha.2** (`@deepseek-ai/*` 0.1.0-rc.6 and 0.1.6-alpha.2) and **DSH 0.1.7-alpha.1** (`@deepseek-ai/*` 0.1.7-alpha.1). One source tree serves both generations — there is no per-version branch.

- [What it does](#what-it-does)
- [Installation](#installation)
- [Priority and failover](#priority-and-failover)
- [Configuration](#configuration)
- [API keys](#api-keys)
- [Development](#development)

---

## What it does

The plugin registers exactly **one** provider into `ctx.web` — `hydrasearch` — serving both search and fetch. Everything about the two backends lives inside it: the failover chain, per-backend scoping, credential resolution, and the settings card. TinyFish and AnySearch are invisible to the seam.

What actually takes effect:

- `web_search` → tries both backends in priority order and returns the normalized `{url, title, snippet, publishedAt}`
- `web_fetch` → same as above
- Plugin page configuration card: drag the priority order, enter keys, tune every API parameter of each backend
- To pin a capability to a single backend, use `searchBackend` / `fetchBackend` (default `auto` walks the chain)

---

## Installation

```sh
dsh plugin --profile web add github:dgagf111/dsh-hydrasearch
```

Then restart `dsh web`.

<details>
<summary>Install from source / manual deploy</summary>

```powershell
# Run the deploy script with the node bundled with DSH: it mirrors the package into the profile and wires it up as a bundle
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node scripts\deploy.mjs --profile desktop
```

The script mirrors the package into the profile as a **bundle** (a real directory, not a symlink) and writes it into `dsh.profile.bundles` and `dependencies` — both are prerequisites for the Plugins page to list it.

</details>

Then point the web seam at it in the profile's user-layer `cordis.patch.yml`. **Both ids must be set together**; setting only one silently drops the other:

```yaml
- id: web
  config:
    searchProvider: hydrasearch
    fetchProvider: hydrasearch
```

> The plugin registers only the `hydrasearch` id, so there is no other value to put here. To change backends, edit `searchBackend` / `fetchBackend`, not the provider.

Restart DeepSeek Harness, then open **Plugins page → Installed → `dsh-hydrasearch` → the row's configure entry**.

> The plugin registers only the `hydrasearch` id, so there is no other value to put here. To change backends, edit `searchBackend` / `fetchBackend`, not the provider.

> `$DSH_HOME` defaults to `%USERPROFILE%\.dsh` on Windows and `~/.dsh` on macOS/Linux; the profile layout is `$DSH_HOME/profiles/<profile>/`. The example above is PowerShell — adapt the path syntax for other shells.
>
> Why a bundle install is mandatory, and why symlinks fail — see the [integration notes](./docs/integration-notes.md).

### Credentials (TinyFish required, AnySearch optional)

**The API key lives in exactly ONE place: the credential center** (`~/.dsh/.credentials.yaml`). Click "Save to credential center" in the card; it takes effect on the **next request, with no restart**.

```powershell
# Plugins page → 已安装 → dsh-hydrasearch → the row's configure control → paste the key → Save to credential center
```

TinyFish requires a key; AnySearch works anonymously at a lower quota.

> Environment variables (`TINYFISH_API_KEY` / `ANYSEARCH_API_KEY`), `~/.tinyfish/config.json`, and the skill's `.env` are **no longer key sources** — the plugin reads, writes, and clears through the credential center alone. That is what makes Clear actually clear.

---

## Priority and failover

`config.priority` is a persisted, ordered list of backend ids, e.g. `["tinyfish", "anysearch"]`.

- **Drag** the rows in the card to reorder (the `↑`/`↓` buttons and `Alt+↑`/`Alt+↓` on a focused row also work)
- Dragging edits a draft only; clicking Save persists it, sharing one revision check with the other fields
- The list is **re-read on every search**, so a reorder takes effect on the **next search with no restart**
- Unknown ids are dropped, duplicates collapsed, and missing backends restored in default order — so a hand-edited `settings.yaml` can never make a backend silently vanish

Search walks the list top-down:

1. `available()` is false (no key / disabled / malformed endpoint) → recorded as `skipped-unavailable`, **skipped without being tried**
2. Tried → failed → recorded as `failed` with the reason → move to the next
3. Succeeded → return the result, annotated with the backend that actually served it and why earlier ones did not

Two honesty rules:

- **"Never tried" and "tried and failed" are kept strictly distinct.** The former only means local configuration is missing; the latter is evidence the backend is broken.
- **Cancellation (`AbortSignal`) never triggers failover.** A user abort must stop the request, not silently retry elsewhere.

With `failover` off, only the first available backend is used and its failure is final. When every backend fails, the **first** failure is thrown (so operators see the root cause) rather than a vague aggregate error.

To pin a capability entirely to one backend (no failover), change `searchBackend` / `fetchBackend` from `auto` to a backend id. An unknown id falls back to the normal chain walk rather than making the capability unreachable.

---

## Configuration

Every field is persisted in the `hydrasearch` settings namespace. Each field is written as an **independent path** (e.g. `['tinyfish','language']`), so editing one backend can never clobber the other.

### Chain (top level)

| Field | Default | Meaning |
| --- | --- | --- |
| `priority` | `[tinyfish, anysearch]` | Backend order, adjusted by dragging in the card |
| `failover` | `true` | Whether to switch to the next backend on failure |
| `takeOverSearch` | `true` | Claim the seat when `web.searchProvider` is unset |
| `takeOverFetch` | `true` | Same, for fetch |
| `searchBackend` | `auto` | `auto` follows the priority; or pin one backend id |
| `fetchBackend` | `auto` | Same, for `web_fetch` |

### TinyFish (`tinyfish.*`)

| Field | Default | API parameter |
| --- | --- | --- |
| `enabled` | `true` | — |
| `searchBaseURL` | `https://api.search.tinyfish.ai/` | Search endpoint |
| `fetchBaseURL` | `https://api.fetch.tinyfish.ai/` | Fetch endpoint |
| `purpose` | see note | `purpose` intent hint (sent on search AND fetch) |
| `language` | `''` | `language` |
| `location` | `''` | `location` |
| `domainType` | `''` | `domain_type`: `web` / `news` / `research_paper` |
| `includeDomains` | `''` | `include_domains` (comma-separated) |
| `excludeDomains` | `''` | `exclude_domains` (comma-separated) |
| `afterDate` | `''` | `after_date` (`YYYY-MM-DD`) |
| `beforeDate` | `''` | `before_date` (`YYYY-MM-DD`) |
| `recencyMinutes` | `0` | `recency_minutes` (0 = omitted) |
| `pubYearMin` | `0` | `pub_year_min` (0 = omitted) |
| `pubYearMax` | `0` | `pub_year_max` (0 = omitted) |
| `maxPages` | `3` | Max pages per search (1–10) |
| `fetchFormat` | `markdown` | Fetch format: `markdown` / `html` / `json` |
| `fetchLinks` | `false` | Also return the page's links when fetching |
| `fetchImageLinks` | `false` | `image_links`: also return the page's image links |
| `fetchPerUrlTimeoutMs` | `0` | `per_url_timeout_ms` (0 = omitted; service accepts 1–110000) |
| `fetchTtlSeconds` | `-1` | `ttl`: `-1` = omitted (accept any cache), `0` = force live, `N` = accept cache younger than N seconds |
| `verbose` | `false` | Log every search/fetch |

> `purpose` is **non-empty by default**: `Gather current, citable web sources to answer a user question`. TinyFish treats it as the "why" behind the request — the task the results feed — and an agent-facing `web_search`/`web_fetch` always has that intent, which a bare keyword query or URL cannot express. Blank it to send no `purpose` at all and get the service's own default ranking.
>
> `fetchTtlSeconds` is deliberately tri-state: the service treats an **absent** `ttl` as "accept any cached entry" but an explicit `0` as "force a live fetch". Collapsing the two would turn every fetch live by default.

### AnySearch (`anysearch.*`)

| Field | Default | API parameter |
| --- | --- | --- |
| `enabled` | `true` | — |
| `baseURL` | `''` | API base; empty uses the public endpoint |
| `tag` | `''` | `tag` vertical sub-domain (e.g. `finance.quote`); empty = general web search |
| `params` | `''` | `params` vertical parameters (JSON object string); requires `tag` |
| `zone` | `''` | `zone` |
| `language` | `''` | `language` |
| `maxResults` | `10` | `max_results` (1–10) |
| `verbose` | `false` | Log |

The write path validates that endpoints are absolute URLs, `maxPages` is 1–10, `fetchFormat` is legal, `fetchPerUrlTimeoutMs` is 0 or 1–110000, `fetchTtlSeconds` is ≥ -1, dates are `YYYY-MM-DD`, and `params` is a valid JSON object that also has a `tag`. Bad values are **rejected at the card**, rather than silently disabling a backend until the next restart.

---

## API keys

**One store only — the credential center** — with read, write, and clear aligned on it:

| Operation | Target |
| --- | --- |
| Read (per request, never cached) | `ctx.credentials.resolve(ref)` |
| Write (card's "Save to credential center") | the same ref |
| Clear (card's "Clear") | the same ref |

The references are plugin-owned, and **deliberately not** named after the conventional environment variables:

- TinyFish: `HYDRASEARCH_TINYFISH_API_KEY`
- AnySearch: `HYDRASEARCH_ANYSEARCH_API_KEY`

> **Why rename them**: once a credential reference shares its name with a common environment variable, that ref is permanently **shadowed** on any machine that exports one. The credential center then **refuses** writes to a shadowed ref on purpose — a write that resolution ignores is worse than an error — leaving the card unable to store *or* clear the key. A plugin-owned name removes that deadlock entirely.

The card's badge names which layer inside the credential center supplies the key (local file / environment layer / `.env` layer). When that layer is read-only, "Clear" says so honestly — "removed from the writable store, but a read-only layer still supplies it" — instead of pretending to have succeeded.

> With no key, TinyFish is skipped by the chain (`skipped-unavailable`, never attempted) and the search falls through to AnySearch.

---

## Development

```bash
npm install --legacy-peer-deps
npm run verify              # server-side units + contracts (skips live network when no key)
npm run verify:client       # browser half
npm run verify:integration  # in-process integration
npm run verify:all          # all of them
npm run deploy              # deploy into the profile
```

`verify-profile.mjs` needs a real profile and must run under DSH's bundled node; the other three run standalone without DSH.

For what each of the four suites covers, the DSH integration traps (bundle installs, row anchoring, cross-version symbols, symlinks), and the dependency-generation gotcha, see the [integration notes](./docs/integration-notes.md).

---

## Layout

```
dsh-hydrasearch/
├── lib/
│   ├── index.js      # Plugin body: the hydrasearch provider, failover chain, settings, bridge routes, system prompt
│   ├── tinyfish.js   # TinyFish transport
│   ├── anysearch.js  # AnySearch transport
│   └── client.js     # Browser half: priority dragging + per-backend parameter forms (no build needed)
├── scripts/          # deploy + the four verification suites
├── docs/             # integration notes
├── cordis.patch.yml  # Bundle patch (documents all default values)
└── package.json
```

## License

MIT
