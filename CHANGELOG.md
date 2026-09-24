# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`scripts/verify-workflow.mjs` validates the CI file itself.** The workflow is
  the only place the supported-generation matrix is declared, and a mistake there
  is invisible until GitHub runs it — which is how both of this release's CI
  failures happened. The script asserts exact pins only (no `^`/`~` on any
  `@deepseek-ai/*`, `react`, or `react-dom` entry), the four-generation matrix,
  the conditional `dsh-settings-file` install, and that the two suites needing a
  file-backed settings service carry their `settingsFile` gate. It parses the YAML
  when the `yaml` package resolves and falls back to structural checks otherwise,
  so it cannot itself become a new way for the suite to fail on a different tree.
  Wired into `npm run verify:all` and into CI as its own step.
- **The TinyFish fetch path now exposes every parameter the API accepts.** Four
  were supported by the transport but absent from the config schema, so the
  READMEs' "supports the API's parameters" claim was not yet true:
  - `tinyfish.fetchImageLinks` — `image_links`, return the page's image URLs.
  - `tinyfish.fetchPerUrlTimeoutMs` — `per_url_timeout_ms`; `0` (default) omits
    the field, otherwise the service's `1`–`110000` window applies.
  - `tinyfish.fetchTtlSeconds` — `ttl`, **tri-state** because the service does:
    `-1` (default) omits the field and accepts any cached entry, `0` forces a
    live fetch, and `N` accepts a cache entry younger than `N` seconds.
    Collapsing the omitted and live cases onto one value would silently turn
    every fetch live.
  - `tinyfish.purpose` is now also sent on the **fetch** path, not only search.
- `tinyfish.purpose` **defaults to a non-empty intent hint**
  (`Gather current, citable web sources to answer a user question`). TinyFish
  documents `purpose` as the "why" behind a request — the task the results feed
  — and an agent-facing `web_search`/`web_fetch` always has that intent, which a
  bare keyword query or URL cannot express. Everyone else in the group is left
  as-is, so the only behaviour change on a default install is the added hint
  (and clearing the field restores the service's own default ranking).
- The settings card gains fields for the four new fetch controls, and the
  system-prompt note now reports the fetch-path configuration alongside search
  scoping, so the model is told what is actually in force.
- Verification coverage for the new surface: the transport-level `ttl`
  sentinel, the config-to-wire path for fetch controls through
  `BackendRuntime.fetch`, and an end-to-end check on a real Cordis context that
  the shipped `purpose` default reaches both the search query string and the
  fetch body. `verify.mjs` 80 → 84 checks, `verify-integration.mjs` 24 → 25.
- **Compatibility with DSH 0.1.7-alpha.1's settings service.** That release
  replaced `SettingsProvider` with `SettingsForms`, which takes no registration
  at all and derives its forms from the plugin's `Config` schema — but only for
  fields under a `volatile` node. Three shims keep one source working on the
  0.1.6-alpha.2 desktop build, 0.1.7-alpha.1, and the rc line:
  - `installSettingsSection` gained a third capability branch: `installSection`
    (0.1.6) → `register` (rc / earliest) → `settings/document-updated`
    subscription (0.1.7, where nothing is registered and the loader entry id
    *is* the namespace).
  - `volatile()` feature-detects schemastery's `.volatile()` marker, which
    arrived in 3.18.3. The 0.1.6-alpha.2 desktop build ships 3.18.2, where the
    method does not exist, so an unconditional call would throw during module
    evaluation and take the whole plugin down at import time.
  - `resolveConfigObject()` / `unwrapVolatile()` / `isVolatileRef()` read through
    the cordis volatile reference that a volatile-marked schema makes the loader
    hand to `apply()`. Detection is by the `cosmokit.volatile.write` symbol, so
    it survives the duplicate package copies a profile keeps.
  The root of `Config` is marked volatile rather than each of its ~35 leaves.
  0.1.7 rejects any settings write whose path is not volatile
  (`Config field "..." is not volatile`), and `volatileForm()` omits an entry
  with no volatile ancestor — so without the root mark the card would render
  nothing and every save would throw. One root mark covers every present and
  future field, and keeps the nested backend schemas plain so
  `TinyfishConfig({})` still returns a section rather than a ref.
- `verify.mjs` gains a `release-compatibility contract` block that fails if any
  of the three shims is removed. All of them were confirmed to fail against the
  previous revision of `lib/index.js`. It now holds 10 checks (84 → 94 in the
  suite overall): the fresh-schema marker test, `registrationSafeSchema`
  coverage (copy-not-mutate, marker removal, defaults still resolve, marker-free
  input passes through), and the assertion that BOTH self-resolving branches
  receive the unmarked twin.

### Fixed

- **A volatile-marked `Config` broke the settings card on the registration
  generation.** `SettingsProvider.register` (rc line) and
  `settings.installSection` (0.1.6-alpha.2) resolve the schema themselves and
  STORE the result (`registration.resolved = schema(mergeLayers(base, section))`).
  A volatile node returns a cordis REF when called, so those services stored a
  ref: `settings.get(ns).priority` was `undefined`, `describe()` handed the card
  a ref it rendered as empty, and the `validate` hook received a ref — so
  `validateConfig` saw no `tinyfish` / `anysearch` section and **every malformed
  value passed**. The visible symptom was a working search tool with a dead
  configuration card and unenforced validation, and nothing logged anywhere.
  New `registrationSafeSchema()` derives an unmarked twin (schemastery's own
  `z(schema)` copy idiom, root marker removed) and `installSettingsSection`
  passes it to the two self-resolving branches only. The `SettingsForms`
  generation keeps the marked original, because it reads `meta.volatile` and
  never calls the schema. Only the ROOT is unmarked; the nested backend schemas
  were never marked, so no descendant can become a ref.
  The bug only appears when a marker-capable schemastery (>= 3.18.3) is paired
  with a registration-generation settings service — which is exactly what CI
  resolves from the `^3.18.2` range, and why the 3.18.2-only era never saw it.
- **CI was not pinned, so a dependency release could redden an unchanged
  commit.** The install step used `@deepseek-ai/schemastery@^3.18.2`, so the
  3.18.2 -> 3.18.4 publication changed what CI tested without any code change.
  The range is now an explicit two-entry matrix (`3.18.2` = the desktop build's
  marker-less release, `3.18.4` = the current marker-capable one) and every other
  install entry is exact too (`@deepseek-ai/cordis@4.0.1`, `react@18.3.1`).
- **A release-compatibility check tested the dependency, not the plugin.**
  `volatile() marks when the runtime can...` re-marked `plugin.Config`, which is
  already marked at module load; schemastery deliberately rejects a second
  `.volatile()` call (`volatile schema is already wrapped`), so the check began
  failing the moment a marker-capable version was installed. It now marks a fresh
  schema, asserts the source node is untouched, and separately asserts that
  `Config` itself carries the marker.
- `verify.mjs`'s `release-compatibility contract` block grows to 10 checks: the
  fresh-schema marker test plus `registrationSafeSchema` coverage (copy-not-mutate,
  marker removal, defaults still resolve, marker-free input passes through) and
  the assertion that BOTH self-resolving branches receive the unmarked twin.
  94/94 checks locally; the integration suite is green on all three generations
  (rc.6, 0.1.6-alpha.2, 0.1.7-rc.1).
- **The "Test the chain" result reported `耗时 undefinedms`.** The `/test`
  bridge route's probe objects are built by hand, and neither `singleProbe` nor
  `chainProbe` copied `latencyMs` off the backend result — so every *successful*
  test rendered `undefined` where the measured time belongs. Both probes now
  carry it, and the field is covered through the real route handler.
- **A configured TinyFish key could neither be replaced nor cleared.** The
  credential-center reference was `TINYFISH_API_KEY` — the same name as the
  conventional environment variable. On any machine that exports it, the
  credential provider layers the launch environment ABOVE its writable document
  and refuses `set`/`unset` for a shadowed reference (correctly: a write
  resolution ignores is worse than an error). The card therefore failed the
  save with `supplied read-only by the launching environment` and disabled Clear
  outright, while the badge still claimed "configured in the credential center".
  The references are now plugin-owned (`HYDRASEARCH_TINYFISH_API_KEY`,
  `HYDRASEARCH_ANYSEARCH_API_KEY`), which cannot be shadowed by accident.
- **Clear could report success while the key stayed in force.** `/key-unset` now
  re-describes the reference after the durable clear and reports
  `cleared: false` plus the layer still supplying it (`shadowedBy`), instead of
  implying the key is gone. The card renders that distinction and no longer
  disables the button for a read-only layer.

### Changed

- **Both READMEs were rewritten for the person installing the plugin, not the
  person maintaining it.** They now lead with the two things a reader actually
  decides on — that both backends are free and that the rate limits are high
  enough to forget about — then give a quota/limit table, the install command,
  and the card's controls. The vendor figures in that table (TinyFish Search
  30/min · 500/hour and Fetch 150 URLs/min · 1,000 URLs/day, free at any account
  balance; AnySearch free tier 1,000/day at 20 QPS, anonymous sharing that quota
  under a per-IP limit) are attributed to the vendors' own pages, with a note
  that they may change. Dropped in the process: the internal design rationale,
  the cross-generation shim explanation, the development section, and the file
  layout — all of which remain in `docs/`. A new "API keys and privacy" section
  states the single-store contract in user terms: the key stays in the local
  credential center, is sent only to the service being called, and read/write/
  clear all address the same place.
- **API keys now have exactly ONE home: the credential center.** Read, write,
  and clear all address it, so the store the card saves into is the store a
  request authenticates from. The environment, `~/.tinyfish/config.json` (the
  TinyFish CLI's file), the plugin config, and the AnySearch skill's `.env` are
  **no longer key sources**. Previously a key could be supplied by a layer the
  card could neither show nor edit, which is how a saved key appeared to have no
  effect.
- **The credential reference is renamed** to `HYDRASEARCH_TINYFISH_API_KEY` /
  `HYDRASEARCH_ANYSEARCH_API_KEY` (see Fixed). A key previously stored under the
  old names must be re-entered in the card. `TINYFISH_API_KEY` /
  `ANYSEARCH_API_KEY` remain exported as diagnostic names only.
- `tinyfish.apiKey`, `tinyfish.apiKeyEnv`, `anysearch.apiKey`, and
  `anysearch.apiKeyEnv` are removed from the config schema and from
  `cordis.patch.yml`. A stale value in an existing `settings.yaml` is ignored
  (the schema fills no such field).
- The card's key badge now names the credential-center layer that supplies the
  value (local file / environment layer / `.env` layer) instead of reporting
  every configured key as an ordinary stored one.
- `BackendRuntime` reads keys through a new per-context `CredentialKeyStore`.
  The seam's `available()` is synchronous while credential resolution is async,
  so the store holds a snapshot that is refreshed eagerly, on every
  `credentials/updated` event, and after each durable write. `resolve()` stays
  authoritative and per-operation: the snapshot only decides whether a backend
  is *offered*, never which key reaches the wire.
- The auto-registered-key adoption path writes to the credential center only;
  its `.env` fallback is removed along with the second store it represented.

### Added

- English README (`README.en.md`) with a language switcher, and a `$DSH_HOME`
  path convention that is not Windows-specific.
- `LICENSE` file (MIT). The license was already declared in `package.json` and
  the README; this adds the canonical file GitHub reads.
- `.gitattributes` forcing LF in the repository. Copies of this package are
  compared byte-for-byte against the installed tree, so line-ending drift is a
  real failure mode rather than cosmetics.
- GitHub Actions CI running the offline test suites on Node 20 and 22.
- Regression coverage for the TinyFish domain-list contract: omitting
  `includeDomains` / `excludeDomains` entirely, blank entries inside a supplied
  list, and a list that is blank after trimming.

### Fixed

- Two verification checks were non-hermetic: they passed only on a machine that
  had run `tinyfish auth login` and had a `~/.tinyfish/config.json`. On a clean
  CI runner they failed. The CLI-config precedence check now asserts against a
  scratch home directory it creates itself, and the single-provider check
  supplies an explicit key instead of relying on ambient credentials.
  `resolveTinyfishKey()` gained an injectable `home` parameter so the fallback
  is provable without touching the developer's real config.
- `searchTinyfish()` threw `TypeError: Cannot read properties of undefined
  (reading 'length')` when `includeDomains` / `excludeDomains` were omitted,
  despite both being documented as optional. A new `domainList()` normalizer
  treats an absent or non-array value as "no restriction".
- Blank entries inside a domain list were documented as dropped but were in
  fact sent to the service verbatim (e.g. `,+github.com+,`). They are now
  trimmed and removed, and an all-blank list is omitted instead of sent empty
  (TinyFish rejects an empty `include_domains`).

### Changed

- **The plugin now registers exactly one provider.** `tinyfish` and `anysearch`
  are no longer registered as `ctx.web` providers; the single `hydrasearch`
  provider serves both search and fetch, and both backends are internal to it.
  This removes a real failure mode: with three providers registered, an unset
  `web.searchProvider` was ambiguous whenever two backends were usable, so the
  seam raised `WEB_PROVIDER_AMBIGUOUS` and the operator had to name a provider
  just to get search working. A single candidate is never ambiguous.
- Pinning a capability to one backend is now **configuration**
  (`searchBackend` / `fetchBackend`, both default `auto`) instead of a
  registration trick that repointed `web.searchProvider` at a backend id. The
  new `searchBackend` key mirrors the existing `fetchBackend`, and an unknown id
  degrades to the normal chain walk rather than making the capability
  unreachable.
- `SingleBackendProvider` is gone, along with the two extra registrations.
- The settings card gains a `searchBackend` selector next to `fetchBackend`;
  both are persisted as their own path ops and offer only backends present in
  the live priority list.
- Both READMEs were cut from ~460 lines to ~205 and restructured to match what
  other DSH plugins actually document: what it does, install, priority/failover,
  configuration, API keys, development. The maintainer-facing material — why the
  package must be installed as a bundle, row-name anchoring, cross-version symbol
  imports, the symlink trap, internal design tradeoffs, and the CI/dependency
  generation gotchas — moved to `docs/integration-notes.md`, which the READMEs
  now link to.
- `scripts/verify-profile.mjs` no longer asserts the presence of specific
  third-party rows that happened to exist in the maintainer's own profile. Those
  are rows the operator owns; requiring them made the suite fail on every other
  machine. The check now verifies that pre-existing rows are *preserved* rather
  than that particular private rows exist, and it tolerates a user layer with no
  `insert` list at all.
- `scripts/verify-profile.mjs` accepts both supported web-seam wirings: an
  explicit user-layer override, or reliance on the plugin's `takeOverSearch` /
  `takeOverFetch` guards when the seat is unset. An incomplete explicit override
  (only one of the two ids) is still a failure.
- The auto-registered-key test fixture no longer uses an `as_sk_<32 hex>`
  placeholder, which had the exact shape of a live credential and tripped secret
  scanners. It is now an obviously fake token.

## [0.2.0]

### Added

- Multi-backend web search and fetch for DeepSeek Harness. Registers three
  providers on the `ctx.web` seam: `hydrasearch` (the failover chain), plus
  `tinyfish` and `anysearch` as single-backend providers so an operator can pin
  one without uninstalling the plugin.
- Operator-controlled backend priority, persisted in the `hydrasearch` settings
  namespace and reorderable by dragging in the Plugins page card.
- Automatic failover with an honest result note: the outcome distinguishes a
  backend that was *never tried* (no key / disabled) from one that *failed*.
- Per-backend configuration in the settings card, covering every API parameter
  each backend supports, written as independent paths so editing one backend can
  never clobber the other.
- Bridge routes for probing the chain or a single backend, reading and writing
  credentials, and AnySearch sub-domain discovery.
- Four verification suites: `verify.mjs` (transports, providers, failover,
  bridge guardrails, plus live-network checks), `verify-client.mjs` (the browser
  half under real React), `verify-profile.mjs` (install shape via DSH's own
  loader), and `verify-integration.mjs` (in-process on a real Cordis context).

[Unreleased]: https://github.com/dgagf111/dsh-hydrasearch/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/dgagf111/dsh-hydrasearch/releases/tag/v0.2.0
