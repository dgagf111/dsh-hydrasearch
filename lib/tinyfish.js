/**
 * TinyFish REST client — the transport behind the `tinyfish` backend.
 *
 * Four facts drive this module's shape (all verified against the live service,
 * see README "Verified API behaviour"):
 *
 * 1. Search and Fetch live on their OWN hosts (`api.search.tinyfish.ai`,
 *    `api.fetch.tinyfish.ai`) and are served at the ROOT path, not under `/v1`.
 *    The vendor SDK encodes the same split; we call REST directly so the
 *    provider can honour `AbortSignal` and skip a subprocess entirely.
 * 2. Auth is a single `X-API-Key` header. The key is SUPPLIED BY THE CALLER,
 *    which resolves it from the credential center — this module reads no key
 *    source of its own, so the store the settings card writes is the store the
 *    request authenticates with.
 * 3. Search returns `date` as a human string ("Aug 17, 2026"). The web seam
 *    requires ISO-8601 in `publishedAt`, so dates are normalized and DROPPED
 *    when they cannot be parsed — inventing a timestamp would make the seam lie.
 * 4. Pagination is page-indexed from 0 and capped by the service at page 10.
 *    `maxPages` bounds how many round trips one search may cost.
 *
 * @module dsh-hydrasearch/tinyfish
 */

/**
 * Default search host; the query string carries every parameter. Both hosts are
 * overridable per deployment (config `tinyfish.searchBaseURL` /
 * `tinyfish.fetchBaseURL`), so a self-hosted or staging install needs no code
 * change.
 */
export const TINYFISH_SEARCH_URL = 'https://api.search.tinyfish.ai/'

/** Default fetch host; the URL list rides a JSON POST body. */
export const TINYFISH_FETCH_URL = 'https://api.fetch.tinyfish.ai/'

/** Environment variable the TinyFish CLI and SDK read (diagnostic reference only). */
export const TINYFISH_API_KEY_ENV = 'TINYFISH_API_KEY'

/**
 * Credential-center reference the settings card reads, writes, and clears.
 *
 * Deliberately NOT `TINYFISH_API_KEY`, even though that is the variable the
 * TinyFish CLI and SDK use. A credential reference that shares its name with a
 * conventional environment variable is permanently SHADOWED on any machine that
 * exports one: `dsh-credentials-local` layers the launch environment ABOVE the
 * writable document and refuses `set`/`unset` for shadowed refs (a write that
 * resolution would ignore is worse than an error), so the settings card could
 * never save or clear such a key. A plugin-owned name cannot be shadowed by
 * accident, which is what makes read, write, and clear address one store.
 *
 * {@link TINYFISH_API_KEY_ENV} stays the CLI/SDK variable name; it is reported
 * for diagnostics only and is no longer a key source for this plugin.
 */
export const TINYFISH_API_KEY_REF = 'HYDRASEARCH_TINYFISH_API_KEY'

/** Results TinyFish returns per page; pagination is page-indexed from 0. */
export const TINYFISH_PAGE_SIZE = 10

/** Default cap on pages fetched for one search. */
export const TINYFISH_MAX_PAGES = 3

/** Hard cap the service itself enforces on `page`. */
export const TINYFISH_SERVICE_MAX_PAGE = 10

/** Bounds the service enforces on `per_url_timeout_ms` for a fetch. */
export const TINYFISH_MIN_FETCH_TIMEOUT_MS = 1
export const TINYFISH_MAX_FETCH_TIMEOUT_MS = 110000

/** Domain scopes TinyFish exposes; anything else is rejected before the wire. */
export const TINYFISH_DOMAIN_TYPES = ['web', 'news', 'research_paper']

/** Fetch output formats TinyFish accepts. */
export const TINYFISH_FETCH_FORMATS = ['markdown', 'html', 'json']

/**
 * Normalize a TinyFish result date to ISO-8601, or `undefined` when it is not a
 * date we can stand behind. `new Date('Aug 17, 2026')` parses, but a bare year
 * or an unrecognized locale string does not — those are dropped rather than
 * guessed, because the seam documents `publishedAt` as provider-supplied
 * ISO-8601 and a wrong timestamp is worse than no timestamp.
 *
 * @param value - the raw `date` field from a search result.
 * @returns an ISO-8601 string, or `undefined`.
 */
export function normalizeDate(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return undefined
  return parsed.toISOString()
}

/**
 * Guarantee a base URL ends in `/` so path joining is unambiguous: the search
 * host serves at the root, so `https://host` and `https://host/` must produce
 * the same request URL.
 *
 * @param base - a configured or default endpoint.
 * @returns the endpoint with exactly one trailing slash.
 */
function ensureTrailingSlash(base) {
  return base.endsWith('/') ? base : `${base}/`
}

/**
 * Normalize one domain list. An absent list and a non-array are both "no
 * restriction", and blank entries are dropped rather than sent — TinyFish
 * rejects an empty `include_domains`, and `['', 'github.com']` would otherwise
 * put a stray empty element on the wire as `,+github.com`.
 *
 * @param value - `includeDomains` / `excludeDomains` as supplied by the caller.
 * @returns a clean array of trimmed, non-empty domain strings.
 */
function domainList(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * Build the query parameters for one search page. Undefined and blank fields
 * are omitted so the service applies its own defaults, and a blank list never
 * reaches the wire (TinyFish rejects an empty `include_domains`).
 *
 * @param options - resolved search options (see {@link searchTinyfish}).
 * @param page - zero-based page index.
 * @returns the parameter bag for `URLSearchParams`.
 */
function searchParams(options, page) {
  const params = { query: options.query }
  const includeDomains = domainList(options.includeDomains)
  const excludeDomains = domainList(options.excludeDomains)
  if (options.purpose !== undefined) params.purpose = options.purpose
  if (options.location !== undefined) params.location = options.location
  if (options.language !== undefined) params.language = options.language
  if (includeDomains.length > 0) params.include_domains = includeDomains.join(',')
  if (excludeDomains.length > 0) params.exclude_domains = excludeDomains.join(',')
  if (options.domainType !== undefined) params.domain_type = options.domainType
  if (options.afterDate !== undefined) params.after_date = options.afterDate
  if (options.beforeDate !== undefined) params.before_date = options.beforeDate
  if (options.recencyMinutes !== undefined) params.recency_minutes = String(options.recencyMinutes)
  // The service's browser-search backend requires a four-character year, so
  // zero-pad (500 -> "0500") exactly as the vendor SDK does.
  if (options.pubYearMin !== undefined) params.pub_year_min = String(options.pubYearMin).padStart(4, '0')
  if (options.pubYearMax !== undefined) params.pub_year_max = String(options.pubYearMax).padStart(4, '0')
  if (page > 0) params.page = String(page)
  return params
}

/**
 * Normalize one raw TinyFish result into the web seam's source shape. Optional
 * fields are omitted rather than set to empty strings: `web_search` renders
 * `title ?? hostname(url)`, and an empty title would defeat that fallback.
 *
 * @param result - one entry of the service's `results[]`.
 * @returns the normalized source.
 */
export function toSource(result) {
  const source = { url: String(result.url) }
  if (typeof result.title === 'string' && result.title.length > 0) source.title = result.title
  if (typeof result.snippet === 'string' && result.snippet.length > 0) source.snippet = result.snippet
  const publishedAt = normalizeDate(result.date)
  if (publishedAt !== undefined) source.publishedAt = publishedAt
  return source
}

/**
 * Run one TinyFish search.
 *
 * Pagination is bounded by `maxResults` and `maxPages`, a cost/latency
 * optimization the seam explicitly permits. What this function deliberately does
 * NOT do is slice its answer down to `maxResults`: returning everything it
 * retrieved lets the seam perform the cut and set `truncated`, which is what
 * tells the model that more results exist. Slicing here would report
 * `truncated: false` and hide that fact.
 *
 * @param options - search options.
 * @param options.query - non-blank query (validated by the caller).
 * @param options.maxResults - bound on pagination, or undefined for one page.
 * @param options.maxPages - hard cap on round trips; defaults to {@link TINYFISH_MAX_PAGES}.
 * @param options.purpose - freeform intent hint; improves result quality.
 * @param options.location - location hint.
 * @param options.language - language hint.
 * @param options.includeDomains - domains to restrict to; optional (absent means
 *   "no restriction"), and blank entries are dropped.
 * @param options.excludeDomains - domains to exclude; optional (absent means
 *   "no restriction"), and blank entries are dropped.
 * @param options.domainType - `web` | `news` | `research_paper`.
 * @param options.afterDate - `YYYY-MM-DD` lower bound.
 * @param options.beforeDate - `YYYY-MM-DD` upper bound.
 * @param options.recencyMinutes - freshness window in minutes.
 * @param options.pubYearMin - earliest publication year.
 * @param options.pubYearMax - latest publication year.
 * @param apiKey - resolved API key.
 * @param signal - cancellation signal forwarded to every request.
 * @param transport - `baseURL` override plus an injectable `fetch`.
 * @returns `{ sources, totalResults }`, deduplicated by URL and not sliced.
 * @throws {TinyFishError} on abort, transport, HTTP, or shape failure.
 */
export async function searchTinyfish(options, apiKey, signal, transport = {}) {
  const baseURL = transport.baseURL ?? TINYFISH_SEARCH_URL
  const wanted = Number.isInteger(options.maxResults) && options.maxResults > 0 ? options.maxResults : undefined
  const pageCap = clampInt(options.maxPages, 1, TINYFISH_SERVICE_MAX_PAGE, TINYFISH_MAX_PAGES)
  const pagesNeeded = wanted === undefined ? 1 : Math.min(Math.ceil(wanted / TINYFISH_PAGE_SIZE), pageCap)
  const seen = new Set()
  const sources = []
  let totalResults = 0

  for (let page = 0; page < pagesNeeded; page += 1) {
    const url = `${ensureTrailingSlash(baseURL)}?${new URLSearchParams(searchParams(options, page)).toString()}`
    const payload = await tinyfishRequest(url, { method: 'GET' }, apiKey, signal, transport)
    const results = Array.isArray(payload.results) ? payload.results : []
    if (page === 0) totalResults = typeof payload.total_results === 'number' ? payload.total_results : results.length
    for (const result of results) {
      if (result === null || typeof result !== 'object' || typeof result.url !== 'string') continue
      // The service can repeat a URL across pages; the seam's callers show one
      // entry per source, so duplicates are collapsed at first occurrence.
      if (seen.has(result.url)) continue
      seen.add(result.url)
      sources.push(toSource(result))
    }
    // `>=` (not `>`): a full page already satisfies any bound this page size can
    // meet, and a second request would be a wasted round trip.
    if (wanted !== undefined && sources.length >= wanted) break
    if (results.length < TINYFISH_PAGE_SIZE) break
  }

  return { sources, totalResults }
}

/**
 * Fetch one URL through TinyFish and return its extracted content.
 *
 * TinyFish does not surface the origin's HTTP status: a URL it could not
 * retrieve is reported in `errors[]` instead. The caller therefore reports `200`
 * for a present result and raises a provider error for an absent one — see the
 * README's "fidelity notes".
 *
 * @param url - the absolute HTTP(S) URL to retrieve.
 * @param apiKey - resolved API key.
 * @param signal - cancellation signal.
 * @param transport - `baseURL` override plus an injectable `fetch`.
 * @param options - optional fetch parameters forwarded to the service.
 * @param options.format - `markdown` | `html` | `json`; defaults to markdown.
 * @param options.purpose - freeform intent hint for the extraction.
 * @param options.links - also return the page's extracted links.
 * @param options.perUrlTimeoutMs - per-URL wall-clock budget.
 * @param options.ttl - cache freshness tolerance in seconds (0 = prefer live).
 * @returns `{ finalUrl, title, text, format, links }`.
 * @throws {TinyFishError} on abort, transport, HTTP, shape, or per-URL failure.
 */
export async function fetchTinyfish(url, apiKey, signal, transport = {}, options = {}) {
  const body = { urls: [url] }
  body.format = TINYFISH_FETCH_FORMATS.includes(options.format) ? options.format : 'markdown'
  if (options.purpose !== undefined) body.purpose = options.purpose
  if (options.links === true) body.links = true
  if (options.imageLinks === true) body.image_links = true
  if (Number.isInteger(options.perUrlTimeoutMs) && options.perUrlTimeoutMs > 0) body.per_url_timeout_ms = options.perUrlTimeoutMs
  // `ttl` is meaningful at 0 ("prefer a live fetch"), so only a negative or
  // absent value means "let the service decide".
  if (Number.isInteger(options.ttl) && options.ttl >= 0) body.ttl = options.ttl

  const payload = await tinyfishRequest(ensureTrailingSlash(transport.baseURL ?? TINYFISH_FETCH_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, apiKey, signal, transport)

  const results = Array.isArray(payload.results) ? payload.results : []
  const errors = Array.isArray(payload.errors) ? payload.errors : []
  const result = results[0]

  if (result === undefined || result === null || typeof result !== 'object') {
    const detail = errors[0] !== undefined && typeof errors[0].error === 'string'
      ? errors[0].error
      : 'the service returned no content for this URL'
    throw new TinyFishError(`TinyFish could not fetch ${url}: ${detail}`, 'TINYFISH_FETCH_FAILED')
  }

  const format = typeof result.format === 'string' ? result.format : body.format
  // `json` format returns an object tree in `text`; a text-kind seam body can
  // only carry a string, so the tree is serialized rather than dropped.
  const raw = result.text
  const text = typeof raw === 'string' ? raw : raw === null || raw === undefined ? '' : JSON.stringify(raw, null, 2)
  const finalUrl = typeof result.final_url === 'string' && result.final_url.length > 0 ? result.final_url : url
  if (text.length === 0) {
    throw new TinyFishError(
      `TinyFish returned no extractable text for ${finalUrl} (the page may be empty, binary, or blocked)`,
      'TINYFISH_EMPTY_BODY',
    )
  }

  return {
    finalUrl,
    title: typeof result.title === 'string' && result.title.length > 0 ? result.title : undefined,
    text,
    format,
    links: Array.isArray(result.links) ? result.links : [],
  }
}

/**
 * Typed TinyFish failure with a machine-routable `code`. The provider
 * translates these into the seam's `WebError`, so the codes exist to keep the
 * two layers from smearing one failure mode into another.
 */
export class TinyFishError extends Error {
  /**
   * @param message - human-readable diagnosis.
   * @param code - stable machine code (`TINYFISH_HTTP_ERROR`, `TINYFISH_ABORTED`, …).
   * @param status - HTTP status when the failure came from a response.
   */
  constructor(message, code, status) {
    super(message)
    this.name = 'TinyFishError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

/**
 * One authenticated TinyFish request with uniform error mapping.
 *
 * @param url - absolute request URL.
 * @param init - method/headers/body for `fetch`.
 * @param apiKey - resolved API key.
 * @param signal - caller cancellation signal.
 * @param transport - `fetch` override.
 * @returns the parsed JSON body.
 * @throws {TinyFishError} for aborts, transport failures, non-2xx, and non-JSON bodies.
 */
async function tinyfishRequest(url, init, apiKey, signal, transport = {}) {
  const fetchImpl = transport.fetch ?? fetch
  let response
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: 'error',
      headers: {
        'x-api-key': apiKey,
        accept: 'application/json',
        'user-agent': 'deepseek-harness/dsh-hydrasearch',
        ...init.headers,
      },
      ...signal !== undefined ? { signal } : {},
    })
  } catch (error) {
    if (isAbortError(error)) throw new TinyFishError('TinyFish request aborted', 'TINYFISH_ABORTED')
    throw new TinyFishError(`TinyFish request failed: ${String(error)}`, 'TINYFISH_NETWORK_ERROR')
  }

  if (!response.ok) {
    let detail = ''
    try {
      const body = await response.json()
      if (typeof body?.error?.message === 'string') detail = body.error.message
      else if (typeof body?.message === 'string') detail = body.message
    } catch (error) {
      // An abort that fires while reading the error body is still a cancellation.
      if (isAbortError(error)) throw new TinyFishError('TinyFish request aborted', 'TINYFISH_ABORTED')
      // A non-JSON error body (normal for gateway 5xx/429) costs a richer
      // message, never the real failure: the status is carried below.
    }
    const suffix = detail.length > 0 ? `: ${detail}` : ''
    throw new TinyFishError(
      `TinyFish API error (HTTP ${response.status})${suffix}${statusHint(response.status)}`,
      'TINYFISH_HTTP_ERROR',
      response.status,
    )
  }

  try {
    return await response.json()
  } catch (error) {
    if (isAbortError(error)) throw new TinyFishError('TinyFish request aborted', 'TINYFISH_ABORTED')
    throw new TinyFishError(`TinyFish returned an unprocessable body: ${String(error)}`, 'TINYFISH_BAD_RESPONSE')
  }
}

/**
 * Append the actionable half of a status-code diagnosis. A 401/403 is almost
 * always a missing or rejected key, and saying so turns a dead end into a fix.
 *
 * @param status - the HTTP status code.
 * @returns a leading-space advice suffix, or `''` when the status needs none.
 */
function statusHint(status) {
  if (status === 401 || status === 403) {
    return ' — check the TinyFish API key (set TINYFISH_API_KEY, run `tinyfish auth login`, or enter it in the plugin settings card)'
  }
  if (status === 429) return ' — TinyFish rate limit reached; retry shortly'
  return ''
}

/** Clamp an optional integer into `[min, max]`, falling back when absent. */
function clampInt(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), min), max)
}

/** True for a fetch/`AbortSignal` abort, which is cancellation, not failure. */
function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError'
}
