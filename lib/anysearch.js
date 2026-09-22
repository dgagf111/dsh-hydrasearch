/**
 * AnySearch REST client — the transport behind the `anysearch` backend.
 *
 * The contract below was read off the vendor's bundled CLI
 * (`anysearch_cli.{js,py,ps1,sh}` in the `anysearch` skill) and confirmed
 * against the live service. Four facts matter:
 *
 * 1. One host (`https://api.anysearch.com`, override `ANYSEARCH_API_BASE_URL`)
 *    serves three REST operations: `POST /v1/search`, `POST /v1/extract`, and
 *    `GET /v1/sub-domains`.
 * 2. Auth is optional. `Authorization: Bearer <key>` raises the rate limit;
 *    anonymous access is allowed but metered. When the daily free quota is
 *    exhausted the service answers with `error_code:
 *    "daily_free_quota_exhausted"` AND auto-registers an account, returning the
 *    new credentials inside `message`. That message is surfaceable, so the
 *    settings card can offer the key to the operator rather than dead-ending.
 * 3. The envelope is `{ code, message, request_id, data }` where `code === 0`
 *    means success. HTTP 200 can still carry a non-zero `code`, so the code —
 *    not the status — decides success.
 * 4. Vertical search is addressed by `tag` (e.g. `finance.quote`) with a
 *    `params` object whose required members come from `/v1/sub-domains`. This
 *    transport forwards `tag`/`params` verbatim; discovering them is the
 *    caller's business.
 *
 * @module dsh-hydrasearch/anysearch
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Default API host. Trailing slashes are stripped before use. */
export const ANYSEARCH_BASE_URL = 'https://api.anysearch.com'

/** Environment variable read for the key (and for the base-URL override). */
export const ANYSEARCH_API_KEY_ENV = 'ANYSEARCH_API_KEY'

/** Base-URL override the vendor CLI also honours. */
export const ANYSEARCH_BASE_URL_ENV = 'ANYSEARCH_API_BASE_URL'

/** Credential-center reference the settings card reads and writes. */
export const ANYSEARCH_API_KEY_REF = 'ANYSEARCH_API_KEY'

/** Per-query result bound the service accepts. */
export const ANYSEARCH_MIN_RESULTS = 1
export const ANYSEARCH_MAX_RESULTS = 10

/** Identifies this client to the service, mirroring the vendor CLI's header. */
export const ANYSEARCH_CLIENT_HEADER = 'dsh-hydrasearch/0.2.0'

/** Where a key minted by the auto-registration flow is written. */
export const ANYSEARCH_SKILL_ENV_PATH = path.join(os.homedir(), '.agents', 'skills', 'anysearch', '.env')

/**
 * Read `ANYSEARCH_API_KEY` from the skill's `.env` file — the third key source,
 * after explicit config and the environment, and the place the vendor CLI's own
 * auto-registration flow writes to.
 *
 * @param envPath - the `.env` path; injectable for tests.
 * @returns the key, or `''` when the file is absent or holds no key.
 */
export function readSkillEnvKey(envPath = ANYSEARCH_SKILL_ENV_PATH) {
  try {
    const text = fs.readFileSync(envPath, 'utf8')
    for (const line of text.split('\n')) {
      const match = /^\s*ANYSEARCH_API_KEY\s*=\s*(.+?)\s*$/.exec(line)
      if (match !== null && match[1].length > 0) return match[1].replace(/^["']|["']$/g, '')
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * Resolve the effective key. Precedence matches the vendor CLI: explicit config,
 * then the environment, then the skill's `.env`. An empty result means anonymous
 * access, which AnySearch permits — so unlike TinyFish, a missing key is NOT a
 * reason to report the backend unavailable.
 *
 * @param configuredKey - key from the plugin's settings config.
 * @param env - environment bag; injectable for tests.
 * @returns the resolved key, or `''` for anonymous access.
 */
export function resolveAnysearchKey(configuredKey, env = process.env) {
  if (typeof configuredKey === 'string' && configuredKey.trim().length > 0) return configuredKey.trim()
  const fromEnv = env[ANYSEARCH_API_KEY_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return readSkillEnvKey()
}

/**
 * Resolve the effective base URL: explicit config, then the vendor CLI's own
 * override variable, then the public host.
 *
 * @param configuredBase - base URL from the plugin's settings config.
 * @param env - environment bag; injectable for tests.
 * @returns the base URL without a trailing slash.
 */
export function resolveAnysearchBase(configuredBase, env = process.env) {
  const candidate = configuredBase !== undefined && configuredBase.trim().length > 0
    ? configuredBase.trim()
    : typeof env[ANYSEARCH_BASE_URL_ENV] === 'string' && env[ANYSEARCH_BASE_URL_ENV].trim().length > 0
      ? env[ANYSEARCH_BASE_URL_ENV].trim()
      : ANYSEARCH_BASE_URL
  return candidate.replace(/\/+$/, '')
}

/**
 * Typed AnySearch failure with a machine-routable `code`.
 *
 * `AUTO_REGISTERED` is special: the request FAILED, but the service attached a
 * freshly minted credential to the error. The provider surfaces that key so the
 * operator can adopt it, instead of discarding the only copy.
 */
export class AnysearchError extends Error {
  /**
   * @param message - human-readable diagnosis.
   * @param code - stable machine code.
   * @param status - HTTP status when the failure came from a response.
   * @param autoKey - key the service minted alongside the failure, when any.
   */
  constructor(message, code, status, autoKey) {
    super(message)
    this.name = 'AnysearchError'
    this.code = code
    if (status !== undefined) this.status = status
    if (autoKey !== undefined) this.autoKey = autoKey
  }
}

/**
 * Extract `api_key=...` from an AnySearch auto-registration message.
 *
 * The service embeds the credential in the human-readable `message` as
 * `username=... password=... api_key=...`. Parsing it out is what lets the
 * settings card offer the key for adoption.
 *
 * @param message - the `message` field of a failed envelope.
 * @returns the key, or `undefined` when the message carries none.
 */
export function parseAutoRegisteredKey(message) {
  if (typeof message !== 'string') return undefined
  const match = /api_key\s*=\s*(\S+)/.exec(message)
  return match === null ? undefined : match[1]
}

/**
 * Append the skill `.env` file with the given key, preserving other lines. This
 * is the fallback persistence path for a key minted by auto-registration when no
 * credential center is mounted — the same file the vendor CLI reads.
 *
 * @param key - the API key to persist.
 * @param envPath - the `.env` path; injectable for tests.
 * @returns the path written, for reporting back to the card.
 */
export function writeSkillEnvKey(key, envPath = ANYSEARCH_SKILL_ENV_PATH) {
  let existing = ''
  try {
    existing = fs.readFileSync(envPath, 'utf8')
  } catch {
    // Absent file: create it below.
  }
  const kept = existing
    .split('\n')
    .filter((line) => !/^\s*ANYSEARCH_API_KEY\s*=/.test(line))
    .join('\n')
  const body = `${kept}${kept.length > 0 && !kept.endsWith('\n') ? '\n' : ''}ANYSEARCH_API_KEY=${key}\n`
  fs.mkdirSync(path.dirname(envPath), { recursive: true })
  fs.writeFileSync(envPath, body, { mode: 0o600 })
  return envPath
}

/**
 * Normalize one AnySearch result into the web seam's source shape. The service
 * returns both `snippet` and a longer `content`; the snippet is preferred
 * because `web_search` renders it inline, and `content` frequently carries
 * sitelink noise. Optional fields are omitted, never blanked.
 *
 * @param result - one entry of `data.results[]`.
 * @returns the normalized source.
 */
export function toSource(result) {
  const source = { url: String(result.url) }
  if (typeof result.title === 'string' && result.title.length > 0) source.title = result.title
  const snippet = typeof result.snippet === 'string' && result.snippet.length > 0
    ? result.snippet
    : typeof result.content === 'string' && result.content.length > 0
      ? result.content
      : ''
  if (snippet.length > 0) source.snippet = snippet
  // AnySearch returns no publication timestamp on the general search path, so
  // `publishedAt` is left absent rather than guessed.
  return source
}

/**
 * Run one AnySearch search.
 *
 * @param options - search options.
 * @param options.query - non-blank query (validated by the caller).
 * @param options.maxResults - per-query bound, clamped to the service's 1–10.
 * @param options.tag - vertical sub-domain tag (e.g. `finance.quote`).
 * @param options.params - vertical parameters; forwarded verbatim.
 * @param options.zone - geographic zone hint.
 * @param options.language - language hint.
 * @param apiKey - resolved key, or `''` for anonymous access.
 * @param signal - cancellation signal.
 * @param transport - `baseURL` override plus an injectable `fetch`.
 * @returns `{ sources, totalResults, searchTimeMs }`.
 * @throws {AnysearchError} on abort, transport, envelope error, or shape failure.
 */
export async function searchAnysearch(options, apiKey, signal, transport = {}) {
  const body = { query: options.query }
  if (options.tag !== undefined) body.tag = options.tag
  if (options.params !== undefined) body.params = options.params
  if (options.zone !== undefined) body.zone = options.zone
  if (options.language !== undefined) body.language = options.language
  if (Number.isFinite(options.maxResults)) {
    body.max_results = Math.min(Math.max(Math.trunc(options.maxResults), ANYSEARCH_MIN_RESULTS), ANYSEARCH_MAX_RESULTS)
  }

  const payload = await anysearchRequest('/v1/search', { method: 'POST', body }, apiKey, signal, transport)
  const data = payload.data ?? {}
  const results = Array.isArray(data.results) ? data.results : []
  const metadata = data.metadata ?? {}
  const sources = []
  const seen = new Set()
  for (const result of results) {
    if (result === null || typeof result !== 'object' || typeof result.url !== 'string') continue
    if (seen.has(result.url)) continue
    seen.add(result.url)
    sources.push(toSource(result))
  }
  return {
    sources,
    totalResults: typeof metadata.total_results === 'number' ? metadata.total_results : sources.length,
    searchTimeMs: typeof metadata.search_time_ms === 'number' ? metadata.search_time_ms : undefined,
  }
}

/**
 * Extract one URL's content through AnySearch.
 *
 * @param url - the absolute HTTP(S) URL to retrieve.
 * @param apiKey - resolved key, or `''` for anonymous access.
 * @param signal - cancellation signal.
 * @param transport - `baseURL` override plus an injectable `fetch`.
 * @returns `{ finalUrl, title, text }`.
 * @throws {AnysearchError} on abort, transport, envelope error, or shape failure.
 */
export async function fetchAnysearch(url, apiKey, signal, transport = {}) {
  const payload = await anysearchRequest('/v1/extract', { method: 'POST', body: { url } }, apiKey, signal, transport)
  const data = payload.data ?? {}
  const text = typeof data.content === 'string' ? data.content : ''
  if (text.length === 0) {
    throw new AnysearchError(
      `AnySearch returned no extractable content for ${url} (the page may be unsupported, empty, or blocked)`,
      'ANYSEARCH_EMPTY_BODY',
    )
  }
  return {
    finalUrl: typeof data.url === 'string' && data.url.length > 0 ? data.url : url,
    title: typeof data.title === 'string' && data.title.length > 0 ? data.title : undefined,
    text,
  }
}

/**
 * Discover the vertical sub-domains (and their required parameters) for up to
 * five domains. Exposed for the settings card's capability probe and for callers
 * that want to build a valid `tag`/`params` pair.
 *
 * @param domains - up to five domain names (e.g. `finance`).
 * @param apiKey - resolved key, or `''` for anonymous access.
 * @param signal - cancellation signal.
 * @param transport - `baseURL` override plus an injectable `fetch`.
 * @returns the raw `data` payload, whose `domains[]` carries `sub_domains[]`.
 * @throws {AnysearchError} on abort, transport, envelope error, or too many domains.
 */
export async function subDomainsAnysearch(domains, apiKey, signal, transport = {}) {
  if (!Array.isArray(domains) || domains.length === 0) {
    throw new AnysearchError('at least one domain is required', 'ANYSEARCH_BAD_REQUEST')
  }
  if (domains.length > 5) {
    throw new AnysearchError('get_sub_domains supports a maximum of 5 domains', 'ANYSEARCH_BAD_REQUEST')
  }
  const query = domains.map((domain) => ['domain', domain])
  const payload = await anysearchRequest('/v1/sub-domains', { method: 'GET', query }, apiKey, signal, transport)
  return payload.data ?? {}
}

/**
 * One AnySearch request with uniform envelope handling.
 *
 * @param pathname - `/v1/...` path.
 * @param init - `method`, optional `body`, optional `query` pairs.
 * @param apiKey - resolved key; blank sends no Authorization header.
 * @param signal - caller cancellation signal.
 * @param transport - `baseURL` override plus a `fetch` override.
 * @returns the parsed envelope whose `code` is 0.
 * @throws {AnysearchError} for aborts, transport failures, non-2xx, and non-zero codes.
 */
async function anysearchRequest(pathname, init, apiKey, signal, transport = {}) {
  const fetchImpl = transport.fetch ?? fetch
  const base = resolveAnysearchBase(transport.baseURL)
  const url = new URL(base + pathname)
  for (const [key, value] of init.query ?? []) url.searchParams.append(key, value)

  let response
  try {
    response = await fetchImpl(url.toString(), {
      method: init.method,
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'x-anysearch-client': ANYSEARCH_CLIENT_HEADER,
        ...init.body !== undefined ? { 'content-type': 'application/json' } : {},
        ...apiKey.length > 0 ? { authorization: `Bearer ${apiKey}` } : {},
      },
      ...init.body !== undefined ? { body: JSON.stringify(init.body) } : {},
      ...signal !== undefined ? { signal } : {},
    })
  } catch (error) {
    if (isAbortError(error)) throw new AnysearchError('AnySearch request aborted', 'ANYSEARCH_ABORTED')
    throw new AnysearchError(`AnySearch request failed: ${String(error)}`, 'ANYSEARCH_NETWORK_ERROR')
  }

  let payload
  try {
    payload = await response.json()
  } catch (error) {
    if (isAbortError(error)) throw new AnysearchError('AnySearch request aborted', 'ANYSEARCH_ABORTED')
    throw new AnysearchError(
      `AnySearch returned an unprocessable body (HTTP ${response.status})`,
      'ANYSEARCH_BAD_RESPONSE',
      response.status,
    )
  }

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AnysearchError(`AnySearch returned an unexpected body (HTTP ${response.status})`, 'ANYSEARCH_BAD_RESPONSE', response.status)
  }

  // The service answers HTTP 200 with a non-zero `code` for quota and auth
  // problems, so the envelope code — not the HTTP status — decides success.
  const code = payload.code
  if (response.status >= 400 || (code !== undefined && code !== 0)) {
    const message = typeof payload.message === 'string' && payload.message.length > 0
      ? payload.message
      : `AnySearch API error (HTTP ${response.status})`
    const autoKey = parseAutoRegisteredKey(payload.message)
    const suffix = statusHint(payload.error_code)
    if (autoKey !== undefined) {
      throw new AnysearchError(
        `${message}${suffix}`,
        'ANYSEARCH_AUTO_REGISTERED',
        response.status,
        autoKey,
      )
    }
    throw new AnysearchError(`${message}${suffix}`, 'ANYSEARCH_API_ERROR', response.status)
  }

  return payload
}

/**
 * Append the actionable half of a service error code. The auto-registration
 * case is the one an operator hits on a fresh install, so it names the fix.
 *
 * @param errorCode - the envelope's `error_code` field.
 * @returns a leading-space advice suffix, or `''`.
 */
function statusHint(errorCode) {
  if (errorCode === 'daily_free_quota_exhausted') {
    return ' — the daily anonymous quota is exhausted; paste the API key from the message above, set ANYSEARCH_API_KEY, or add it in the plugin settings card'
  }
  return ''
}

/** True for a fetch/`AbortSignal` abort, which is cancellation, not failure. */
function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError'
}
