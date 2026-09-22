/**
 * Multi-backend web search + fetch for DeepSeek Harness, served by TinyFish and
 * AnySearch with an operator-controlled priority order.
 *
 * ## Shape
 *
 * The plugin registers exactly ONE provider into `ctx.web` — `hydrasearch` —
 * for both the search and fetch capabilities. Everything about the two backends
 * lives inside it: the failover chain, per-backend scoping, credential
 * resolution, and the settings card. Nothing about TinyFish or AnySearch is
 * visible to the seam, so the seam's provider registry stays a single entry and
 * `web.searchProvider` never has to name a backend.
 *
 * ## Priority
 *
 * `config.priority` is an ordered list of backend ids. It is persisted in the
 * settings namespace, editable from the Plugins-page card by dragging rows, and
 * re-read on every search — so reordering takes effect on the next call with no
 * restart. Unknown ids are ignored and missing ones appended, so a stale list
 * can never strand a backend that exists.
 *
 * ## Pinning a single backend
 *
 * Pinning is a CONFIG concern, not a registration concern. `searchBackend` and
 * `fetchBackend` both default to `auto` (follow `priority`); setting either to a
 * backend id makes that operation use only that backend, with its failure final.
 * This replaces the older design that registered `tinyfish` and `anysearch` as
 * providers so an operator could repoint `web.searchProvider` at one of them.
 *
 * ## Failover and its honesty rules
 *
 * A backend is tried when it is `available()`. If it fails, the next one runs,
 * and the result carries a note naming the backend that actually served it and
 * why the earlier ones did not. Two distinct non-failure reasons are kept apart,
 * because collapsing them misleads the operator:
 *
 *   - `skipped-unavailable` — the backend was never tried (no key / disabled);
 *   - `failed` — the backend was tried and errored.
 *
 * Cancellation is never a trigger for failover: an aborted user request must
 * stop, not silently retry somewhere else.
 *
 * @module dsh-hydrasearch
 */

import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  fetchAnysearch,
  parseAutoRegisteredKey,
  resolveAnysearchBase,
  searchAnysearch,
  subDomainsAnysearch,
  ANYSEARCH_API_KEY_ENV,
  ANYSEARCH_API_KEY_REF,
  ANYSEARCH_MAX_RESULTS,
  ANYSEARCH_MIN_RESULTS,
} from './anysearch.js'
import {
  fetchTinyfish,
  searchTinyfish,
  TINYFISH_API_KEY_ENV,
  TINYFISH_API_KEY_REF,
  TINYFISH_DOMAIN_TYPES,
  TINYFISH_FETCH_FORMATS,
  TINYFISH_MAX_FETCH_TIMEOUT_MS,
  TINYFISH_MAX_PAGES,
  TINYFISH_MIN_FETCH_TIMEOUT_MS,
  TINYFISH_PAGE_SIZE,
  TINYFISH_SERVICE_MAX_PAGE,
  TinyFishError,
} from './tinyfish.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'hydrasearch'

/** The `ctx.web` seam this plugin contributes providers to. */
export const inject = ['web']

/** Backend ids. Internal only — never registered as provider ids. */
export const TINYFISH_ID = 'tinyfish'
export const ANYSEARCH_ID = 'anysearch'

/** The one provider id this plugin registers, for both search and fetch. */
export const HYDRASEARCH_PROVIDER_ID = 'hydrasearch'

/** Default walk order: the chain tries TinyFish first, then AnySearch. */
export const DEFAULT_PRIORITY = [TINYFISH_ID, ANYSEARCH_ID]

/** Settings namespace the Plugins-page card reads and writes. */
export const HYDRASEARCH_NS = 'hydrasearch'

/** Loopback bridge prefix; the browser half calls exactly these routes. */
export const BRIDGE_PREFIX = '/api/dsh-hydrasearch-settings'

/** Plugin version shown by the settings card. Kept in step with package.json. */
export const PLUGIN_VERSION = '0.2.0'

/** Maximum JSON body accepted by the bridge (settings payloads are small). */
const MAX_JSON_BODY_BYTES = 64 * 1024

/**
 * Fiber states that mean the consumer is tearing down (not merely losing the
 * settings service). Mirrors `FiberState` in cordis; hard-coded because neither
 * `dsh-settings` version exports the enum.
 */
const FIBER_DISPOSED = 4
const FIBER_UNLOADING = 5

/** Whether `ctx`'s own fiber is being torn down. */
function isUnloading(ctx) {
  const state = ctx.fiber?.state
  return state === FIBER_UNLOADING || state === FIBER_DISPOSED
}

/**
 * Brand and validate a settings namespace.
 *
 * Both `dsh-settings` generations validate the same `/^[a-z][a-z0-9-]*$/`
 * pattern, but only the rc-generation EXPORTS a `settingsNamespace()` helper;
 * the 0.1.6-alpha generation performs the check internally and exports nothing.
 * This local helper keeps the plugin loadable on both without a cross-version
 * import.
 *
 * @param value - candidate namespace.
 * @returns the validated namespace.
 * @throws {TypeError} when it is not a lowercase hyphenated identifier.
 */
export function settingsNamespace(value) {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new TypeError(`settings namespace "${value}" must match /^[a-z][a-z0-9-]*$/`)
  }
  return value
}

/**
 * Install the canonical optional-settings wiring for a namespace: while a
 * settings service is mounted, register `ns` with the composition entry as its
 * `base` layer and point `hooks.setSource` at the resolved scope; when the
 * service goes away, fall back to the entry.
 *
 * WHY THIS IS LOCAL RATHER THAN IMPORTED
 * --------------------------------------
 * `installSettingsSection` exists only in the rc-generation of `dsh-settings`.
 * The 0.1.6-alpha generation renamed that free function to the provider METHOD
 * `settings.installSection(owner, ns, schema, entry, hooks)` and exports no
 * replacement. A static `import { installSettingsSection } from
 * '@deepseek-ai/dsh-settings'` therefore fails at ESM LINK time on alpha:
 *
 *   SyntaxError: The requested module '.../dsh-settings/lib/index.js'
 *   does not provide an export named 'installSettingsSection'
 *
 * which surfaces as the loader's opaque `failed to import` (`entry.fiber ===
 * undefined`) — the whole plugin dies, not just its settings card. This is
 * exactly what the desktop app hit: it runs a 0.1.6-alpha.2 tree and FORCES
 * profile-local `@deepseek-ai/*` imports onto that tree (app-boot
 * `installProfileResolution(..., 'enforce')`).
 *
 * Both generations DO expose `settings.register(ns, schema, { base, validate })`
 * with identical semantics, so building on that one method is what makes the
 * plugin version-independent. `installSection` is preferred when present
 * because it owns the fiber-scoped cleanup itself.
 *
 * @param ctx - the consumer plugin context owning the wiring.
 * @param ns - the consumer-owned settings namespace.
 * @param schema - schema resolving the namespace (typically the plugin Config).
 * @param entry - the consumer's composition entry config, used as `base`.
 * @param hooks - `setSource` sink, `onChange` notification, optional `validate`.
 */
export function installSettingsSection(ctx, ns, schema, entry, hooks) {
  ctx.inject(['settings'], (sctx) => {
    const provider = sctx.settings
    const options = {
      base: entry,
      ...hooks.validate === undefined ? {} : { validate: hooks.validate },
    }

    // Preferred path: the provider owns registration and cleanup.
    if (typeof provider.installSection === 'function') {
      provider.installSection(ctx, ns, schema, entry, hooks)
      return
    }

    // Portable path: plain `register`, with the same effect contract the
    // shipped helper implements (swap the source back on disposal, then notify).
    const scope = provider.register(settingsNamespace(ns), schema, options)
    hooks.setSource(() => scope.get())
    sctx.effect(() => () => {
      if (isUnloading(ctx)) return
      hooks.setSource(() => entry)
      hooks.onChange()
    })
    hooks.onChange()
    scope.watch(() => {
      if (isUnloading(ctx)) return
      hooks.onChange()
    })
  })
}

/** TinyFish backend config. Every field is optional and defaulted. */
export const TinyfishConfig = z.object({
  /** Take part in the failover chain. */
  enabled: z.boolean().default(true),
  /**
   * Search endpoint. Override for a self-hosted or staging deployment.
   *
   * There is deliberately NO `apiKey` / `apiKeyEnv` field. The TinyFish key has
   * exactly ONE home — the credential center, under {@link TINYFISH_API_KEY_REF}
   * — so read, write, and clear all address the same place. A config-level key
   * would be a second, invisible store that the settings card cannot write and
   * that would silently outrank (or be outranked by) the one the card edits.
   */
  searchBaseURL: z.string().default('https://api.search.tinyfish.ai/'),
  /** Fetch endpoint (see `searchBaseURL`). */
  fetchBaseURL: z.string().default('https://api.fetch.tinyfish.ai/'),
  /**
   * Freeform intent hint sent as `purpose`.
   *
   * Non-empty BY DEFAULT, unlike every other scoping field here. TinyFish
   * documents `purpose` as the "why" behind a request — the task the results feed
   * — and it is honoured on BOTH the search and the fetch path. An agent-facing
   * `web_search`/`web_fetch` always has one (it is answering a question with
   * citable sources), but a terse keyword query or a bare URL does not say so;
   * the default states it and the service gets signal it would otherwise lack.
   * Blank it out to send no `purpose` at all and get the service's default
   * ranking and extraction behaviour.
   */
  purpose: z.string().default('Gather current, citable web sources to answer a user question'),
  /** Language hint forwarded as `language` (e.g. `zh`). */
  language: z.string().default(''),
  /** Location hint forwarded as `location`. */
  location: z.string().default(''),
  /** Domain scope: `web` | `news` | `research_paper`; blank lets the service decide. */
  domainType: z.string().default(''),
  /** Comma-separated domains to restrict results to. */
  includeDomains: z.string().default(''),
  /** Comma-separated domains to exclude. */
  excludeDomains: z.string().default(''),
  /** `YYYY-MM-DD` lower bound for publication date. */
  afterDate: z.string().default(''),
  /** `YYYY-MM-DD` upper bound for publication date. */
  beforeDate: z.string().default(''),
  /** Freshness window in minutes; 0 disables. */
  recencyMinutes: z.number().default(0),
  /** Earliest publication year; 0 disables. */
  pubYearMin: z.number().default(0),
  /** Latest publication year; 0 disables. */
  pubYearMax: z.number().default(0),
  /** Pages fetched per search (1–10); each page is one billed round trip. */
  maxPages: z.number().default(TINYFISH_MAX_PAGES),
  /** Extraction format used by the fetch path. */
  fetchFormat: z.string().default('markdown'),
  /** Also return the page's extracted links on fetch. */
  fetchLinks: z.boolean().default(false),
  /** Also return the page's extracted image URLs on fetch (`image_links`). */
  fetchImageLinks: z.boolean().default(false),
  /**
   * Per-URL wall-clock budget for fetch in milliseconds (`per_url_timeout_ms`).
   * `0` omits the field and lets the service decide. The service accepts
   * `1`–`110000`, and a URL that overruns is reported in `errors[]` while the
   * rest of the batch still completes.
   */
  fetchPerUrlTimeoutMs: z.number().default(0),
  /**
   * Fetch cache freshness tolerance in seconds (`ttl`).
   *
   * Tri-state on purpose, and the sentinel is `-1` rather than `0`: the service
   * treats an ABSENT `ttl` as "accept any cached entry" but an explicit `0` as
   * "force a live fetch". Collapsing the two onto `0` would silently turn every
   * fetch live. So `-1` omits the field, `0` asks for a live fetch, and `N`
   * accepts cache entries younger than N seconds.
   */
  fetchTtlSeconds: z.number().default(-1),
  /** Log each search/fetch at info level. */
  verbose: z.boolean().default(false),
})

/** AnySearch backend config. Every field is optional and defaulted. */
export const AnysearchConfig = z.object({
  /** Take part in the failover chain. */
  enabled: z.boolean().default(true),
  /**
   * API host. Empty resolves to the public host.
   *
   * As with TinyFish, there is ONE key home: the credential center under
   * {@link ANYSEARCH_API_KEY_REF}. AnySearch still permits anonymous access, so
   * an empty credential center is legal rather than unavailable.
   */
  baseURL: z.string().default(''),
  /** Vertical sub-domain tag, e.g. `finance.quote`. Blank = general web search. */
  tag: z.string().default(''),
  /** Vertical parameters as a JSON object string, e.g. `{"type":"stock","symbol":"AAPL"}`. */
  params: z.string().default(''),
  /** Geographic zone hint. */
  zone: z.string().default(''),
  /** Language hint. */
  language: z.string().default(''),
  /** Per-query result bound (1–10). */
  maxResults: z.number().default(ANYSEARCH_MAX_RESULTS),
  /** Log each search/fetch at info level. */
  verbose: z.boolean().default(false),
})

/**
 * Plugin config: the shared chain plus one sub-section per backend. Nested
 * objects (rather than dotted keys) keep the settings card able to write a
 * single backend's field with a path op like `['tinyfish','language']` without
 * restating the other backend's section — which is what makes concurrent edits
 * from two surfaces safe.
 */
export const Config = z.object({
  /** Ordered backend ids; earlier wins. Editable by dragging in the card. */
  priority: z.array(z.string()).default([...DEFAULT_PRIORITY]),
  /** Walk the chain on failure. Off makes the first available backend final. */
  failover: z.boolean().default(true),
  /** Claim `web.searchProvider` when the composition left it unset. */
  takeOverSearch: z.boolean().default(true),
  /** Claim `web.fetchProvider` when the composition left it unset. */
  takeOverFetch: z.boolean().default(true),
  /** Which backend serves `web_search`; `auto` follows `priority`. */
  searchBackend: z.string().default('auto'),
  /** Which backend serves `web_fetch`; `auto` follows `priority`. */
  fetchBackend: z.string().default('auto'),
  tinyfish: TinyfishConfig.default({}),
  anysearch: AnysearchConfig.default({}),
})

/** Reject a non-absolute endpoint before it is ever handed an API key. */
function assertEndpoint(label, value) {
  if (!URL.canParse(value)) {
    throw new Error(`${name}: ${label} must be an absolute URL (got ${JSON.stringify(value)})`)
  }
}

/**
 * Normalize the priority list: drop ids that are not backends, drop duplicates,
 * then append any backend the list omitted. Running this at every read (not only
 * at write) means a hand-edited or stale `settings.yaml` cannot strand a backend
 * that exists, and the card always renders a complete, draggable list.
 *
 * @param priority - the configured list.
 * @returns a list containing exactly {@link DEFAULT_PRIORITY}'s members, ordered.
 */
export function normalizePriority(priority) {
  const known = new Set(DEFAULT_PRIORITY)
  const seen = new Set()
  const out = []
  for (const id of Array.isArray(priority) ? priority : []) {
    if (typeof id !== 'string' || !known.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  for (const id of DEFAULT_PRIORITY) if (!seen.has(id)) out.push(id)
  return out
}

/**
 * Validate a resolved config section. Runs inside the settings write path, so a
 * bad endpoint or a malformed `params` blob is refused at the card instead of
 * silently disabling a backend until restart.
 *
 * Defensive about its input on purpose. The settings service always hands this a
 * schema-resolved section, but the same function is also reachable through other
 * call paths, and a `TypeError` here would be catastrophic rather than
 * cosmetic: it escapes `apply()`, which fails the plugin's fiber and makes
 * Cordis roll back EVERY effect-scoped registration — including the three
 * provider registrations. The observable result would be the seam naming a
 * provider that nothing registered, with no hint about the real cause.
 *
 * Absent or partial sub-sections are therefore skipped, not dereferenced. A
 * genuinely malformed VALUE still throws, because that is what the write path
 * needs.
 *
 * Exported so the verification suite can assert the rejection table directly.
 *
 * @param cfg - a resolved, or at least partial, config section.
 * @throws {Error} when a present field cannot be acted on.
 */
export function validateConfig(cfg) {
  if (cfg === null || typeof cfg !== 'object') {
    throw new Error(`${name}: config must be an object (got ${cfg === null ? 'null' : typeof cfg})`)
  }
  const tinyfish = cfg.tinyfish ?? {}
  const anysearch = cfg.anysearch ?? {}
  // Fall back to the schema default when a sub-section is missing, so the
  // endpoint checks below validate what will actually be used.
  const searchBaseURL = tinyfish.searchBaseURL ?? TinyfishConfig({}).searchBaseURL
  const fetchBaseURL = tinyfish.fetchBaseURL ?? TinyfishConfig({}).fetchBaseURL
  assertEndpoint('tinyfish.searchBaseURL', searchBaseURL)
  assertEndpoint('tinyfish.fetchBaseURL', fetchBaseURL)
  const tag = String(anysearch.tag ?? '').trim()
  const params = String(anysearch.params ?? '').trim()
  if (params.length > 0) {
    let parsed
    try {
      parsed = JSON.parse(params)
    } catch {
      throw new Error(`${name}: anysearch.params must be a JSON object (got ${JSON.stringify(params)})`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${name}: anysearch.params must be a JSON object, not ${Array.isArray(parsed) ? 'an array' : typeof parsed}`)
    }
    if (tag.length === 0) {
      throw new Error(`${name}: anysearch.params requires anysearch.tag (vertical parameters are meaningless without a sub-domain)`)
    }
  }
  if (tag.length > 0 && !/^[a-z_]+(\.[a-z_]+)+$/i.test(tag)) {
    throw new Error(`${name}: anysearch.tag must look like "domain.sub_domain" (got ${JSON.stringify(tag)})`)
  }
  const maxResults = anysearch.maxResults ?? AnysearchConfig({}).maxResults
  if (maxResults < ANYSEARCH_MIN_RESULTS || maxResults > ANYSEARCH_MAX_RESULTS) {
    throw new Error(`${name}: anysearch.maxResults must be between ${ANYSEARCH_MIN_RESULTS} and ${ANYSEARCH_MAX_RESULTS}`)
  }
  const maxPages = tinyfish.maxPages ?? TinyfishConfig({}).maxPages
  if (maxPages < 1 || maxPages > TINYFISH_SERVICE_MAX_PAGE) {
    throw new Error(`${name}: tinyfish.maxPages must be between 1 and ${TINYFISH_SERVICE_MAX_PAGE}`)
  }
  const fetchFormat = tinyfish.fetchFormat ?? TinyfishConfig({}).fetchFormat
  if (!TINYFISH_FETCH_FORMATS.includes(fetchFormat)) {
    throw new Error(`${name}: tinyfish.fetchFormat must be one of ${TINYFISH_FETCH_FORMATS.join(', ')}`)
  }
  // `0` is the documented "omit the field" sentinel for the per-URL timeout, so
  // the accepted set is `0` plus the service's own 1–110000 window. Anything
  // else is refused at the card rather than sent and rejected by the service.
  const fetchPerUrlTimeoutMs = tinyfish.fetchPerUrlTimeoutMs ?? TinyfishConfig({}).fetchPerUrlTimeoutMs
  if (fetchPerUrlTimeoutMs !== 0
    && (fetchPerUrlTimeoutMs < TINYFISH_MIN_FETCH_TIMEOUT_MS || fetchPerUrlTimeoutMs > TINYFISH_MAX_FETCH_TIMEOUT_MS)) {
    throw new Error(`${name}: tinyfish.fetchPerUrlTimeoutMs must be 0 (omit) or between ${TINYFISH_MIN_FETCH_TIMEOUT_MS} and ${TINYFISH_MAX_FETCH_TIMEOUT_MS}`)
  }
  // Tri-state: -1 omits `ttl`, 0 forces a live fetch, and a positive value is a
  // cache age in seconds. A negative value below -1 has no meaning.
  const fetchTtlSeconds = tinyfish.fetchTtlSeconds ?? TinyfishConfig({}).fetchTtlSeconds
  if (fetchTtlSeconds < -1) {
    throw new Error(`${name}: tinyfish.fetchTtlSeconds must be -1 (omit), 0 (live), or a positive cache age in seconds`)
  }
  for (const [label, value] of [['afterDate', tinyfish.afterDate], ['beforeDate', tinyfish.beforeDate]]) {
    const trimmed = String(value ?? '').trim()
    if (trimmed.length > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      throw new Error(`${name}: tinyfish.${label} must be YYYY-MM-DD (got ${JSON.stringify(trimmed)})`)
    }
  }
}

/** Split a comma-separated domain list into trimmed, non-empty entries. */
function splitDomains(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/** Parse the AnySearch `params` JSON blob, or `undefined` when blank. */
function parseParams(value) {
  const trimmed = String(value ?? '').trim()
  if (trimmed.length === 0) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Map a transport error into the seam's `WebError`. Cancellation becomes
 * `WEB_ABORTED` — it is control flow, and the chain must not treat it as a
 * failover trigger.
 *
 * @param error - the caught value.
 * @param backend - backend id for the message.
 * @param what - operation label (`search`/`fetch`).
 * @returns the `WebError` to throw.
 */
function toWebError(error, backend, what) {
  const aborted = (error instanceof TinyFishError && error.code === 'TINYFISH_ABORTED')
    || (error !== null && typeof error === 'object' && error.code === 'ANYSEARCH_ABORTED')
  if (aborted) return new WebError(`${backend} ${what} aborted`, 'WEB_ABORTED', { cause: error })
  const message = error instanceof Error ? error.message : String(error)
  return new WebError(message, 'WEB_PROVIDER_ERROR', { cause: error })
}

/** True when an error is a cancellation rather than a backend fault. */
function isAbortError(error) {
  return error instanceof WebError && error.code === 'WEB_ABORTED'
}

/**
 * Per-context key store: the ONE place this plugin reads an API key from, so
 * read, write, and clear all address the same store.
 *
 * WHY A CACHE EXISTS AT ALL
 * -------------------------
 * The seam's `available()` is SYNCHRONOUS (`dsh-web` calls it inline at provider
 * selection), while credential resolution is asynchronous. A backend whose
 * availability depends on a key therefore cannot resolve on demand inside
 * `available()`. This store keeps a synchronous snapshot for that one purpose
 * and refreshes it from three triggers:
 *
 *   1. eagerly, when the store is first built;
 *   2. on every `credentials/updated` event the credentials service fans out,
 *      which covers a write from this card, another surface, or an external
 *      edit the provider hot-reloads;
 *   3. as a side effect of every `resolve()`, so a request never acts on a
 *      snapshot older than itself.
 *
 * `resolve()` itself is always authoritative and per-operation — the snapshot is
 * a read-through cache for `available()`, never the value a request is sent
 * with, so a stale snapshot can only affect whether a backend is *offered*, not
 * which key reaches the wire.
 */
export class CredentialKeyStore {
  /**
   * @param ctx - plugin context exposing the `credentials` service.
   */
  constructor(ctx) {
    this.ctx = ctx
    /** ref → resolved non-empty value; an absent entry means "no key". */
    this.values = new Map()
    /** Refs already described, for the card's source/writability reporting. */
    this.info = new Map()
    /** Set once a refresh has completed at least once. */
    this.hydrated = false
    this.inFlight = null
  }

  /** The credentials service, or `undefined` while it is not mounted. */
  credentials() {
    try {
      return this.ctx.get('credentials')
    } catch {
      return undefined
    }
  }

  /** Every credential reference this plugin owns. */
  static refs() {
    return [TINYFISH_API_KEY_REF, ANYSEARCH_API_KEY_REF]
  }

  /**
   * Read one reference straight from the credential center and update the
   * snapshot with what came back.
   *
   * @param ref - the credential reference to resolve.
   * @returns the key, or `''` when the credential center holds none.
   */
  async resolve(ref) {
    const credentials = this.credentials()
    if (credentials === undefined) {
      this.values.delete(ref)
      return ''
    }
    let value = ''
    try {
      const resolved = await credentials.resolve(ref)
      if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0) {
        value = resolved.value
      }
    } catch {
      // A provider that cannot answer means "no key" for this call. The card
      // reports the real error through its own describe path.
      value = ''
    }
    if (value.length > 0) this.values.set(ref, value)
    else this.values.delete(ref)
    return value
  }

  /**
   * Refresh the snapshot (and the card-facing info) for every owned reference.
   *
   * Concurrent callers share one pass: the credentials seam is a file read per
   * ref, and a burst of events must not fan out into a burst of reads.
   *
   * @returns a promise settling when the snapshot is current.
   */
  async refresh() {
    if (this.inFlight !== null) return await this.inFlight
    this.inFlight = (async () => {
      const credentials = this.credentials()
      for (const ref of CredentialKeyStore.refs()) {
        if (credentials === undefined) {
          this.values.delete(ref)
          this.info.delete(ref)
          continue
        }
        await this.resolve(ref)
        try {
          const described = await credentials.describe(ref)
          this.info.set(ref, {
            configured: described?.configured === true,
            writable: described?.writable === true,
            ...described?.source === undefined ? {} : { source: described.source },
          })
        } catch {
          this.info.delete(ref)
        }
      }
      this.hydrated = true
    })()
    try {
      await this.inFlight
    } finally {
      this.inFlight = null
    }
  }

  /**
   * The snapshot value for one reference. Synchronous, for `available()`.
   *
   * @param ref - the credential reference to read.
   * @returns the cached key, or `''`.
   */
  get(ref) {
    return this.values.get(ref) ?? ''
  }

  /**
   * Refresh only when the snapshot has never been hydrated.
   *
   * `available()` is synchronous, so on a cold start it can be asked before the
   * first async read finishes — which would report a real key as absent and make
   * the chain skip a backend that works. The provider awaits this once before
   * walking the chain, so the skip/fail distinction stays honest without making
   * `available()` async.
   *
   * @returns a promise settling when the snapshot is at least once-current.
   */
  async ensureHydrated() {
    if (this.hydrated) return
    await this.refresh()
  }

  /**
   * Pre-load the snapshot without touching the credentials service.
   *
   * Exists for callers that already hold the key and cannot await — chiefly the
   * verification suite, which drives `available()` (synchronous by seam
   * contract) against a double. Production always goes through the credential
   * center via {@link CredentialKeyStore.refresh}.
   *
   * @param entries - ref → key; a blank value clears the entry.
   */
  prime(entries) {
    for (const [ref, value] of Object.entries(entries ?? {})) {
      if (typeof value === 'string' && value.length > 0) this.values.set(ref, value)
      else this.values.delete(ref)
    }
    this.hydrated = true
  }

  /** The last described state for one reference, or `undefined`. */
  describe(ref) {
    return this.info.get(ref)
  }
}

/**
 * One store per context, shared by both backends so a refresh serves both.
 * Keyed by the context itself, so the two `BackendRuntime` instances the
 * provider builds per call agree on one snapshot.
 */
const KEY_STORES = new WeakMap()

/**
 * The key store for a context, created on first use.
 *
 * @param ctx - plugin context, or a test double.
 * @returns the shared store, or `null` when there is no usable context.
 */
export function keyStoreFor(ctx) {
  if (ctx === null || ctx === undefined || typeof ctx !== 'object') return null
  let store = KEY_STORES.get(ctx)
  if (store === undefined) {
    store = new CredentialKeyStore(ctx)
    KEY_STORES.set(ctx, store)
    // Hydrate immediately so `available()` is accurate before the first search.
    void store.refresh().catch(() => {})
  }
  return store
}

/**
 * A resolved, callable backend. Building these per call (not once at mount) is
 * what makes a settings change take effect on the next search without a restart.
 *
 * Exported so the verification suite can drive the failover chain without
 * standing up a full Cordis context.
 */
export class BackendRuntime {
  /**
   * @param id - backend id.
   * @param ctx - plugin context, for credential-center reads.
   * @param getConfig - thunk returning the live config section.
   * @param logger - Cordis logger for verbose diagnostics.
   */
  constructor(id, ctx, getConfig, logger) {
    this.id = id
    this.ctx = ctx
    this.getConfig = getConfig
    this.logger = logger
  }

  /** This backend's sub-section of the live config. */
  config() {
    return this.id === TINYFISH_ID ? this.getConfig().tinyfish : this.getConfig().anysearch
  }

  /** The credential reference this backend's key lives under. */
  ref() {
    return this.id === TINYFISH_ID ? TINYFISH_API_KEY_REF : ANYSEARCH_API_KEY_REF
  }

  /**
   * Resolve the effective key for one operation, per call and never cached
   * across operations, so a key written from the settings card reaches the next
   * request without a restart.
   *
   * The credential center is the ONLY source. There is deliberately no
   * environment, config-file, or CLI-config fallback: a second silent source is
   * what let the card report a key it could neither replace nor clear.
   *
   * @returns the resolved key; `''` means anonymous (AnySearch) or unavailable.
   */
  async key() {
    const store = keyStoreFor(this.ctx)
    if (store === null) return ''
    return await store.resolve(this.ref())
  }

  /**
   * Whether this backend can run. Cheap and network-free, per the seam's
   * `available()` contract — so it reads the store's snapshot rather than
   * awaiting a resolution.
   *
   * AnySearch stays available without a key (anonymous tier). TinyFish does not,
   * because every TinyFish endpoint requires one.
   *
   * @returns whether the backend is enabled and has what it needs locally.
   */
  available() {
    const cfg = this.config()
    if (cfg.enabled !== true) return false
    if (this.id === TINYFISH_ID) {
      if (!URL.canParse(cfg.searchBaseURL) || !URL.canParse(cfg.fetchBaseURL)) return false
      const store = keyStoreFor(this.ctx)
      return store !== null && store.get(this.ref()).length > 0
    }
    // AnySearch: a malformed base URL is the only local disqualifier. A missing
    // key is legal (anonymous tier), so it does not hide the backend.
    if (cfg.baseURL.trim().length > 0 && !URL.canParse(resolveAnysearchBase(cfg.baseURL))) return false
    return URL.canParse(resolveAnysearchBase(cfg.baseURL))
  }

  /**
   * Run one search on this backend.
   *
   * @param request - the seam's search request.
   * @param signal - cancellation signal.
   * @returns the normalized result plus this backend's self-description.
   * @throws {WebError} on abort or backend failure.
   */
  async search(request, signal) {
    const cfg = this.config()
    const apiKey = await this.key()
    const startedAt = Date.now()
    try {
      if (this.id === TINYFISH_ID) {
        const { sources, totalResults } = await searchTinyfish({
          query: request.query,
          ...request.maxResults !== undefined ? { maxResults: request.maxResults } : {},
          maxPages: cfg.maxPages,
          ...cfg.purpose.trim().length > 0 ? { purpose: cfg.purpose.trim() } : {},
          ...cfg.language.trim().length > 0 ? { language: cfg.language.trim() } : {},
          ...cfg.location.trim().length > 0 ? { location: cfg.location.trim() } : {},
          ...TINYFISH_DOMAIN_TYPES.includes(cfg.domainType) ? { domainType: cfg.domainType } : {},
          ...cfg.afterDate.trim().length > 0 ? { afterDate: cfg.afterDate.trim() } : {},
          ...cfg.beforeDate.trim().length > 0 ? { beforeDate: cfg.beforeDate.trim() } : {},
          ...cfg.recencyMinutes > 0 ? { recencyMinutes: cfg.recencyMinutes } : {},
          ...cfg.pubYearMin > 0 ? { pubYearMin: cfg.pubYearMin } : {},
          ...cfg.pubYearMax > 0 ? { pubYearMax: cfg.pubYearMax } : {},
          includeDomains: splitDomains(cfg.includeDomains),
          excludeDomains: splitDomains(cfg.excludeDomains),
        }, apiKey, signal, { baseURL: cfg.searchBaseURL })
        if (cfg.verbose) {
          this.logger?.info?.(`hydrasearch: tinyfish search "${request.query}" → ${sources.length}/${totalResults} in ${Date.now() - startedAt}ms`)
        }
        return { sources, totalResults, latencyMs: Date.now() - startedAt }
      }

      const { sources, totalResults, searchTimeMs } = await searchAnysearch({
        query: request.query,
        ...request.maxResults !== undefined ? { maxResults: request.maxResults } : {},
        maxResults: cfg.maxResults,
        ...cfg.tag.trim().length > 0 ? { tag: cfg.tag.trim() } : {},
        ...parseParams(cfg.params) !== undefined ? { params: parseParams(cfg.params) } : {},
        ...cfg.zone.trim().length > 0 ? { zone: cfg.zone.trim() } : {},
        ...cfg.language.trim().length > 0 ? { language: cfg.language.trim() } : {},
      }, apiKey, signal, { baseURL: resolveAnysearchBase(cfg.baseURL) })
      if (cfg.verbose) {
        this.logger?.info?.(
          `hydrasearch: anysearch search "${request.query}" → ${sources.length}/${totalResults} in ${Date.now() - startedAt}ms`,
        )
      }
      return { sources, totalResults, latencyMs: searchTimeMs ?? Date.now() - startedAt }
    } catch (error) {
      throw toWebError(error, this.id, 'search')
    }
  }

  /**
   * Retrieve one URL on this backend.
   *
   * @param request - the seam's fetch request.
   * @param signal - cancellation signal.
   * @returns the seam's fetch result shape.
   * @throws {WebError} on abort or backend failure.
   */
  async fetch(request, signal) {
    const cfg = this.config()
    const apiKey = await this.key()
    const startedAt = Date.now()
    try {
      if (this.id === TINYFISH_ID) {
        const result = await fetchTinyfish(request.url, apiKey, signal, { baseURL: cfg.fetchBaseURL }, {
          format: cfg.fetchFormat,
          links: cfg.fetchLinks,
          imageLinks: cfg.fetchImageLinks,
          ...cfg.purpose.trim().length > 0 ? { purpose: cfg.purpose.trim() } : {},
          // 0 means "omitted" at the config layer, and the transport only sends a
          // positive integer — so a disabled timeout never reaches the wire.
          ...cfg.fetchPerUrlTimeoutMs > 0 ? { perUrlTimeoutMs: cfg.fetchPerUrlTimeoutMs } : {},
          // Tri-state: -1 omits `ttl`, 0 forces a live fetch, N accepts a cache
          // entry younger than N seconds. Passing the sentinel through unchanged
          // is what keeps "any cache" distinct from "force live".
          ...cfg.fetchTtlSeconds >= 0 ? { ttl: cfg.fetchTtlSeconds } : {},
        })
        if (cfg.verbose) {
          this.logger?.info?.(`hydrasearch: tinyfish fetch ${request.url} → ${result.text.length} chars in ${Date.now() - startedAt}ms`)
        }
        return result
      }
      const result = await fetchAnysearch(request.url, apiKey, signal, { baseURL: resolveAnysearchBase(cfg.baseURL) })
      if (cfg.verbose) {
        this.logger?.info?.(`hydrasearch: anysearch fetch ${request.url} → ${result.text.length} chars in ${Date.now() - startedAt}ms`)
      }
      return result
    } catch (error) {
      throw toWebError(error, this.id, 'fetch')
    }
  }
}

/** Note appended to a result when the chain had to move past earlier backends. */
function failoverNote(servedBy, attempts) {
  const skipped = attempts.filter((attempt) => attempt.outcome === 'skipped').map((attempt) => attempt.backend)
  const failed = attempts.filter((attempt) => attempt.outcome === 'failed')
  const parts = []
  if (failed.length > 0) {
    parts.push(`Note: ${failed.map((attempt) => `${attempt.backend} failed (${attempt.reason})`).join('; ')}, using ${servedBy}.`)
  }
  if (skipped.length > 0) {
    parts.push(`(${skipped.join(', ')} ${skipped.length === 1 ? 'was' : 'were'} not available — no key or disabled in the hydrasearch settings; they were NOT tried.)`)
  }
  return parts.join(' ')
}

/**
 * The failover-chain search provider.
 *
 * The chain is rebuilt per call from the live config, so a reordered priority
 * list, a newly saved key, or a disabled backend all take effect immediately.
 */
export class HydraSearchProvider {
  /**
   * @param ctx - plugin context.
   * @param getConfig - thunk returning the live config section.
   * @param logger - Cordis logger.
   * @param backendFor - factory returning a {@link BackendRuntime} for an id.
   */
  constructor(ctx, getConfig, logger, backendFor) {
    this.id = HYDRASEARCH_PROVIDER_ID
    this.ctx = ctx
    this.getConfig = getConfig
    this.logger = logger
    this.backendFor = backendFor
  }

  /**
   * Whether any backend in the chain can run. Network-free, per the seam.
   *
   * @returns whether at least one backend is locally usable.
   */
  available() {
    return this.chain().some((backend) => backend.available())
  }

  /**
   * The shared key store for this provider's context, or `null`.
   *
   * @returns the store backing both backends' `available()` snapshots.
   */
  keyStore() {
    return keyStoreFor(this.ctx)
  }

  /** The backend order the chain will walk, from the live priority list. */
  chain() {
    return normalizePriority(this.getConfig().priority).map((id) => this.backendFor(id))
  }

  /**
   * The candidate backends for one operation: either a single pinned backend, or
   * the full chain.
   *
   * Pinning lives here rather than in the provider registry so that the plugin
   * registers exactly one provider. `auto`, an unknown id, and a malformed value
   * all mean "walk the chain" — a typo in the card degrades to the chain's
   * normal behaviour instead of making the capability unreachable.
   *
   * @param selector - the `searchBackend` / `fetchBackend` config value.
   * @returns a one-element list when pinned, otherwise the whole chain.
   */
  pinnedOrChain(selector) {
    if (selector !== 'auto' && DEFAULT_PRIORITY.includes(selector)) {
      return [this.backendFor(selector)]
    }
    return this.chain()
  }

  /**
   * Search, walking the chain in priority order.
   *
   * @param request - the seam's search request.
   * @param signal - cancellation signal.
   * @returns the first successful backend's result, with a failover note when
   *   earlier backends were skipped or failed.
   * @throws {WebError} `WEB_ABORTED` on cancellation; `WEB_PROVIDER_ERROR` when
   *   every backend failed.
   */
  async search(request, signal) {
    const cfg = this.getConfig()
    // The chain's skip/fail decision reads `available()`, which is synchronous
    // by seam contract. On a cold start the credential snapshot may not have
    // hydrated yet, which would report a working key as absent — so settle it
    // once before deciding.
    await (this.keyStore()?.ensureHydrated() ?? Promise.resolve())
    const attempts = []
    let firstFailure = null

    for (const backend of this.pinnedOrChain(cfg.searchBackend)) {
      if (!backend.available()) {
        attempts.push({ backend: backend.id, outcome: 'skipped', reason: 'unavailable' })
        continue
      }
      try {
        const result = await backend.search(request, signal)
        const note = attempts.length > 0 ? failoverNote(backend.id, attempts) : ''
        return {
          sources: result.sources,
          // TinyFish generates no answer text and AnySearch returns none either,
          // so `content` is omitted rather than emptied: the tool distinguishes
          // absent from empty when deciding whether to print "No results found.".
          truncated: false,
          ...note.length > 0 ? { content: note } : {},
        }
      } catch (error) {
        // A cancelled request stops the chain: retrying elsewhere would ignore
        // what the user asked for.
        if (isAbortError(error)) throw error
        firstFailure = firstFailure ?? error
        attempts.push({
          backend: backend.id,
          outcome: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        })
        if (cfg.failover !== true) break
      }
    }

    if (firstFailure !== null) throw firstFailure
    throw new WebError(
      `no usable backend for search: ${attempts.map((attempt) => `${attempt.backend} (${attempt.reason})`).join(', ')}`,
      'WEB_PROVIDER_UNAVAILABLE',
    )
  }

  /**
   * Retrieve one URL. `fetchBackend` pins a backend; `auto` follows `priority`.
   *
   * @param request - the seam's fetch request.
   * @param signal - cancellation signal.
   * @returns the first successful backend's result, in the seam's shape.
   * @throws {WebError} `WEB_ABORTED` on cancellation; `WEB_PROVIDER_ERROR` when
   *   every candidate failed.
   */
  async fetch(request, signal) {
    const cfg = this.getConfig()
    // Same cold-start rule as `search()`: settle the snapshot before the
    // synchronous availability test decides whether to skip a backend.
    await (this.keyStore()?.ensureHydrated() ?? Promise.resolve())
    const pinned = this.pinnedOrChain(cfg.fetchBackend)
    const attempts = []
    let firstFailure = null

    for (const backend of pinned) {
      if (!backend.available()) {
        attempts.push({ backend: backend.id, outcome: 'skipped', reason: 'unavailable' })
        continue
      }
      try {
        // The backend speaks the plugin's internal shape; the seam requires its
        // own. `WebFetchResult` carries no answer-text field, so the failover
        // note goes into the body instead of being dropped.
        const result = await backend.fetch(request, signal)
        const note = attempts.length > 0 ? failoverNote(backend.id, attempts) : ''
        const projected = toFetchResult(result)
        if (note.length === 0) return projected
        return { ...projected, body: { kind: 'text', content: `${note}\n\n${projected.body.content}` } }
      } catch (error) {
        if (isAbortError(error)) throw error
        firstFailure = firstFailure ?? error
        attempts.push({
          backend: backend.id,
          outcome: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        })
        if (cfg.failover !== true) break
      }
    }

    if (firstFailure !== null) throw firstFailure
    throw new WebError(
      `no usable backend for fetch: ${attempts.map((attempt) => `${attempt.backend} (${attempt.reason})`).join(', ')}`,
      'WEB_PROVIDER_UNAVAILABLE',
    )
  }
}

/**
 * Project an internal backend fetch result into the seam's `WebFetchResult`.
 *
 * Both backends return extracted markdown/text, not raw HTML, and neither
 * reports the origin's HTTP status. Declaring the body as `text` makes
 * `web_fetch` pass it through verbatim — declaring `html` would send
 * already-converted markdown through turndown a second time. `statusCode` is
 * `200` for a successful extraction; a retrieval the service could not perform
 * is raised as an error by the backend, never reported as a status code here.
 *
 * @param result - the backend's `{ finalUrl, text }`.
 * @returns the seam's fetch result shape.
 */
function toFetchResult(result) {
  return {
    url: result.finalUrl,
    statusCode: 200,
    body: { kind: 'text', content: result.text },
    truncated: false,
  }
}

/** Reply with one JSON document, never cached and never referrer-leaking. */
function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * Read a bounded JSON request body.
 *
 * @param req - the incoming request.
 * @returns the parsed body, or `undefined` for an oversized or malformed body.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * Whether a request may touch the settings bridge. The bridge writes settings,
 * reads credential state, and can probe the operator's backends with a live
 * search, so it is restricted to loopback with a matching `Host`/`Origin` and a
 * POST method — a malicious page in the same browser is the threat this blocks.
 *
 * @param request - the incoming request.
 * @returns whether the request is an acceptable same-origin loopback POST.
 */
export function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Project a settings descriptor into the shape the browser half consumes. */
function toView(descriptor) {
  return {
    ns: String(descriptor.ns),
    schema: descriptor.schema,
    value: descriptor.value,
    ...descriptor.base === undefined ? {} : { base: descriptor.base },
    ...descriptor.user === undefined ? {} : { user: descriptor.user },
    ...descriptor.secrets === undefined
      ? {}
      : { secrets: descriptor.secrets.map((secret) => ({ path: [...secret.path], set: secret.set })) },
    revision: descriptor.revision,
  }
}

/**
 * Build the bridge routes the settings card calls. Every route is a POST,
 * loopback-guarded, and answers `{ ok, value }` or `{ ok: false, code, message }`
 * so the card never has to interpret HTTP status codes.
 *
 * @param deps - the settings service, credential accessors, live config, and probes.
 * @returns the route list for `webServer.register`.
 */
export function makeBridgeRoutes(deps) {
  const { settings, getCredentials, getConfig, probeSearch, probeBackend, subDomains, adoptKey, refreshKeys } = deps

  const exposed = () => {
    const descriptor = settings.describe({ redactSecrets: true })
      .find((entry) => String(entry.ns) === HYDRASEARCH_NS)
    return descriptor === undefined ? undefined : toView(descriptor)
  }

  const guard = (req, res) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden', message: 'loopback requests only' })
      return false
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: `method not allowed: ${req.method ?? ''}` })
      return false
    }
    return true
  }

  /**
   * Credential status for one reference, read from the credential center — the
   * single store this plugin reads, writes, and clears.
   *
   * `source` names the layer inside the credential center that supplied the
   * value (`file` for its managed document, `env`/`project-env`/`user-env` for a
   * read-only layer layered over it). It is reported so the card can say WHY a
   * key is present and whether it can be replaced, instead of implying the
   * managed store holds something it does not.
   */
  const keyStatus = async (ref, envVar) => {
    const credentials = getCredentials()
    let configured = false
    let writable = false
    let source
    if (credentials !== undefined) {
      try {
        const info = await credentials.describe(ref)
        configured = info?.configured === true
        writable = info?.writable === true
        if (typeof info?.source === 'string') source = info.source
      } catch {
        // An unreadable store reports "not configured"; the save path surfaces
        // the real error.
      }
    }
    return {
      ref,
      envVar,
      configured,
      writable,
      available: credentials !== undefined,
      ...source === undefined ? {} : { source },
    }
  }

  const routes = [
    {
      path: `${BRIDGE_PREFIX}/describe`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const view = exposed()
        if (view === undefined) {
          writeJson(res, 200, { ok: false, code: 'settings-unavailable', message: `namespace "${HYDRASEARCH_NS}" is not registered` })
          return
        }
        const cfg = getConfig()
        writeJson(res, 200, {
          ok: true,
          value: {
            namespaces: [view],
            writable: settings.writable !== false,
            version: PLUGIN_VERSION,
            chain: {
              providerId: HYDRASEARCH_PROVIDER_ID,
              priority: normalizePriority(cfg.priority),
              backends: [...DEFAULT_PRIORITY],
              failover: cfg.failover,
              searchBackend: cfg.searchBackend,
              fetchBackend: cfg.fetchBackend,
            },
            credentials: {
              tinyfish: await keyStatus(TINYFISH_API_KEY_REF, TINYFISH_API_KEY_ENV),
              anysearch: await keyStatus(ANYSEARCH_API_KEY_REF, ANYSEARCH_API_KEY_ENV),
            },
            env: {
              tinyfish: {
                envVar: TINYFISH_API_KEY_ENV,
                hasEnvKey: Boolean(process.env[TINYFISH_API_KEY_ENV]),
              },
              anysearch: {
                envVar: ANYSEARCH_API_KEY_ENV,
                hasEnvKey: Boolean(process.env[ANYSEARCH_API_KEY_ENV]),
                anonymousAllowed: true,
              },
            },
            limits: {
              tinyfish: {
                pageSize: TINYFISH_PAGE_SIZE,
                defaultMaxPages: TINYFISH_MAX_PAGES,
                maxPages: TINYFISH_SERVICE_MAX_PAGE,
                domainTypes: [...TINYFISH_DOMAIN_TYPES],
                fetchFormats: [...TINYFISH_FETCH_FORMATS],
              },
              anysearch: {
                minResults: ANYSEARCH_MIN_RESULTS,
                maxResults: ANYSEARCH_MAX_RESULTS,
              },
            },
          },
        })
      },
    },
    {
      path: `${BRIDGE_PREFIX}/mutate`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const body = await readJsonBody(req)
        if (body === null || typeof body !== 'object' || body.ns !== HYDRASEARCH_NS || !Array.isArray(body.ops)) {
          writeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'malformed bridge settings request' })
          return
        }
        try {
          await settings.mutate(
            settingsNamespace(HYDRASEARCH_NS),
            body.ops,
            typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined,
          )
        } catch (error) {
          const code = error?.code === 'SETTINGS_CONFLICT' ? 'settings-conflict' : 'settings-write-failed'
          writeJson(res, 200, { ok: false, code, message: error instanceof Error ? error.message : String(error) })
          return
        }
        const view = exposed()
        if (view === undefined) {
          writeJson(res, 200, { ok: false, code: 'settings-unavailable', message: 'namespace disposed after the write' })
          return
        }
        writeJson(res, 200, { ok: true, value: view })
      },
    },
    {
      path: `${BRIDGE_PREFIX}/key-status`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const body = await readJsonBody(req)
        const which = body?.backend
        writeJson(res, 200, {
          ok: true,
          value: {
            ...which === ANYSEARCH_ID || which === undefined
              ? { anysearch: await keyStatus(ANYSEARCH_API_KEY_REF, ANYSEARCH_API_KEY_ENV) }
              : {},
            ...which === TINYFISH_ID || which === undefined
              ? { tinyfish: await keyStatus(TINYFISH_API_KEY_REF, TINYFISH_API_KEY_ENV) }
              : {},
          },
        })
      },
    },
    {
      path: `${BRIDGE_PREFIX}/key-set`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const body = await readJsonBody(req)
        const value = typeof body?.value === 'string' ? body.value.trim() : ''
        const ref = body?.backend === ANYSEARCH_ID ? ANYSEARCH_API_KEY_REF : TINYFISH_API_KEY_REF
        if (value.length === 0) {
          writeJson(res, 400, { ok: false, code: 'credentials-rejected', message: 'value is required' })
          return
        }
        const credentials = getCredentials()
        if (credentials === undefined) {
          writeJson(res, 200, { ok: false, code: 'credentials-unavailable', message: 'credentials service is not available' })
          return
        }
        try {
          await credentials.set(ref, value)
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'credentials-write-failed', message: error instanceof Error ? error.message : String(error) })
          return
        }
        // The write is durable; refresh the availability snapshot so the change
        // is visible to the very next search without waiting for the event.
        await refreshKeys?.()
        writeJson(res, 200, { ok: true, value: { ref, set: true } })
      },
    },
    {
      path: `${BRIDGE_PREFIX}/key-unset`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const body = await readJsonBody(req)
        const ref = body?.backend === ANYSEARCH_ID ? ANYSEARCH_API_KEY_REF : TINYFISH_API_KEY_REF
        const credentials = getCredentials()
        if (credentials === undefined) {
          writeJson(res, 200, { ok: false, code: 'credentials-unavailable', message: 'credentials service is not available' })
          return
        }
        try {
          await credentials.unset(ref)
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'credentials-write-failed', message: error instanceof Error ? error.message : String(error) })
          return
        }
        await refreshKeys?.()
        // Report whether the clear actually took effect. A read-only layer can
        // still supply the reference after the managed document is emptied, and
        // saying "cleared" then would be the same lie this route exists to fix.
        const credentials2 = getCredentials()
        let stillConfigured = false
        let source
        try {
          const info = await credentials2?.describe(ref)
          stillConfigured = info?.configured === true
          if (typeof info?.source === 'string') source = info.source
        } catch {
          // Reporting only; a describe failure must not fail a durable clear.
        }
        writeJson(res, 200, {
          ok: true,
          value: {
            ref,
            set: false,
            cleared: !stillConfigured,
            ...stillConfigured && source !== undefined ? { shadowedBy: source } : {},
          },
        })
      },
    },
    {
      path: `${BRIDGE_PREFIX}/test`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const body = await readJsonBody(req)
        const query = typeof body?.query === 'string' && body.query.trim().length > 0 ? body.query.trim() : 'DeepSeek Harness'
        // An explicit backend probes exactly that one; otherwise the chain runs
        // and the answer names which backend served it.
        const backend = DEFAULT_PRIORITY.includes(body?.backend) ? body.backend : undefined
        try {
          writeJson(res, 200, { ok: true, value: await probeSearch(query, backend) })
        } catch (error) {
          writeJson(res, 200, {
            ok: false,
            code: error?.code ?? 'search-failed',
            message: error instanceof Error ? error.message : String(error),
            ...error?.autoKey !== undefined ? { autoKey: error.autoKey } : {},
          })
        }
      },
    },
    {
      path: `${BRIDGE_PREFIX}/backend-test`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const body = await readJsonBody(req)
        const backend = DEFAULT_PRIORITY.includes(body?.backend) ? body.backend : undefined
        if (backend === undefined) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: 'backend must be one of: ' + DEFAULT_PRIORITY.join(', ') })
          return
        }
        const query = typeof body?.query === 'string' && body.query.trim().length > 0 ? body.query.trim() : 'DeepSeek Harness'
        try {
          writeJson(res, 200, { ok: true, value: await probeBackend(backend, query) })
        } catch (error) {
          writeJson(res, 200, {
            ok: false,
            code: error?.code ?? 'search-failed',
            message: error instanceof Error ? error.message : String(error),
            // The auto-registration path: the request failed, but the service
            // minted a credential. Hand it to the card instead of discarding it.
            ...error?.autoKey !== undefined ? { autoKey: error.autoKey } : {},
          })
        }
      },
    },
    {
      path: `${BRIDGE_PREFIX}/sub-domains`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const body = await readJsonBody(req)
        const domains = Array.isArray(body?.domains)
          ? body.domains.filter((domain) => typeof domain === 'string' && domain.trim().length > 0).slice(0, 5)
          : []
        if (domains.length === 0) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: 'domains must be a non-empty array of strings' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, value: await subDomains(domains) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: error?.code ?? 'sub-domains-failed', message: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      path: `${BRIDGE_PREFIX}/key-adopt`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const body = await readJsonBody(req)
        const key = typeof body?.key === 'string' ? body.key.trim() : ''
        if (key.length === 0) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: 'key is required' })
          return
        }
        try {
          writeJson(res, 200, { ok: true, value: await adoptKey(key, body?.target === 'env-file' ? true : undefined) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'adopt-failed', message: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]

  return routes.map((route) => ({ kind: 'exact', path: route.path, handler: route.handler }))
}

/**
 * Mount the plugin: settings section, bridge routes, the single provider, the
 * `web` config takeover guards, and the system-prompt note.
 *
 * ORDER MATTERS. The provider registrations run FIRST, before anything that can
 * throw. A throw out of `apply` fails the plugin's fiber, and Cordis then rolls
 * back every effect-scoped registration the fiber made — so a failure in a later
 * step (a bad endpoint, a settings namespace collision, a bridge route clash)
 * would take the provider registrations with it. The seam is configured to name
 * `hydrasearch`, so that rollback produces a maximally confusing symptom: the
 * error names a provider nothing registered, and the real cause is a line
 * further down.
 *
 * Registering first means the tool keeps working even when a secondary surface
 * fails.
 *
 * @param ctx - the plugin context.
 * @param config - the composition entry config; `Config` has filled all defaults.
 */
export function apply(ctx, config) {
  // Resolve defaults defensively: the loader normally hands a schema-resolved
  // object, but `apply` must not depend on that to be usable.
  const resolved = Config(config ?? {})

  // The live config section. `installSettingsSection` swaps this thunk between
  // the composition entry and the resolved user scope, so every read below sees
  // the same authority the settings card does.
  let current = () => resolved
  /** Set once the system-prompt section is mounted; called on every config change. */
  let refreshPrompt = null

  // --- 1. The provider. Nothing may precede this. -----------------------
  //
  // EXACTLY ONE provider, for both capabilities. The two backends are an
  // implementation detail of this provider, not seam-level citizens: a second
  // registration would make an unset `web.searchProvider` ambiguous
  // (WEB_PROVIDER_AMBIGUOUS) and force the operator to name a backend just to
  // get search working.
  const backendFor = (id) => new BackendRuntime(id, ctx, () => current(), ctx.logger)

  ctx.web.registerSearchProvider(new HydraSearchProvider(ctx, () => current(), ctx.logger, backendFor))
  ctx.web.registerFetchProvider(new HydraSearchProvider(ctx, () => current(), ctx.logger, backendFor))

  // Runtime takeover guard. A profile patch that sets one provider id REPLACES
  // the whole `web` config row, silently dropping the other — the path then
  // resolves to nothing. When nothing is configured we claim the seat; an
  // explicitly configured provider is left alone.
  if (current().takeOverSearch && ctx.web.searchProviderId === undefined) {
    ctx.web.searchProviderId = HYDRASEARCH_PROVIDER_ID
    ctx.logger?.info?.(`hydrasearch: web.searchProvider was unset; taking over as "${HYDRASEARCH_PROVIDER_ID}"`)
  }
  if (current().takeOverFetch && ctx.web.fetchProviderId === undefined) {
    ctx.web.fetchProviderId = HYDRASEARCH_PROVIDER_ID
    ctx.logger?.info?.(`hydrasearch: web.fetchProvider was unset; taking over as "${HYDRASEARCH_PROVIDER_ID}"`)
  }

  // --- 2. Secondary surfaces. A failure here is reported, not fatal. ----
  try {
    validateConfig(resolved)

    installSettingsSection(ctx, settingsNamespace(HYDRASEARCH_NS), Config, resolved, {
      setSource: (source) => {
        current = source
        refreshPrompt?.()
      },
      onChange: () => {
        refreshPrompt?.()
      },
      validate: validateConfig,
    })
  } catch (error) {
    // The providers above already work with the composition config; only live
    // settings editing is degraded. Say so loudly rather than failing the fiber.
    ctx.logger?.error?.(
      `hydrasearch: settings surface unavailable, search still active on the composition config: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  ctx.inject(['webServer', 'settings'], (sctx) => {
    const getConfig = () => current()

    /** Probe one backend directly, reporting its own availability. */
    const singleProbe = async (backend, query) => {
      if (!backend.available()) {
        throw new WebError(
          `${backend.id} is not available (no key, disabled, or malformed endpoint)`,
          'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
        )
      }
      const result = await backend.search({ query, maxResults: 5 }, undefined)
      return {
        query,
        backend: backend.id,
        totalResults: result.totalResults,
        sources: result.sources,
        latencyMs: result.latencyMs,
      }
    }

    /** Probe the live chain, naming the backend that actually served the result. */
    const chainProbe = async (query) => {
      const cfg = getConfig()
      const attempts = []
      for (const id of normalizePriority(cfg.priority)) {
        const backend = backendFor(id)
        if (!backend.available()) {
          attempts.push({ backend: id, outcome: 'skipped', reason: 'unavailable' })
          continue
        }
        try {
          const result = await backend.search({ query, maxResults: 5 }, undefined)
          return {
            query,
            backend: id,
            totalResults: result.totalResults,
            sources: result.sources,
            latencyMs: result.latencyMs,
            attempts,
            note: attempts.length === 0 ? '' : failoverNote(id, attempts),
          }
        } catch (error) {
          if (error instanceof WebError && error.code === 'WEB_ABORTED') throw error
          attempts.push({ backend: id, outcome: 'failed', reason: error instanceof Error ? error.message : String(error) })
        }
      }
      throw new WebError(
        `every backend failed: ${attempts.map((attempt) => `${attempt.backend} (${attempt.reason})`).join(', ')}`,
        'WEB_PROVIDER_ERROR',
      )
    }

    sctx.effect(() => {
      const store = keyStoreFor(ctx)
      const disposers = makeBridgeRoutes({
        settings: sctx.settings,
        getCredentials: () => sctx.get('credentials'),
        getConfig,
        // Re-read the key store after a durable credential write, so the new
        // state is live for the next search and the next `describe`.
        async refreshKeys() {
          await store?.refresh()
        },
        // An explicit backend probes exactly that one; otherwise the chain runs
        // and the answer names which backend served it.
        async probeSearch(query, backend) {
          return backend === undefined ? await chainProbe(query) : await singleProbe(backendFor(backend), query)
        },
        async probeBackend(backend, query) {
          return await singleProbe(backendFor(backend), query)
        },
        async subDomains(domains) {
          const cfg = getConfig()
          const key = await backendFor(ANYSEARCH_ID).key()
          return subDomainsAnysearch(domains, key, undefined, { baseURL: resolveAnysearchBase(cfg.anysearch.baseURL) })
        },
        async adoptKey(key) {
          // One home only: the credential center. There is deliberately no
          // `.env` fallback — a second store the card does not read is exactly
          // how a key became unreachable from the UI.
          const credentials = sctx.get('credentials')
          if (credentials === undefined) {
            throw new Error('the credentials service is not available; the key cannot be stored')
          }
          await credentials.set(ANYSEARCH_API_KEY_REF, key)
          await store?.refresh()
          return { stored: 'credential-center', ref: ANYSEARCH_API_KEY_REF }
        },
      }).map((route) => sctx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'hydrasearch: settings bridge')
  })

  // Keep the availability snapshot current whenever ANY surface changes a
  // credential: this card, another settings page, or an external edit the
  // credentials provider hot-reloads. Without this the synchronous `available()`
  // would keep reporting a cleared key until the next request resolved it.
  ctx.inject(['credentials'], (sctx) => {
    const store = keyStoreFor(ctx)
    sctx.effect(() => {
      void store?.refresh().catch(() => {})
      const listener = (ref) => {
        if (ref === undefined || CredentialKeyStore.refs().includes(ref)) {
          void store?.refresh().catch(() => {})
        }
      }
      sctx.on('credentials/updated', listener)
      return () => {
        // Cordis disposes `on` listeners with the fiber; nothing manual to undo.
      }
    }, 'hydrasearch: credential availability snapshot')
  })

  // Tell the model which backends are in play, in which order, and with what
  // scoping. Regenerated on every settings change, so it can never describe a
  // configuration that is no longer in force.
  ctx.inject(['systemPrompt'], (sctx) => {
    let disposeSection = null
    refreshPrompt = () => {
      if (disposeSection !== null) {
        disposeSection()
        disposeSection = null
      }
      const cfg = current()
      const order = normalizePriority(cfg.priority)
      const parts = [
        '## Web search backend (hydrasearch plugin)',
        '',
        `The web_search and web_fetch tools are served by a failover chain over: ${order.join(' → ')}.`,
        cfg.failover
          ? 'If a backend fails, the next one in that order is tried automatically, and the result names the backend that answered plus why the earlier ones did not.'
          : 'Failover is DISABLED: only the first available backend in that order is used, and its failure is final.',
      ]
      if (cfg.searchBackend !== 'auto') parts.push(`web_search always uses the "${cfg.searchBackend}" backend.`)
      if (cfg.fetchBackend !== 'auto') parts.push(`web_fetch always uses the "${cfg.fetchBackend}" backend.`)

      const notes = []
      const tf = cfg.tinyfish
      const tfScoping = []
      if (tf.language.trim().length > 0) tfScoping.push(`language=${tf.language.trim()}`)
      if (tf.location.trim().length > 0) tfScoping.push(`location=${tf.location.trim()}`)
      if (TINYFISH_DOMAIN_TYPES.includes(tf.domainType)) tfScoping.push(`domainType=${tf.domainType}`)
      if (tf.includeDomains.trim().length > 0) tfScoping.push(`includeDomains=${tf.includeDomains.trim()}`)
      if (tf.excludeDomains.trim().length > 0) tfScoping.push(`excludeDomains=${tf.excludeDomains.trim()}`)
      if (tf.afterDate.trim().length > 0) tfScoping.push(`after=${tf.afterDate.trim()}`)
      if (tf.beforeDate.trim().length > 0) tfScoping.push(`before=${tf.beforeDate.trim()}`)
      if (tf.purpose.trim().length > 0) tfScoping.push('purpose=set')
      notes.push(`- tinyfish: up to ${TINYFISH_PAGE_SIZE} results/page, max ${tf.maxPages} page(s) per search${tfScoping.length > 0 ? `; scoping: ${tfScoping.join(', ')}` : '; no extra scoping configured'}.`)

      const tfFetch = []
      tfFetch.push(`format=${tf.fetchFormat}`)
      if (tf.fetchLinks) tfFetch.push('links=on')
      if (tf.fetchImageLinks) tfFetch.push('imageLinks=on')
      if (tf.fetchPerUrlTimeoutMs > 0) tfFetch.push(`perUrlTimeoutMs=${tf.fetchPerUrlTimeoutMs}`)
      if (tf.fetchTtlSeconds >= 0) tfFetch.push(`ttl=${tf.fetchTtlSeconds}${tf.fetchTtlSeconds === 0 ? ' (force live)' : ''}`)
      notes.push(`- tinyfish fetch: ${tfFetch.join(', ')}.`)

      const as = cfg.anysearch
      const asScoping = []
      if (as.tag.trim().length > 0) asScoping.push(`tag=${as.tag.trim()}`)
      if (as.params.trim().length > 0) asScoping.push('params=set')
      if (as.zone.trim().length > 0) asScoping.push(`zone=${as.zone.trim()}`)
      if (as.language.trim().length > 0) asScoping.push(`language=${as.language.trim()}`)
      notes.push(`- anysearch: ${as.maxResults} results/query${asScoping.length > 0 ? `; scoping: ${asScoping.join(', ')}` : '; general web search (no vertical tag)'}.`)
      parts.push('', 'Per-backend configuration (Settings → Plugins → dsh-hydrasearch):', ...notes)

      parts.push(
        '',
        'Reordering the chain, changing scoping, or saving a key all take effect on the next call — no restart.',
        `Each backend reads its API key from the credential center only (tinyfish: ${TINYFISH_API_KEY_REF}, anysearch: ${ANYSEARCH_API_KEY_REF}); ${TINYFISH_API_KEY_ENV} and other environment variables are NOT consulted, so a key must be saved in the dsh-hydrasearch settings card. Never claim the web is unreachable without reporting the provider error you saw.`,
      )
      disposeSection = sctx.systemPrompt.section({
        name: 'hydrasearch:backend',
        order: 500,
        text: parts.join('\n'),
      })
    }
    sctx.effect(() => {
      refreshPrompt()
      return () => {
        if (disposeSection !== null) disposeSection()
        disposeSection = null
        refreshPrompt = null
      }
    }, 'hydrasearch: backend prompt section')
  })
}

export {
  ANYSEARCH_API_KEY_ENV,
  ANYSEARCH_API_KEY_REF,
  fetchAnysearch,
  parseAutoRegisteredKey,
  resolveAnysearchBase,
  searchAnysearch,
  subDomainsAnysearch,
} from './anysearch.js'

export {
  TINYFISH_API_KEY_ENV,
  TINYFISH_API_KEY_REF,
  fetchTinyfish,
  searchTinyfish,
} from './tinyfish.js'
