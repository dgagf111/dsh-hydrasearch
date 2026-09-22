**English** | [中文](./README.md)

# dsh-hydrasearch

**A TinyFish + AnySearch dual-backend search plugin for DeepSeek Harness.** It registers into the `ctx.web` seam so the built-in `web_search` / `web_fetch` run against two backends with automatic failover. The priority order can be changed by dragging in the plugin page, each backend supports the full parameter set of its API, and all configuration is persisted.

Compatible with **DSH 0.1.6-alpha.2** (`@deepseek-ai/*` 0.1.0-rc.6).

- [What it does](#what-it-does)
- [Installation](#installation)
- [Priority and failover](#priority-and-failover)
- [Configuration](#configuration)
- [API keys](#api-keys)
- [Development](#development)

---

## What it does

The plugin registers three providers into `ctx.web`:

| provider id | behavior |
| --- | --- |
| `hydrasearch` | **Failover chain**: tries each backend in `priority` order and switches to the next on failure. Defaults to this one. |
| `tinyfish` | TinyFish only, no switchover |
| `anysearch` | AnySearch only, no switchover |

Because all three are registered, you can either use the chain (the default) or point `web.searchProvider` at `tinyfish` or `anysearch` to pin exactly one backend — **without uninstalling the plugin**.

What actually takes effect:

- `web_search` → tries both backends in priority order and returns the normalized `{url, title, snippet, publishedAt}`
- `web_fetch` → same as above (use `fetchBackend` to pin a single backend on its own)
- Plugin page configuration card: drag the priority order, enter keys, tune every API parameter of each backend

---

## Installation

```powershell
# Run the deploy script with the node bundled with DSH: it mirrors the package into the profile and wires it up as a bundle
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node scripts\deploy.mjs --profile desktop
```

The script mirrors the package into the profile as a **bundle** (a real directory, not a symlink) and writes it into `dsh.profile.bundles` and `dependencies` — both are prerequisites for the Plugins page to list it.

Then point the web seam at it in the profile's user-layer `cordis.patch.yml`. **Both ids must be set together**; setting only one silently drops the other:

```yaml
- id: web
  config:
    searchProvider: hydrasearch
    fetchProvider: hydrasearch
```

Restart DeepSeek Harness, then open **Plugins page → Installed → `dsh-hydrasearch` → the row's configure entry**.

> `$DSH_HOME` defaults to `%USERPROFILE%\.dsh` on Windows and `~/.dsh` on macOS/Linux; the profile layout is `$DSH_HOME/profiles/<profile>/`. The example above is PowerShell — adapt the path syntax for other shells.
>
> Why a bundle install is mandatory, and why symlinks fail — see the [integration notes](./docs/integration-notes.md).

### Credentials (optional but recommended)

TinyFish requires a key; AnySearch works anonymously at a lower quota. Either way:

```powershell
tinyfish auth login          # writes ~/.tinyfish/config.json
# or enter it directly in the plugin card, which stores it in the credential center ~/.dsh/.credentials.yaml
```

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
| `fetchBackend` | `auto` | `auto` follows the priority; or pin one backend id |

### TinyFish (`tinyfish.*`)

| Field | Default | API parameter |
| --- | --- | --- |
| `enabled` | `true` | — |
| `apiKey` | `''` | `X-API-Key`; empty falls back to env / CLI config |
| `apiKeyEnv` | `TINYFISH_API_KEY` | Credential-center reference name |
| `searchBaseURL` | `https://api.search.tinyfish.ai/` | Search endpoint |
| `fetchBaseURL` | `https://api.fetch.tinyfish.ai/` | Fetch endpoint |
| `purpose` | `''` | `purpose` intent hint |
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
| `verbose` | `false` | Log every search/fetch |

### AnySearch (`anysearch.*`)

| Field | Default | API parameter |
| --- | --- | --- |
| `enabled` | `true` | — |
| `apiKey` | `''` | `Authorization: Bearer`; **empty means anonymous access** |
| `apiKeyEnv` | `ANYSEARCH_API_KEY` | Credential-center reference name |
| `baseURL` | `''` | API base; empty uses the public endpoint |
| `tag` | `''` | `tag` vertical sub-domain (e.g. `finance.quote`); empty = general web search |
| `params` | `''` | `params` vertical parameters (JSON object string); requires `tag` |
| `zone` | `''` | `zone` |
| `language` | `''` | `language` |
| `maxResults` | `10` | `max_results` (1–10) |
| `verbose` | `false` | Log |

The write path validates that endpoints are absolute URLs, `maxPages` is 1–10, `fetchFormat` is legal, dates are `YYYY-MM-DD`, and `params` is a valid JSON object that also has a `tag`. Bad values are **rejected at the card**, rather than silently disabling a backend until the next restart.

---

## API keys

Both backends resolve in this order: **plugin config → environment variable → local file → credential center**

- TinyFish: `TINYFISH_API_KEY` env → `~/.tinyfish/config.json` (written by `tinyfish auth login`)
- AnySearch: `ANYSEARCH_API_KEY` env → `~/.agents/skills/anysearch/.env`

You can also use "write to credential center" in the card (`~/.dsh/.credentials.yaml`). Keys are **read per call and never cached**, so saving one takes effect on the **next request without a restart**.

> **Note**: if you `export`ed the key in a shell and started dsh from it, the credential center **refuses the write** and reports
> `"... is supplied read-only by the launching environment, so set would be shadowed; unset it in the shell you start dsh from instead"`.
> That protection is correct — otherwise the write would "succeed" while still being shadowed by the environment variable. Unset it in the shell first if you want the credential center to own the key.

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
│   ├── index.js      # Plugin body: the three providers, failover chain, settings, bridge routes, system prompt
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
