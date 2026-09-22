# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

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
