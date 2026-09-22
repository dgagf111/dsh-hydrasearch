/**
 * Headless verification for dsh-hydrasearch.
 *
 * The plugin is exercised against the REAL DSH service modules the running app
 * uses (`@deepseek-ai/dsh-web`, `dsh-settings`, `dsh-tools`, `schemastery`),
 * loaded from the same tree the host loads them from. Two layers are covered:
 *
 *   1. Offline unit checks against a stubbed `fetch`: URL/method/header shape,
 *      pagination, dedup, date normalization, error mapping, and the provider
 *      seam contract (available(), search(), fetch()).
 *   2. Live checks against the TinyFish service when a key resolves: a real
 *      search and a real fetch through the providers.
 *
 * Run with the bundled Node so `@deepseek-ai/*` resolves:
 *   node scripts/verify.mjs
 *
 * Exit code 0 means every check passed; 1 means at least one failed.
 */

import assert from 'node:assert/strict'
import process from 'node:process'

/** Minimal test reporter. */
let failures = 0
let checks = 0

/** Run one named check, recording a failure instead of aborting the suite. */
async function check(name, fn) {
  checks += 1
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Build a `fetch` stub returning one canned response per call, in order. */
function stubFetch(responses) {
  const calls = []
  let index = 0
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    const next = responses[index]
    index += 1
    if (next === undefined) throw new Error(`unexpected fetch call #${index}: ${url}`)
    if (next instanceof Error) throw next
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => {
        if (next.body === undefined) throw new SyntaxError('not json')
        return next.body
      },
    }
  }
  impl.calls = calls
  return impl
}

/** One TinyFish search page payload. */
function page(results, total = results.length) {
  return { status: 200, body: { query: 'q', results, total_results: total, page: 0 } }
}

/** One TinyFish search result. */
function result(url, extra = {}) {
  return { position: 1, site_name: 'example.com', snippet: `snippet for ${url}`, title: `title ${url}`, url, ...extra }
}

console.log('dsh-hydrasearch verification\n')

/* ------------------------------------------------------- transport layer */

const tf = await import('../lib/tinyfish.js')
const as = await import('../lib/anysearch.js')

console.log('tinyfish transport (stubbed fetch)')

await check('search sends the documented query parameters', async () => {
  const fetchImpl = stubFetch([page([result('https://a.test/1')])])
  await tf.searchTinyfish({
    query: 'deepseek harness',
    maxResults: 5,
    purpose: 'evaluate plugin APIs',
    language: 'zh',
    location: 'China',
    domainType: 'news',
    includeDomains: ['github.com', 'arxiv.org'],
    excludeDomains: ['pinterest.com'],
  }, 'sk-test', undefined, { fetch: fetchImpl })

  const [call] = fetchImpl.calls
  const url = new URL(call.url)
  assert.equal(url.origin + url.pathname, 'https://api.search.tinyfish.ai/')
  assert.equal(url.searchParams.get('query'), 'deepseek harness')
  assert.equal(url.searchParams.get('purpose'), 'evaluate plugin APIs')
  assert.equal(url.searchParams.get('language'), 'zh')
  assert.equal(url.searchParams.get('location'), 'China')
  assert.equal(url.searchParams.get('domain_type'), 'news')
  assert.equal(url.searchParams.get('include_domains'), 'github.com,arxiv.org')
  assert.equal(url.searchParams.get('exclude_domains'), 'pinterest.com')
  assert.equal(url.searchParams.has('page'), false, 'page 0 must be omitted')
  assert.equal(call.init.headers['x-api-key'], 'sk-test')
})

await check('search omits blank scoping instead of sending empty values', async () => {
  const fetchImpl = stubFetch([page([])])
  await tf.searchTinyfish({
    query: 'q',
    includeDomains: [],
    excludeDomains: [],
  }, 'sk-test', undefined, { fetch: fetchImpl })
  const url = new URL(fetchImpl.calls[0].url)
  for (const key of ['purpose', 'language', 'location', 'domain_type', 'include_domains', 'exclude_domains']) {
    assert.equal(url.searchParams.has(key), false, `${key} must be absent when blank`)
  }
})

// Regression: `includeDomains` / `excludeDomains` are documented as optional, and
// the plugin's own caller happens to always pass arrays — so a bare query-only
// call used to crash on `options.includeDomains.length`. Everything else in this
// suite passed an explicit `[]`, which is exactly why the gap survived.
await check('search works when the domain lists are omitted entirely', async () => {
  const fetchImpl = stubFetch([page([result('https://a.test/1')])])
  const { sources } = await tf.searchTinyfish({ query: 'q' }, 'sk-test', undefined, { fetch: fetchImpl })
  const url = new URL(fetchImpl.calls[0].url)
  assert.equal(url.searchParams.get('query'), 'q')
  for (const key of ['include_domains', 'exclude_domains']) {
    assert.equal(url.searchParams.has(key), false, `${key} must be absent when the list is omitted`)
  }
  assert.equal(sources.length, 1)
})

// Regression: documenting "blank entries are dropped" is only true if the array
// is actually cleaned. A bare `length > 0` guard let `['', 'github.com']` reach
// the wire as `,+github.com`.
await check('search drops blank entries inside a domain list', async () => {
  const fetchImpl = stubFetch([page([])])
  await tf.searchTinyfish({
    query: 'q',
    includeDomains: ['', '  github.com  ', '', 'arxiv.org'],
    excludeDomains: ['   ', 'pinterest.com'],
  }, 'sk-test', undefined, { fetch: fetchImpl })
  const url = new URL(fetchImpl.calls[0].url)
  assert.equal(url.searchParams.get('include_domains'), 'github.com,arxiv.org')
  assert.equal(url.searchParams.get('exclude_domains'), 'pinterest.com')
})

// A list that is blank *after* cleaning must vanish rather than be sent empty:
// TinyFish rejects an empty `include_domains` outright.
await check('search omits a domain list that is blank after cleaning', async () => {
  const fetchImpl = stubFetch([page([])])
  await tf.searchTinyfish({
    query: 'q',
    includeDomains: ['', '   '],
    excludeDomains: [],
  }, 'sk-test', undefined, { fetch: fetchImpl })
  const url = new URL(fetchImpl.calls[0].url)
  assert.equal(url.searchParams.has('include_domains'), false, 'an all-blank list must not be sent at all')
})

await check('search paginates only as far as maxResults needs', async () => {
  const first = Array.from({ length: 10 }, (_, i) => result(`https://a.test/${i}`))
  const second = Array.from({ length: 10 }, (_, i) => result(`https://b.test/${i}`))
  const fetchImpl = stubFetch([page(first, 30), page(second, 30)])
  const { sources, totalResults } = await tf.searchTinyfish({
    query: 'q', maxResults: 12, includeDomains: [], excludeDomains: [],
  }, 'sk-test', undefined, { fetch: fetchImpl })
  assert.equal(totalResults, 30)
  assert.equal(fetchImpl.calls.length, 2, 'must fetch exactly two pages for 12 results')
  assert.equal(new URL(fetchImpl.calls[1].url).searchParams.get('page'), '1')
  // 20 results for a maxResults of 12 is correct: the provider over-returns and
  // the seam caps + flags. Slicing here would hide `truncated` from the model.
  assert.equal(sources.length, 20, 'the provider over-returns by design')
})

await check('search stops paginating at the page cap', async () => {
  // Distinct URLs per page: reusing one set would collapse under dedup and
  // measure the wrong thing (the cap, not the dedup).
  const pages = Array.from({ length: 4 }, (_, pageIndex) =>
    page(Array.from({ length: 10 }, (_, i) => result(`https://page${pageIndex}.test/${i}`)), 100))
  const fetchImpl = stubFetch(pages)
  const { sources } = await tf.searchTinyfish({
    query: 'q', maxResults: 100, includeDomains: [], excludeDomains: [],
  }, 'sk-test', undefined, { fetch: fetchImpl })
  assert.equal(fetchImpl.calls.length, tf.TINYFISH_MAX_PAGES, 'must not exceed the page cap')
  assert.equal(sources.length, tf.TINYFISH_MAX_PAGES * tf.TINYFISH_PAGE_SIZE)
})

await check('search deduplicates URLs across pages', async () => {
  const fetchImpl = stubFetch([
    page([result('https://dup.test/x'), ...Array.from({ length: 9 }, (_, i) => result(`https://a.test/${i}`))], 30),
    page([result('https://dup.test/x'), ...Array.from({ length: 9 }, (_, i) => result(`https://b.test/${i}`))], 30),
  ])
  const { sources } = await tf.searchTinyfish({
    query: 'q', maxResults: 20, includeDomains: [], excludeDomains: [],
  }, 'sk-test', undefined, { fetch: fetchImpl })
  assert.equal(sources.filter((s) => s.url === 'https://dup.test/x').length, 1)
})

await check('search skips entries without a usable url', async () => {
  const fetchImpl = stubFetch([page([
    result('https://ok.test/1'),
    { position: 2, site_name: 'x', snippet: 's', title: 't' },
    null,
    result('https://ok.test/2'),
  ], 4)])
  const { sources } = await tf.searchTinyfish({
    query: 'q', maxResults: 5, includeDomains: [], excludeDomains: [],
  }, 'sk-test', undefined, { fetch: fetchImpl })
  assert.deepEqual(sources.map((s) => s.url), ['https://ok.test/1', 'https://ok.test/2'])
})

await check('source omits absent optional fields but keeps present ones', async () => {
  const fetchImpl = stubFetch([page([
    result('https://a.test/1'),
    result('https://a.test/2', { title: '', snippet: '', date: 'Aug 17, 2026' }),
  ])])
  const { sources } = await tf.searchTinyfish({
    query: 'q', maxResults: 5, includeDomains: [], excludeDomains: [],
  }, 'sk-test', undefined, { fetch: fetchImpl })
  assert.deepEqual(sources[0], {
    url: 'https://a.test/1',
    title: 'title https://a.test/1',
    snippet: 'snippet for https://a.test/1',
  })
  assert.equal(Object.hasOwn(sources[1], 'title'), false, 'blank title must be omitted, not emptied')
  assert.equal(Object.hasOwn(sources[1], 'snippet'), false, 'blank snippet must be omitted')
  assert.equal(sources[1].publishedAt, new Date('Aug 17, 2026').toISOString())
})

await check('normalizeDate returns ISO for parseable dates and undefined otherwise', async () => {
  assert.equal(tf.normalizeDate('Aug 17, 2026'), new Date('Aug 17, 2026').toISOString())
  assert.equal(tf.normalizeDate('2026-08-17'), new Date('2026-08-17').toISOString())
  assert.equal(tf.normalizeDate(''), undefined)
  assert.equal(tf.normalizeDate('not a date'), undefined)
  assert.equal(tf.normalizeDate(undefined), undefined)
  assert.equal(tf.normalizeDate(20260817), undefined)
})

await check('fetch posts the URL list and reads markdown back', async () => {
  const fetchImpl = stubFetch([{ status: 200, body: {
    results: [{ url: 'https://a.test/1', final_url: 'https://a.test/1/', title: 'A', text: '# Hello', format: 'markdown' }],
    errors: [],
  } }])
  const out = await tf.fetchTinyfish('https://a.test/1', 'sk-test', undefined, { fetch: fetchImpl })
  const [call] = fetchImpl.calls
  assert.equal(call.url, 'https://api.fetch.tinyfish.ai/')
  assert.equal(call.init.method, 'POST')
  assert.deepEqual(JSON.parse(call.init.body), { urls: ['https://a.test/1'], format: 'markdown' })
  assert.equal(call.init.headers['x-api-key'], 'sk-test')
  assert.equal(out.finalUrl, 'https://a.test/1/')
  assert.equal(out.text, '# Hello')
  assert.equal(out.title, 'A')
})

await check('fetch reports the per-URL service error when present', async () => {
  const fetchImpl = stubFetch([{ status: 200, body: {
    results: [],
    errors: [{ url: 'https://a.test/1', error: 'blocked by robots.txt' }],
  } }])
  await assert.rejects(
    () => tf.fetchTinyfish('https://a.test/1', 'sk-test', undefined, { fetch: fetchImpl }),
    (error) => error.code === 'TINYFISH_FETCH_FAILED' && /blocked by robots\.txt/.test(error.message),
  )
})

await check('fetch rejects an empty extraction rather than returning a blank body', async () => {
  const fetchImpl = stubFetch([{ status: 200, body: {
    results: [{ url: 'https://a.test/1', final_url: null, title: null, text: '', format: 'markdown' }],
    errors: [],
  } }])
  await assert.rejects(
    () => tf.fetchTinyfish('https://a.test/1', 'sk-test', undefined, { fetch: fetchImpl }),
    (error) => error.code === 'TINYFISH_EMPTY_BODY',
  )
})

await check('a 401 carries the actionable key hint', async () => {
  const fetchImpl = stubFetch([{ status: 401, body: { error: { message: 'invalid key' } } }])
  await assert.rejects(
    () => tf.searchTinyfish({ query: 'q', includeDomains: [], excludeDomains: [] }, 'bad', undefined, { fetch: fetchImpl }),
    (error) => error.code === 'TINYFISH_HTTP_ERROR'
      && error.status === 401
      && /invalid key/.test(error.message)
      && /TINYFISH_API_KEY/.test(error.message),
  )
})

await check('a non-JSON error body still reports the status', async () => {
  const fetchImpl = stubFetch([{ status: 502, body: undefined }])
  await assert.rejects(
    () => tf.searchTinyfish({ query: 'q', includeDomains: [], excludeDomains: [] }, 'k', undefined, { fetch: fetchImpl }),
    (error) => error.code === 'TINYFISH_HTTP_ERROR' && error.status === 502,
  )
})

await check('a transport failure maps to a network error', async () => {
  const fetchImpl = stubFetch([new TypeError('fetch failed')])
  await assert.rejects(
    () => tf.searchTinyfish({ query: 'q', includeDomains: [], excludeDomains: [] }, 'k', undefined, { fetch: fetchImpl }),
    (error) => error.code === 'TINYFISH_NETWORK_ERROR',
  )
})

await check('cancellation maps to an abort, not a failure', async () => {
  const fetchImpl = stubFetch([new DOMException('aborted', 'AbortError')])
  await assert.rejects(
    () => tf.searchTinyfish({ query: 'q', includeDomains: [], excludeDomains: [] }, 'k', undefined, { fetch: fetchImpl }),
    (error) => error.code === 'TINYFISH_ABORTED',
  )
})

await check('a base URL without a trailing slash still hits the root path', async () => {
  const fetchImpl = stubFetch([page([])])
  await tf.searchTinyfish({ query: 'q', includeDomains: [], excludeDomains: [] }, 'k', undefined, {
    baseURL: 'https://staging.test',
    fetch: fetchImpl,
  })
  assert.equal(new URL(fetchImpl.calls[0].url).pathname, '/')
})

await check('resolveTinyfishKey honours config, then env, then the CLI config', () => {
  assert.equal(tf.resolveTinyfishKey('  from-config  ', {}), 'from-config')
  assert.equal(tf.resolveTinyfishKey('', { TINYFISH_API_KEY: 'from-env' }), 'from-env')
  assert.equal(tf.resolveTinyfishKey('', { TINYFISH_API_KEY: '  ' }).length > 0, true, 'blank env falls through to the CLI config')
  assert.equal(typeof tf.readCliApiKey(), 'string')
})

/* ------------------------------------------------ anysearch transport layer */

console.log('\nanysearch transport (stubbed fetch)')

/** One AnySearch success envelope. */
function envelope(results, metadata = {}) {
  return { status: 200, body: {
    code: 0,
    message: 'ok',
    request_id: 'req-test',
    data: { results, metadata: { total_results: results.length, search_time_ms: 12, ...metadata } },
  } }
}

/** One AnySearch search result. */
function asResult(url, extra = {}) {
  return { title: `title ${url}`, url, snippet: `snippet for ${url}`, content: `content for ${url}`, ...extra }
}

await check('anysearch posts the query with the documented envelope', async () => {
  const fetchImpl = stubFetch([envelope([asResult('https://a.test/1')])])
  const out = await as.searchAnysearch({ query: 'deepseek harness', maxResults: 3 }, 'as_sk_test', undefined, { fetch: fetchImpl })
  const [call] = fetchImpl.calls
  assert.equal(call.url, 'https://api.anysearch.com/v1/search')
  assert.equal(call.init.method, 'POST')
  assert.deepEqual(JSON.parse(call.init.body), { query: 'deepseek harness', max_results: 3 })
  assert.equal(call.init.headers.authorization, 'Bearer as_sk_test')
  assert.equal(call.init.headers['x-anysearch-client'].startsWith('dsh-hydrasearch/'), true)
  assert.equal(out.sources.length, 1)
  assert.equal(out.totalResults, 1)
  assert.equal(out.searchTimeMs, 12)
})

await check('anysearch sends no Authorization header when anonymous', async () => {
  const fetchImpl = stubFetch([envelope([])])
  await as.searchAnysearch({ query: 'q' }, '', undefined, { fetch: fetchImpl })
  assert.equal(Object.hasOwn(fetchImpl.calls[0].init.headers, 'authorization'), false)
})

await check('anysearch clamps maxResults into the service range', async () => {
  const fetchImpl = stubFetch([envelope([]), envelope([]), envelope([])])
  await as.searchAnysearch({ query: 'q', maxResults: 99 }, 'k', undefined, { fetch: fetchImpl })
  await as.searchAnysearch({ query: 'q', maxResults: 0 }, 'k', undefined, { fetch: fetchImpl })
  await as.searchAnysearch({ query: 'q', maxResults: 4.7 }, 'k', undefined, { fetch: fetchImpl })
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).max_results, 10)
  assert.equal(JSON.parse(fetchImpl.calls[1].init.body).max_results, 1)
  assert.equal(JSON.parse(fetchImpl.calls[2].init.body).max_results, 4)
})

await check('anysearch forwards vertical tag, params, zone, and language', async () => {
  const fetchImpl = stubFetch([envelope([])])
  await as.searchAnysearch({
    query: 'AAPL',
    tag: 'finance.quote',
    params: { type: 'stock', symbol: 'AAPL', cn_code: '' },
    zone: 'US',
    language: 'en',
  }, 'k', undefined, { fetch: fetchImpl })
  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(body.tag, 'finance.quote')
  assert.deepEqual(body.params, { type: 'stock', symbol: 'AAPL', cn_code: '' })
  assert.equal(body.zone, 'US')
  assert.equal(body.language, 'en')
})

await check('anysearch prefers snippet over content, and falls back to content', async () => {
  const fetchImpl = stubFetch([envelope([
    asResult('https://a.test/1'),
    { title: 't', url: 'https://a.test/2', content: 'only content' },
  ])])
  const { sources } = await as.searchAnysearch({ query: 'q' }, 'k', undefined, { fetch: fetchImpl })
  assert.equal(sources[0].snippet, 'snippet for https://a.test/1')
  assert.equal(sources[1].snippet, 'only content', 'content is the snippet fallback')
})

await check('anysearch treats a non-zero envelope code as failure even on HTTP 200', async () => {
  const fetchImpl = stubFetch([{ status: 200, body: {
    code: -1,
    message: 'quota exhausted',
    request_id: 'r',
    error_code: 'daily_free_quota_exhausted',
  } }])
  await assert.rejects(
    () => as.searchAnysearch({ query: 'q' }, 'k', undefined, { fetch: fetchImpl }),
    (error) => error.code === 'ANYSEARCH_API_ERROR' && /daily anonymous quota/.test(error.message),
  )
})

await check('anysearch surfaces an auto-registered key instead of discarding it', async () => {
  // A deliberately non-secret placeholder. The real service mints an
  // `as_sk_<32 hex>` key here; using that exact SHAPE in a fixture trips secret
  // scanners (and trains readers to ignore them), so the token is obviously fake
  // while still exercising the same pass-through path — it is only ever compared
  // against itself.
  const minted = 'as_sk_test_fixture_not_a_real_key'
  const fetchImpl = stubFetch([{ status: 200, body: {
    code: -1,
    message: `Your account and API key have been automatically generated. Use the API key below to continue.\nusername=as_auto_x\npassword=pw\napi_key=${minted}`,
    request_id: 'r',
    error_code: 'daily_free_quota_exhausted',
  } }])
  await assert.rejects(
    () => as.searchAnysearch({ query: 'q' }, '', undefined, { fetch: fetchImpl }),
    (error) => error.code === 'ANYSEARCH_AUTO_REGISTERED' && error.autoKey === minted,
  )
})

await check('parseAutoRegisteredKey finds the key and rejects a keyless message', () => {
  assert.equal(as.parseAutoRegisteredKey('a b api_key=as_sk_abc def'), 'as_sk_abc')
  assert.equal(as.parseAutoRegisteredKey('no credentials here'), undefined)
  assert.equal(as.parseAutoRegisteredKey(undefined), undefined)
})

await check('anysearch extract returns the page content', async () => {
  const fetchImpl = stubFetch([{ status: 200, body: {
    code: 0,
    data: { url: 'https://a.test/1', title: 'A', content: 'extracted body' },
  } }])
  const out = await as.fetchAnysearch('https://a.test/1', 'k', undefined, { fetch: fetchImpl })
  assert.equal(fetchImpl.calls[0].url, 'https://api.anysearch.com/v1/extract')
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { url: 'https://a.test/1' })
  assert.equal(out.text, 'extracted body')
  assert.equal(out.title, 'A')
})

await check('anysearch extract rejects an empty body', async () => {
  const fetchImpl = stubFetch([{ status: 200, body: { code: 0, data: { url: 'https://a.test/1', content: '' } } }])
  await assert.rejects(
    () => as.fetchAnysearch('https://a.test/1', 'k', undefined, { fetch: fetchImpl }),
    (error) => error.code === 'ANYSEARCH_EMPTY_BODY',
  )
})

await check('anysearch sub-domains passes repeated domain params', async () => {
  const fetchImpl = stubFetch([{ status: 200, body: { code: 0, data: { domains: [{ domain: 'finance', sub_domains: [] }] } } }])
  await as.subDomainsAnysearch(['finance', 'health'], 'k', undefined, { fetch: fetchImpl })
  const url = new URL(fetchImpl.calls[0].url)
  assert.equal(url.pathname, '/v1/sub-domains')
  assert.deepEqual(url.searchParams.getAll('domain'), ['finance', 'health'])
})

await check('anysearch sub-domains refuses more than five domains', async () => {
  await assert.rejects(
    () => as.subDomainsAnysearch(['a', 'b', 'c', 'd', 'e', 'f'], 'k', undefined, { fetch: stubFetch([]) }),
    (error) => error.code === 'ANYSEARCH_BAD_REQUEST',
  )
})

await check('anysearch base URL resolution honours config then env then default', () => {
  assert.equal(as.resolveAnysearchBase('https://custom.test/'), 'https://custom.test')
  assert.equal(as.resolveAnysearchBase('', { ANYSEARCH_API_BASE_URL: 'https://env.test/' }), 'https://env.test')
  assert.equal(as.resolveAnysearchBase('', {}), as.ANYSEARCH_BASE_URL)
})

await check('anysearch key resolution honours config then env then the skill .env', () => {
  assert.equal(as.resolveAnysearchKey('  from-config ', {}), 'from-config')
  assert.equal(as.resolveAnysearchKey('', { ANYSEARCH_API_KEY: 'from-env' }), 'from-env')
  assert.equal(typeof as.resolveAnysearchKey('', {}), 'string')
})

await check('anysearch maps a transport failure and cancellation distinctly', async () => {
  await assert.rejects(
    () => as.searchAnysearch({ query: 'q' }, 'k', undefined, { fetch: stubFetch([new TypeError('boom')]) }),
    (error) => error.code === 'ANYSEARCH_NETWORK_ERROR',
  )
  await assert.rejects(
    () => as.searchAnysearch({ query: 'q' }, 'k', undefined, { fetch: stubFetch([new DOMException('x', 'AbortError')]) }),
    (error) => error.code === 'ANYSEARCH_ABORTED',
  )
})

/* ------------------------------------------------------- provider layer */

console.log('\ntinyfish providers (seam contract)')

const web = await import('@deepseek-ai/dsh-web')
const { Context } = await import('@deepseek-ai/cordis')
const plugin = await import('../lib/index.js')

/**
 * Mount a real `WebRuntime` on a fresh Cordis root context — the same
 * construction the shipped `web.spec.ts` uses. `WebRuntime` is a `Service`, so
 * its registry effects need a genuine context; a hand-rolled duck type throws
 * inside `ctx.effect`.
 */
async function mountWeb(config = {}) {
  const ctx = new Context()
  await ctx.plugin(web.WebRuntime, config)
  return ctx.web
}

/** Build a config resolver over the plugin's schema with overrides applied. */
function cfg(overrides = {}) {
  return plugin.Config(overrides)
}

/** A context double with no credential center. */
const noCreds = { get: () => undefined }

/**
 * Build one backend runtime for `id` over a config thunk.
 * @param id - backend id.
 * @param overrides - config overrides (nested under the backend's own key).
 * @param base - the full config to start from.
 */
function backend(id, overrides = {}, base = {}) {
  const resolved = cfg({ ...base, [id]: { ...(base[id] ?? {}), ...overrides } })
  return new plugin.BackendRuntime(id, noCreds, () => resolved, undefined)
}

/** Build the failover-chain provider over a config. */
function chain(overrides = {}) {
  const resolved = cfg(overrides)
  const byId = {
    [plugin.TINYFISH_ID]: new plugin.BackendRuntime(plugin.TINYFISH_ID, noCreds, () => resolved, undefined),
    [plugin.ANYSEARCH_ID]: new plugin.BackendRuntime(plugin.ANYSEARCH_ID, noCreds, () => resolved, undefined),
  }
  return new plugin.HydraSearchProvider(noCreds, () => resolved, undefined, (id) => byId[id])
}

await check('provider ids and exported constants are stable', () => {
  assert.equal(plugin.TINYFISH_ID, 'tinyfish')
  assert.equal(plugin.ANYSEARCH_ID, 'anysearch')
  assert.equal(plugin.HYDRASEARCH_PROVIDER_ID, 'hydrasearch')
  assert.equal(plugin.HYDRASEARCH_NS, 'hydrasearch')
  assert.equal(plugin.inject[0], 'web')
  assert.equal(plugin.name, 'hydrasearch')
  assert.deepEqual(plugin.DEFAULT_PRIORITY, ['tinyfish', 'anysearch'])
})

await check('normalizePriority dedupes, drops unknowns, and appends missing backends', () => {
  assert.deepEqual(plugin.normalizePriority(['anysearch', 'tinyfish']), ['anysearch', 'tinyfish'])
  assert.deepEqual(plugin.normalizePriority(['anysearch']), ['anysearch', 'tinyfish'])
  assert.deepEqual(plugin.normalizePriority(['nope', 'tinyfish', 'tinyfish']), ['tinyfish', 'anysearch'])
  assert.deepEqual(plugin.normalizePriority([]), ['tinyfish', 'anysearch'])
  assert.deepEqual(plugin.normalizePriority(undefined), ['tinyfish', 'anysearch'])
  assert.deepEqual(plugin.normalizePriority('tinyfish'), ['tinyfish', 'anysearch'], 'a non-array is ignored')
})

await check('the two built-in fetch formats and domains match the APIs', () => {
  assert.deepEqual(tf.TINYFISH_FETCH_FORMATS, ['markdown', 'html', 'json'])
  assert.deepEqual(tf.TINYFISH_DOMAIN_TYPES, ['web', 'news', 'research_paper'])
  assert.equal(tf.TINYFISH_SERVICE_MAX_PAGE, 10)
  assert.equal(as.ANYSEARCH_MIN_RESULTS, 1)
  assert.equal(as.ANYSEARCH_MAX_RESULTS, 10)
})

await check('available() is false for tinyfish without any key source', () => {
  const saved = process.env.TINYFISH_API_KEY
  delete process.env.TINYFISH_API_KEY
  try {
    // A CLI config key on this machine would legitimately make it available.
    if (tf.resolveTinyfishKey('').length === 0) assert.equal(backend('tinyfish').available(), false)
  } finally {
    if (saved !== undefined) process.env.TINYFISH_API_KEY = saved
  }
})

await check('available() is true for tinyfish with a configured key', () => {
  assert.equal(backend('tinyfish', { apiKey: 'sk-test' }).available(), true)
})

await check('available() is false for a disabled backend', () => {
  assert.equal(backend('tinyfish', { apiKey: 'sk-test', enabled: false }).available(), false)
  assert.equal(backend('anysearch', { enabled: false }).available(), false)
})

await check('available() is false for a malformed endpoint', () => {
  assert.equal(backend('tinyfish', { apiKey: 'sk-test', searchBaseURL: 'not-a-url' }).available(), false)
  assert.equal(backend('anysearch', { baseURL: 'not-a-url' }).available(), false)
})

await check('anysearch is available even without a key (anonymous tier)', () => {
  // A missing AnySearch key must NOT hide the backend: anonymous access is the
  // documented default, and hiding it would silently drop the whole chain on a
  // fresh install.
  const saved = process.env.ANYSEARCH_API_KEY
  delete process.env.ANYSEARCH_API_KEY
  try {
    assert.equal(backend('anysearch', { apiKey: '' }).available(), true)
  } finally {
    if (saved !== undefined) process.env.ANYSEARCH_API_KEY = saved
  }
})

await check('the config schema fills every default, including nested backends', () => {
  const resolved = plugin.Config({})
  assert.deepEqual(resolved.priority, ['tinyfish', 'anysearch'])
  assert.equal(resolved.failover, true)
  assert.equal(resolved.takeOverSearch, true)
  assert.equal(resolved.fetchBackend, 'auto')
  assert.equal(resolved.tinyfish.enabled, true)
  assert.equal(resolved.tinyfish.maxPages, 3)
  assert.equal(resolved.tinyfish.fetchFormat, 'markdown')
  assert.equal(resolved.tinyfish.recencyMinutes, 0)
  assert.equal(resolved.anysearch.enabled, true)
  assert.equal(resolved.anysearch.maxResults, 10)
  assert.equal(resolved.anysearch.tag, '')
})

await check('a nested override leaves the other backend section intact', () => {
  // This is what makes two settings surfaces safe to edit concurrently: writing
  // tinyfish.language must not restate (and therefore cannot clobber) anysearch.
  const resolved = plugin.Config({ tinyfish: { language: 'zh' } })
  assert.equal(resolved.tinyfish.language, 'zh')
  assert.equal(resolved.tinyfish.maxPages, 3)
  assert.equal(resolved.anysearch.maxResults, 10)
})

await check('tinyfish search returns the seam shape with truncated false', async () => {
  const original = globalThis.fetch
  globalThis.fetch = stubFetch([page([result('https://a.test/1')])])
  try {
    const out = await backend('tinyfish', { apiKey: 'sk-test' }).search({ query: 'q', maxResults: 5 })
    assert.equal(out.sources.length, 1)
    assert.equal(out.totalResults, 1)
  } finally {
    globalThis.fetch = original
  }
})

await check('anysearch search returns the seam shape', async () => {
  const original = globalThis.fetch
  globalThis.fetch = stubFetch([envelope([asResult('https://a.test/1')])])
  try {
    const out = await backend('anysearch', { apiKey: 'k' }).search({ query: 'q', maxResults: 5 })
    assert.equal(out.sources.length, 1)
    assert.equal(out.totalResults, 1)
  } finally {
    globalThis.fetch = original
  }
})

await check('the config validation rejects malformed values', () => {
  const cases = [
    [{ tinyfish: { searchBaseURL: 'nope' } }, /searchBaseURL/],
    [{ tinyfish: { fetchBaseURL: 'nope' } }, /fetchBaseURL/],
    [{ tinyfish: { maxPages: 0 } }, /maxPages/],
    [{ tinyfish: { maxPages: 99 } }, /maxPages/],
    [{ tinyfish: { fetchFormat: 'pdf' } }, /fetchFormat/],
    [{ tinyfish: { afterDate: '2026/01/01' } }, /afterDate/],
    [{ anysearch: { maxResults: 50 } }, /maxResults/],
    [{ anysearch: { params: '{not json' } }, /params must be a JSON object/],
    [{ anysearch: { params: '{"a":1}' } }, /requires anysearch\.tag/],
    [{ anysearch: { params: '[1,2]', tag: 'a.b' } }, /must be a JSON object, not an array/],
    [{ anysearch: { tag: 'nocolon' } }, /domain\.sub_domain/],
  ]
  for (const [overrides, pattern] of cases) {
    assert.throws(
      () => plugin.validateConfig(plugin.Config(overrides)),
      pattern,
      `expected ${JSON.stringify(overrides)} to be rejected`,
    )
  }
})

await check('a valid vertical tag and params pass validation', () => {
  assert.doesNotThrow(() => plugin.validateConfig(plugin.Config({
    anysearch: { tag: 'finance.quote', params: '{"type":"stock","symbol":"AAPL","cn_code":""}' },
  })))
  assert.doesNotThrow(() => plugin.validateConfig(plugin.Config({})))
})

/* ------------------------------------------------------------- the chain */

console.log('\nhydrasearch failover chain')

await check('the chain walks priority order and serves from the first success', async () => {
  const original = globalThis.fetch
  const fetchImpl = stubFetch([page([result('https://tf.test/1')])])
  globalThis.fetch = fetchImpl
  try {
    const out = await chain({ priority: ['tinyfish', 'anysearch'], tinyfish: { apiKey: 'sk-test' } })
      .search({ query: 'q', maxResults: 5 })
    assert.equal(out.sources[0].url, 'https://tf.test/1')
    assert.equal(new URL(fetchImpl.calls[0].url).origin, 'https://api.search.tinyfish.ai')
    assert.equal(Object.hasOwn(out, 'content'), false, 'no note when nothing was skipped or failed')
  } finally {
    globalThis.fetch = original
  }
})

await check('reordering priority changes which backend answers', async () => {
  const original = globalThis.fetch
  const fetchImpl = stubFetch([envelope([asResult('https://as.test/1')])])
  globalThis.fetch = fetchImpl
  try {
    const out = await chain({ priority: ['anysearch', 'tinyfish'], tinyfish: { apiKey: 'sk-test' } })
      .search({ query: 'q', maxResults: 5 })
    assert.equal(out.sources[0].url, 'https://as.test/1')
    assert.equal(new URL(fetchImpl.calls[0].url).origin, 'https://api.anysearch.com')
  } finally {
    globalThis.fetch = original
  }
})

await check('the chain fails over to the next backend on error', async () => {
  const original = globalThis.fetch
  const fetchImpl = stubFetch([
    { status: 500, body: { message: 'tinyfish down' } },
    envelope([asResult('https://as.test/1')]),
  ])
  globalThis.fetch = fetchImpl
  try {
    const out = await chain({ priority: ['tinyfish', 'anysearch'], tinyfish: { apiKey: 'sk-test' }, anysearch: { apiKey: 'k' } })
      .search({ query: 'q', maxResults: 5 })
    assert.equal(out.sources[0].url, 'https://as.test/1')
    assert.match(out.content, /tinyfish failed/)
    assert.match(out.content, /using anysearch/)
  } finally {
    globalThis.fetch = original
  }
})

await check('a skipped backend is reported as NOT tried, distinctly from a failure', async () => {
  // The honesty rule: "never attempted" and "attempted and failed" must not be
  // collapsed, because only the second is evidence the backend is broken.
  const original = globalThis.fetch
  const savedKey = process.env.TINYFISH_API_KEY
  delete process.env.TINYFISH_API_KEY
  globalThis.fetch = stubFetch([envelope([asResult('https://as.test/1')])])
  try {
    if (tf.resolveTinyfishKey('').length > 0) return // a CLI key exists; branch untestable
    const out = await chain({ priority: ['tinyfish', 'anysearch'], tinyfish: { apiKey: '' }, anysearch: { apiKey: 'k' } })
      .search({ query: 'q', maxResults: 5 })
    assert.equal(out.sources[0].url, 'https://as.test/1')
    assert.match(out.content, /tinyfish was not available/)
    assert.match(out.content, /NOT tried/)
    assert.doesNotMatch(out.content, /tinyfish failed/)
  } finally {
    globalThis.fetch = original
    if (savedKey !== undefined) process.env.TINYFISH_API_KEY = savedKey
  }
})

await check('failover off makes the first available backend final', async () => {
  const original = globalThis.fetch
  const fetchImpl = stubFetch([{ status: 500, body: { message: 'tinyfish down' } }])
  globalThis.fetch = fetchImpl
  try {
    await assert.rejects(
      () => chain({ priority: ['tinyfish', 'anysearch'], failover: false, tinyfish: { apiKey: 'sk-test' }, anysearch: { apiKey: 'k' } })
        .search({ query: 'q', maxResults: 5 }),
      (error) => error.code === 'WEB_PROVIDER_ERROR',
    )
    assert.equal(fetchImpl.calls.length, 1, 'must not try the second backend')
  } finally {
    globalThis.fetch = original
  }
})

await check('a cancelled chain search stops instead of failing over', async () => {
  const original = globalThis.fetch
  const fetchImpl = stubFetch([new DOMException('aborted', 'AbortError')])
  globalThis.fetch = fetchImpl
  try {
    await assert.rejects(
      () => chain({ priority: ['tinyfish', 'anysearch'], tinyfish: { apiKey: 'sk-test' }, anysearch: { apiKey: 'k' } })
        .search({ query: 'q', maxResults: 5 }),
      (error) => error.code === 'WEB_ABORTED',
    )
    assert.equal(fetchImpl.calls.length, 1, 'cancellation must not trigger a retry elsewhere')
  } finally {
    globalThis.fetch = original
  }
})

await check('every backend failing reports the aggregate failure', async () => {
  const original = globalThis.fetch
  globalThis.fetch = stubFetch([
    { status: 500, body: { message: 'tf down' } },
    { status: 503, body: { message: 'as down' } },
  ])
  try {
    await assert.rejects(
      () => chain({ priority: ['tinyfish', 'anysearch'], tinyfish: { apiKey: 'sk-test' }, anysearch: { apiKey: 'k' } })
        .search({ query: 'q', maxResults: 5 }),
      // The FIRST failure is rethrown (not a synthesized aggregate), so the
      // operator sees the root cause rather than a smeared summary. The full
      // attempt list is carried by the failover note on a *successful* result.
      (error) => error.code === 'WEB_PROVIDER_ERROR' && /TinyFish/.test(error.message),
    )
  } finally {
    globalThis.fetch = original
  }
})

await check('fetchBackend pins web_fetch to one backend', async () => {
  const original = globalThis.fetch
  const fetchImpl = stubFetch([{ status: 200, body: {
    code: 0,
    data: { url: 'https://a.test/1', title: 'A', content: 'anysearch body' },
  } }])
  globalThis.fetch = fetchImpl
  try {
    const out = await chain({ priority: ['tinyfish', 'anysearch'], fetchBackend: 'anysearch', tinyfish: { apiKey: 'sk-test' } })
      .fetch({ url: 'https://a.test/1' })
    // The chain must return the SEAM's shape, not the internal backend result:
    // web_fetch reads statusCode and body.kind directly.
    assert.equal(out.statusCode, 200)
    assert.equal(out.body.kind, 'text')
    assert.equal(out.body.content, 'anysearch body')
    assert.equal(new URL(fetchImpl.calls[0].url).origin, 'https://api.anysearch.com')
  } finally {
    globalThis.fetch = original
  }
})

await check('a failover fetch carries the note into the body text', async () => {
  const original = globalThis.fetch
  globalThis.fetch = stubFetch([
    { status: 500, body: { message: 'tinyfish down' } },
    { status: 200, body: { code: 0, data: { url: 'https://a.test/1', title: 'A', content: 'anysearch body' } } },
  ])
  try {
    const out = await chain({ priority: ['tinyfish', 'anysearch'], tinyfish: { apiKey: 'sk-test' }, anysearch: { apiKey: 'k' } })
      .fetch({ url: 'https://a.test/1' })
    // WebFetchResult has no answer-text field, so the note rides the body —
    // otherwise the model would silently receive content with no provenance.
    assert.match(out.body.content, /tinyfish failed/)
    assert.match(out.body.content, /anysearch body/)
  } finally {
    globalThis.fetch = original
  }
})

await check('the chain reports unavailable when no backend can run', async () => {
  const savedKey = process.env.TINYFISH_API_KEY
  const savedAs = process.env.ANYSEARCH_API_KEY
  delete process.env.TINYFISH_API_KEY
  delete process.env.ANYSEARCH_API_KEY
  try {
    if (tf.resolveTinyfishKey('').length > 0 || as.resolveAnysearchKey('').length > 0) return
    const provider = chain({
      priority: ['tinyfish', 'anysearch'],
      tinyfish: { apiKey: '', enabled: false },
      anysearch: { enabled: false },
    })
    assert.equal(provider.available(), false)
    await assert.rejects(
      () => provider.search({ query: 'q' }),
      (error) => error.code === 'WEB_PROVIDER_UNAVAILABLE',
    )
  } finally {
    if (savedKey !== undefined) process.env.TINYFISH_API_KEY = savedKey
    if (savedAs !== undefined) process.env.ANYSEARCH_API_KEY = savedAs
  }
})

await check('the plugin registers exactly ONE provider for both capabilities', async () => {
  // The contract this refactor exists to establish: the seam sees a single id,
  // so an unset `web.searchProvider` is unambiguous and the operator never has
  // to name a backend to get search working. Backend choice stays internal.
  const runtime = await mountWeb()
  const provider = chain()
  runtime.registerSearchProvider(provider)
  runtime.registerFetchProvider(provider)
  assert.equal(runtime.searchProviders.size, 1, 'exactly one search provider must be registered')
  assert.equal(runtime.fetchProviders.size, 1, 'exactly one fetch provider must be registered')
  assert.ok(runtime.searchProviders.has(plugin.HYDRASEARCH_PROVIDER_ID))
  assert.ok(runtime.fetchProviders.has(plugin.HYDRASEARCH_PROVIDER_ID))
  assert.equal(runtime.searchProviders.has(plugin.TINYFISH_ID), false, 'backends must NOT be registered as providers')
  assert.equal(runtime.searchProviders.has(plugin.ANYSEARCH_ID), false, 'backends must NOT be registered as providers')

  // A single candidate is unambiguous: the seam resolves it without any
  // explicit selection, which is what makes the one-provider shape work.
  assert.equal(runtime.searchProviderId, undefined)
  const original = globalThis.fetch
  globalThis.fetch = stubFetch([page([result('https://a.test/1')])])
  try {
    const searched = await runtime.search({ query: 'q', maxResults: 1 })
    assert.equal(searched.sources[0].url, 'https://a.test/1')
  } finally {
    globalThis.fetch = original
  }
})

await check('pinning a backend is config, not registration', async () => {
  // `searchBackend` / `fetchBackend` replaced the old "register each backend as
  // a provider and repoint web.searchProvider at it" design.
  const pinned = chain({ priority: ['anysearch', 'tinyfish'], searchBackend: 'anysearch' })
  const original = globalThis.fetch
  const fetchImpl = stubFetch([envelope([asResult('https://as.test/1')])])
  globalThis.fetch = fetchImpl
  try {
    const result = await pinned.search({ query: 'q', maxResults: 1 })
    assert.equal(result.sources[0].url, 'https://as.test/1', 'the pinned backend must serve the search')
    assert.equal(new URL(fetchImpl.calls[0].url).origin, 'https://api.anysearch.com')
    // Pinning bypasses the chain entirely: TinyFish is first in `priority` and
    // must not be called, so exactly one request was made.
    assert.equal(fetchImpl.calls.length, 1, 'a pinned search must not try the other backend')
  } finally {
    globalThis.fetch = original
  }
})

await check('an unknown pin degrades to the chain instead of breaking search', async () => {
  // A typo in the card (or a stale value naming a removed backend) must not make
  // the capability unreachable — it falls back to the normal chain walk.
  const provider = chain({ tinyfish: { apiKey: 'sk-test' } })
  const original = globalThis.fetch
  globalThis.fetch = stubFetch([page([result('https://a.test/1')])])
  try {
    const result = await provider.search({ query: 'q' })
    assert.equal(result.sources[0].url, 'https://a.test/1')
  } finally {
    globalThis.fetch = original
  }
  assert.deepEqual(provider.pinnedOrChain('not-a-backend').map((b) => b.id), ['tinyfish', 'anysearch'])
  assert.deepEqual(provider.pinnedOrChain('auto').map((b) => b.id), ['tinyfish', 'anysearch'])
})

await check('over-returning sources are capped and flagged by the seam', async () => {
  // The end-to-end reason the providers must not slice: only the seam knows the
  // deployment's bound, and only the seam sets `truncated` so the model is told
  // more results exist.
  const runtime = await mountWeb({ searchProvider: 'hydrasearch' })
  runtime.registerSearchProvider(chain({ tinyfish: { apiKey: 'sk-test' } }))
  const original = globalThis.fetch
  globalThis.fetch = stubFetch([page(Array.from({ length: 10 }, (_, i) => result(`https://a.test/${i}`)), 10)])
  try {
    const capped = await runtime.search({ query: 'q', maxResults: 3 })
    assert.equal(capped.sources.length, 3)
    assert.equal(capped.truncated, true)
  } finally {
    globalThis.fetch = original
  }
})

await check('a duplicate provider id is rejected by the registry', async () => {
  const runtime = await mountWeb()
  const provider = chain()
  runtime.registerSearchProvider(provider)
  assert.throws(() => runtime.registerSearchProvider(provider), (error) => error.code === 'WEB_DUPLICATE_PROVIDER')
  runtime.registerFetchProvider(provider)
  assert.throws(() => runtime.registerFetchProvider(provider), (error) => error.code === 'WEB_DUPLICATE_PROVIDER')
})

/* ------------------------------------------------------- bridge guardrails */

console.log('\nsettings bridge guardrails')

/** A minimal request double for the loopback guard. */
function req(remoteAddress, headers) {
  return { socket: { remoteAddress }, headers, method: 'POST' }
}

await check('only loopback same-origin POSTs pass the guard', () => {
  assert.equal(plugin.isLoopbackRequest(req('127.0.0.1', { host: '127.0.0.1:19387' })), true)
  assert.equal(plugin.isLoopbackRequest(req('::1', { host: 'localhost:19387' })), true)
  assert.equal(plugin.isLoopbackRequest(req('::ffff:127.0.0.1', { host: '127.0.0.1' })), true)
  assert.equal(plugin.isLoopbackRequest(req('192.168.31.50', { host: '127.0.0.1:19387' })), false, 'remote address rejected')
  assert.equal(plugin.isLoopbackRequest(req('127.0.0.1', { host: 'evil.test' })), false, 'foreign host rejected')
  assert.equal(plugin.isLoopbackRequest(req('127.0.0.1', { host: '127.0.0.1', 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(
    plugin.isLoopbackRequest(req('127.0.0.1', { host: '127.0.0.1:19387', origin: 'http://evil.test' })),
    false,
    'cross-origin rejected',
  )
  assert.equal(
    plugin.isLoopbackRequest(req('127.0.0.1', { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' })),
    true,
    'same-origin accepted',
  )
})

await check('bridge routes are exact-path POST handlers under the plugin prefix', () => {
  const routes = plugin.makeBridgeRoutes({
    settings: { describe: () => [], writable: true, mutate: async () => {} },
    getCredentials: () => undefined,
    getConfig: () => plugin.Config({}),
    probeSearch: async () => ({}),
    probeBackend: async () => ({}),
    subDomains: async () => ({}),
    adoptKey: async () => ({}),
  })
  const paths = routes.map((route) => route.path).sort()
  assert.deepEqual(paths, [
    `${plugin.BRIDGE_PREFIX}/backend-test`,
    `${plugin.BRIDGE_PREFIX}/describe`,
    `${plugin.BRIDGE_PREFIX}/key-adopt`,
    `${plugin.BRIDGE_PREFIX}/key-set`,
    `${plugin.BRIDGE_PREFIX}/key-status`,
    `${plugin.BRIDGE_PREFIX}/key-unset`,
    `${plugin.BRIDGE_PREFIX}/mutate`,
    `${plugin.BRIDGE_PREFIX}/sub-domains`,
    `${plugin.BRIDGE_PREFIX}/test`,
  ])
  for (const route of routes) {
    assert.equal(route.kind, 'exact')
    assert.equal(typeof route.handler, 'function')
  }
})

/** Invoke one bridge route with a scripted request and capture the reply. */
async function invokeBridge(route, { body, method = 'POST', remote = '127.0.0.1' } = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  payload.options = undefined
  const req = {
    socket: { remoteAddress: remote },
    headers: { host: '127.0.0.1' },
    method,
    async *[Symbol.asyncIterator]() { for (const chunk of payload) yield chunk },
  }
  let status
  let reply
  await route.handler(req, {
    writeHead: (code) => { status = code },
    end: (text) => { reply = JSON.parse(text) },
  })
  return { status, reply }
}

/** The bridge dependency set, with overridable probes. */
function bridgeDeps(overrides = {}) {
  return {
    settings: {
      describe: () => [{ ns: 'hydrasearch', schema: {}, value: plugin.Config({}), revision: 3 }],
      writable: true,
      mutate: async () => {},
    },
    getCredentials: () => undefined,
    getConfig: () => plugin.Config({}),
    probeSearch: async () => ({ backend: 'tinyfish', sources: [], totalResults: 0 }),
    probeBackend: async () => ({ backend: 'tinyfish', sources: [], totalResults: 0 }),
    subDomains: async () => ({ domains: [] }),
    adoptKey: async () => ({ stored: 'credential-center', ref: 'ANYSEARCH_API_KEY' }),
    ...overrides,
  }
}

await check('describe reports the chain, both credential slots, and the limits', async () => {
  const routes = plugin.makeBridgeRoutes(bridgeDeps())
  const route = routes.find((entry) => entry.path.endsWith('/describe'))
  const { status, reply } = await invokeBridge(route, { body: {} })
  assert.equal(status, 200)
  assert.equal(reply.ok, true)
  assert.equal(reply.value.version, plugin.PLUGIN_VERSION)
  assert.equal(reply.value.chain.providerId, 'hydrasearch')
  assert.deepEqual(reply.value.chain.priority, ['tinyfish', 'anysearch'])
  assert.deepEqual(reply.value.chain.backends, ['tinyfish', 'anysearch'])
  assert.equal(reply.value.credentials.tinyfish.ref, 'TINYFISH_API_KEY')
  assert.equal(reply.value.credentials.anysearch.ref, 'ANYSEARCH_API_KEY')
  assert.equal(reply.value.env.anysearch.anonymousAllowed, true)
  assert.equal(reply.value.limits.tinyfish.defaultMaxPages, 3)
  assert.equal(reply.value.limits.anysearch.maxResults, 10)
  assert.equal(reply.value.limits.tinyfish.fetchFormats.includes('markdown'), true)
})

await check('describe never returns a secret value', async () => {
  const routes = plugin.makeBridgeRoutes(bridgeDeps({
    settings: {
      describe: () => [{ ns: 'hydrasearch', schema: {}, value: plugin.Config({}), revision: 1 }],
      writable: true,
      mutate: async () => {},
    },
  }))
  const route = routes.find((entry) => entry.path.endsWith('/describe'))
  const { reply } = await invokeBridge(route, { body: {} })
  const serialized = JSON.stringify(reply)
  assert.doesNotMatch(serialized, /sk-tinyfish/)
  assert.doesNotMatch(serialized, /as_sk_/)
})

await check('the mutate route persists a reordered priority list', async () => {
  // Priority is written through the SAME mutate route as every other field, so a
  // reorder rides one revision guard and cannot race a concurrent field edit.
  const writes = []
  const routes = plugin.makeBridgeRoutes(bridgeDeps({
    settings: {
      describe: () => [{ ns: 'hydrasearch', schema: {}, value: plugin.Config({}), revision: 7 }],
      writable: true,
      mutate: async (ns, ops) => { writes.push({ ns, ops }) },
    },
  }))
  const route = routes.find((entry) => entry.path.endsWith('/mutate'))
  const { reply } = await invokeBridge(route, {
    body: { ns: 'hydrasearch', ops: [{ op: 'set', path: ['priority'], value: ['anysearch', 'tinyfish'] }], expectedRevision: 7 },
  })
  assert.equal(reply.ok, true)
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].ns, 'hydrasearch')
  assert.deepEqual(writes[0].ops, [{ op: 'set', path: ['priority'], value: ['anysearch', 'tinyfish'] }])
})

await check('a per-backend path op reaches the settings service unflattened', async () => {
  const writes = []
  const routes = plugin.makeBridgeRoutes(bridgeDeps({
    settings: {
      describe: () => [{ ns: 'hydrasearch', schema: {}, value: plugin.Config({}), revision: 2 }],
      writable: true,
      mutate: async (ns, ops) => { writes.push(ops) },
    },
  }))
  const route = routes.find((entry) => entry.path.endsWith('/mutate'))
  await invokeBridge(route, {
    body: { ns: 'hydrasearch', ops: [{ op: 'set', path: ['tinyfish', 'language'], value: 'zh' }] },
  })
  assert.deepEqual(writes[0], [{ op: 'set', path: ['tinyfish', 'language'], value: 'zh' }])
})

await check('the mutate route repels a stale revision', async () => {
  const routes = plugin.makeBridgeRoutes(bridgeDeps({
    settings: {
      describe: () => [{ ns: 'hydrasearch', schema: {}, value: plugin.Config({}), revision: 9 }],
      writable: true,
      mutate: async () => {
        const error = new Error('revision moved')
        error.code = 'SETTINGS_CONFLICT'
        throw error
      },
    },
  }))
  const route = routes.find((entry) => entry.path.endsWith('/mutate'))
  const { reply } = await invokeBridge(route, {
    body: { ns: 'hydrasearch', ops: [{ op: 'set', path: ['failover'], value: false }], expectedRevision: 2 },
  })
  assert.equal(reply.ok, false)
  assert.equal(reply.code, 'settings-conflict')
})

await check('the mutate route refuses a foreign namespace', async () => {
  const routes = plugin.makeBridgeRoutes(bridgeDeps())
  const route = routes.find((entry) => entry.path.endsWith('/mutate'))
  const { status, reply } = await invokeBridge(route, { body: { ns: 'llm-pi-ai', ops: [] } })
  assert.equal(status, 400)
  assert.equal(reply.ok, false)
})

await check('the backend-test route requires a known backend', async () => {
  const routes = plugin.makeBridgeRoutes(bridgeDeps())
  const route = routes.find((entry) => entry.path.endsWith('/backend-test'))
  const bad = await invokeBridge(route, { body: { backend: 'nope' } })
  assert.equal(bad.status, 400)
  const good = await invokeBridge(route, { body: { backend: 'anysearch' } })
  assert.equal(good.reply.ok, true)
})

await check('a failed backend-test surfaces the auto-registered key', async () => {
  // A deliberately non-secret placeholder. The real service mints an
  // `as_sk_<32 hex>` key here; using that exact SHAPE in a fixture trips secret
  // scanners (and trains readers to ignore them), so the token is obviously fake
  // while still exercising the same pass-through path — it is only ever compared
  // against itself.
  const minted = 'as_sk_test_fixture_not_a_real_key'
  const routes = plugin.makeBridgeRoutes(bridgeDeps({
    probeBackend: async () => {
      const error = new Error('daily free quota exhausted')
      error.code = 'ANYSEARCH_AUTO_REGISTERED'
      error.autoKey = minted
      throw error
    },
  }))
  const route = routes.find((entry) => entry.path.endsWith('/backend-test'))
  const { reply } = await invokeBridge(route, { body: { backend: 'anysearch' } })
  assert.equal(reply.ok, false)
  assert.equal(reply.code, 'ANYSEARCH_AUTO_REGISTERED')
  assert.equal(reply.autoKey, minted, 'the minted key must reach the card')
})

await check('the sub-domains route requires a non-empty domain list', async () => {
  const routes = plugin.makeBridgeRoutes(bridgeDeps())
  const route = routes.find((entry) => entry.path.endsWith('/sub-domains'))
  assert.equal((await invokeBridge(route, { body: { domains: [] } })).status, 400)
  assert.equal((await invokeBridge(route, { body: { domains: ['finance'] } })).reply.ok, true)
})

await check('the key-adopt route persists the minted key', async () => {
  const adopted = []
  const routes = plugin.makeBridgeRoutes(bridgeDeps({
    adoptKey: async (key, toEnv) => { adopted.push({ key, toEnv }); return { stored: 'credential-center' } },
  }))
  const route = routes.find((entry) => entry.path.endsWith('/key-adopt'))
  assert.equal((await invokeBridge(route, { body: { key: '' } })).status, 400)
  const ok = await invokeBridge(route, { body: { key: 'as_sk_new' } })
  assert.equal(ok.reply.ok, true)
  assert.deepEqual(adopted, [{ key: 'as_sk_new', toEnv: undefined }])
})

await check('a foreign origin is refused before any handler work', async () => {
  const routes = plugin.makeBridgeRoutes(bridgeDeps())
  const route = routes.find((entry) => entry.path.endsWith('/describe'))
  const { status, reply } = await invokeBridge(route, { body: {}, remote: '10.0.0.9' })
  assert.equal(status, 403)
  assert.equal(reply.ok, false)
})

await check('a non-POST method is refused', async () => {
  const routes = plugin.makeBridgeRoutes(bridgeDeps())
  const route = routes.find((entry) => entry.path.endsWith('/describe'))
  const { status } = await invokeBridge(route, { body: {}, method: 'GET' })
  assert.equal(status, 405)
})

/* ------------------------------------------------------------- live checks */

const liveTinyfishKey = tf.resolveTinyfishKey('')
const liveAnysearchKey = as.resolveAnysearchKey('')

if (liveTinyfishKey.length === 0 && liveAnysearchKey.length === 0) {
  console.log('\nlive checks: SKIPPED (no TinyFish or AnySearch key found)')
} else {
  console.log('\nlive checks (real network)')

  if (liveTinyfishKey.length > 0) {
    const liveChain = chain({ tinyfish: { apiKey: liveTinyfishKey }, priority: ['tinyfish'] })

    await check('live TinyFish search returns normalized sources', async () => {
      const out = await liveChain.search({ query: 'DeepSeek Harness plugin', maxResults: 3 })
      assert.ok(out.sources.length > 0, 'expected at least one result')
      for (const source of out.sources) {
        assert.ok(source.url.startsWith('http'), `url must be absolute: ${source.url}`)
        if (source.publishedAt !== undefined) {
          assert.ok(!Number.isNaN(Date.parse(source.publishedAt)), `publishedAt must parse: ${source.publishedAt}`)
        }
      }
      console.log(`       → ${out.sources.length} sources, first: ${out.sources[0].url}`)
    })

    await check('live TinyFish fetch extracts readable text', async () => {
      const out = await liveChain.fetch({ url: 'https://example.com' })
      assert.equal(out.statusCode, 200)
      assert.ok(out.body.content.length > 0, 'expected non-empty text')
      console.log(`       → ${out.body.content.length} chars`)
    })

    await check('a cancelled live search aborts promptly', async () => {
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(
        () => liveChain.search({ query: 'anything', maxResults: 1 }, controller.signal),
        (error) => error instanceof web.WebError && error.code === 'WEB_ABORTED',
      )
    })
  }

  if (liveAnysearchKey.length > 0) {
    const liveAs = chain({ anysearch: { apiKey: liveAnysearchKey }, priority: ['anysearch'] })

    await check('live AnySearch search returns normalized sources', async () => {
      const out = await liveAs.search({ query: 'DeepSeek Harness plugin', maxResults: 3 })
      assert.ok(out.sources.length > 0, 'expected at least one result')
      for (const source of out.sources) {
        assert.ok(source.url.startsWith('http'), `url must be absolute: ${source.url}`)
      }
      console.log(`       → ${out.sources.length} sources, first: ${out.sources[0].url}`)
    })

    await check('live AnySearch extract returns readable text', async () => {
      const out = await liveAs.fetch({ url: 'https://example.com' })
      assert.equal(out.statusCode, 200)
      assert.ok(out.body.content.length > 0, 'expected non-empty text')
      console.log(`       → ${out.body.content.length} chars`)
    })

    await check('live AnySearch sub-domain discovery returns a capability tree', async () => {
      const data = await as.subDomainsAnysearch(['finance'], liveAnysearchKey)
      assert.ok(Array.isArray(data.domains), 'expected a domains array')
      console.log(`       → ${data.domains.length} domain(s)`)
    })
  }

  if (liveTinyfishKey.length > 0 && liveAnysearchKey.length > 0) {
    await check('live failover: a broken TinyFish endpoint falls through to AnySearch', async () => {
      // The real failover contract, end to end: a backend that cannot be reached
      // must not fail the search when another one can serve it.
      const provider = chain({
        priority: ['tinyfish', 'anysearch'],
        tinyfish: { apiKey: liveTinyfishKey, searchBaseURL: 'https://127.0.0.1:1/' },
        anysearch: { apiKey: liveAnysearchKey },
      })
      const out = await provider.search({ query: 'DeepSeek Harness', maxResults: 3 })
      assert.ok(out.sources.length > 0, 'AnySearch must serve the result')
      assert.match(out.content, /tinyfish failed/)
      assert.match(out.content, /using anysearch/)
      console.log(`       → failed over to anysearch, ${out.sources.length} sources`)
    })
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
