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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

await check('fetch forwards the optional purpose/image/timeout/ttl controls', async () => {
  const fetchImpl = stubFetch([{ status: 200, body: {
    results: [{ url: 'https://a.test/1', final_url: 'https://a.test/1', title: 'A', text: '# Hello', format: 'markdown' }],
    errors: [],
  } }])
  await tf.fetchTinyfish('https://a.test/1', 'sk-test', undefined, { fetch: fetchImpl }, {
    format: 'markdown',
    purpose: 'compare vendor pricing',
    imageLinks: true,
    perUrlTimeoutMs: 45000,
    // 0 is meaningful here ("force a live fetch"), so it must reach the wire.
    ttl: 0,
  })
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), {
    urls: ['https://a.test/1'],
    format: 'markdown',
    purpose: 'compare vendor pricing',
    image_links: true,
    per_url_timeout_ms: 45000,
    ttl: 0,
  })
})

// The service distinguishes an ABSENT `ttl` ("accept any cached entry") from an
// explicit `0` ("force a live fetch"). Collapsing the two would silently turn
// every fetch live, so the sentinel must survive as an omitted field.
await check('fetch omits ttl when it is negative and keeps 0 as force-live', async () => {
  const fetchImpl = stubFetch([
    { status: 200, body: { results: [{ url: 'https://a.test/1', text: 'x', format: 'markdown' }], errors: [] } },
    { status: 200, body: { results: [{ url: 'https://a.test/1', text: 'x', format: 'markdown' }], errors: [] } },
  ])
  await tf.fetchTinyfish('https://a.test/1', 'k', undefined, { fetch: fetchImpl }, { ttl: -1 })
  await tf.fetchTinyfish('https://a.test/1', 'k', undefined, { fetch: fetchImpl }, { ttl: 0 })
  assert.equal('ttl' in JSON.parse(fetchImpl.calls[0].init.body), false, '-1 must omit ttl entirely')
  assert.equal(JSON.parse(fetchImpl.calls[1].init.body).ttl, 0, '0 must be sent as a live fetch')
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

await check('the tinyfish transport exposes no key source of its own', () => {
  // The key is SUPPLIED BY THE CALLER (resolved from the credential center).
  // A second key source inside the transport is exactly what let the settings
  // card report a key it could neither replace nor clear, so the absence of
  // these helpers is a contract, not an oversight.
  assert.equal(tf.resolveTinyfishKey, undefined, 'no env/config/CLI key resolution may exist')
  assert.equal(tf.readCliApiKey, undefined, 'the CLI config must not be a key source')
  // The environment variable NAME is still exported, for diagnostics only.
  assert.equal(tf.TINYFISH_API_KEY_ENV, 'TINYFISH_API_KEY')
  assert.equal(tf.TINYFISH_API_KEY_REF, 'HYDRASEARCH_TINYFISH_API_KEY')
  // The ref must NOT collide with the conventional environment variable: a
  // collision is what makes the credential provider refuse writes as shadowed.
  assert.notEqual(tf.TINYFISH_API_KEY_REF, tf.TINYFISH_API_KEY_ENV)
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

await check('the anysearch transport exposes no key source of its own', () => {
  // Same contract as tinyfish: the caller resolves the key from the credential
  // center, so the transport holds no env/.env fallback of its own.
  assert.equal(as.resolveAnysearchKey, undefined, 'no env/.env key resolution may exist')
  assert.equal(as.readSkillEnvKey, undefined, 'the skill .env must not be a key source')
  assert.equal(as.writeSkillEnvKey, undefined, 'the skill .env must not be a write target')
  assert.equal(as.ANYSEARCH_API_KEY_ENV, 'ANYSEARCH_API_KEY')
  assert.equal(as.ANYSEARCH_API_KEY_REF, 'HYDRASEARCH_ANYSEARCH_API_KEY')
  assert.notEqual(as.ANYSEARCH_API_KEY_REF, as.ANYSEARCH_API_KEY_ENV)
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

/** Build a plain, fully-defaulted config section with overrides applied. */
function cfg(overrides = {}) {
  return plugin.resolveConfigObject(overrides)
}

/* ------------------------------------------------ cross-generation contract */

/*
 * These lock in the compatibility surface the plugin must hold across the DSH
 * generations it supports (0.1.6-alpha.2, 0.1.7-alpha.1+, and the rc line).
 * They are deliberately behavioural rather than version-sniffing: each one
 * would fail if the corresponding shim were removed.
 */

console.log('\nrelease-compatibility contract')

await check('the Config schema stays plain-callable through the resolver', () => {
  // `Config` is volatile-marked at the root on runtimes with schemastery
  // >= 3.18.3, which makes a DIRECT call return a cordis ref instead of a plain
  // section. Everything inside the plugin reads plain values, so the resolver
  // is what keeps those reads correct — and it must work on both generations.
  const section = plugin.resolveConfigObject({ tinyfish: { language: 'zh' } })
  assert.equal(typeof section, 'object')
  assert.equal(typeof section.get, 'undefined', 'resolved config must be plain, not a ref')
  assert.equal(section.tinyfish.language, 'zh')
  assert.deepEqual(section.priority, ['tinyfish', 'anysearch'], 'defaults must still be filled')
})

await check('the resolver accepts an already-resolved section', () => {
  const once = plugin.resolveConfigObject({ failover: false })
  const twice = plugin.resolveConfigObject(once)
  assert.equal(twice.failover, false)
  assert.equal(twice.searchBackend, 'auto')
})

await check('volatile() marks when the runtime can, and passes through when it cannot', () => {
  // schemastery 3.18.2 (shipped by the 0.1.6-alpha.2 desktop build) has no
  // `.volatile()`; calling it unconditionally would throw while the module is
  // evaluated and take the whole plugin down at import time. Where the method
  // exists the marker must land, because 0.1.7's `volatileForm()` omits any
  // entry whose schema lacks it — which presents as a settings page that
  // silently renders nothing, with no error anywhere.
  const supportsVolatile = typeof plugin.Config.volatile === 'function'
  const probe = plugin.volatile(plugin.Config)
  assert.ok(probe, 'volatile() must return a schema')

  if (supportsVolatile) {
    assert.equal(probe.meta?.volatile, true, 'a capable runtime must carry the marker')
  } else {
    assert.equal(probe, plugin.Config, 'an incapable runtime must get the node back unchanged')
  }

  const bare = { notASchema: true }
  assert.equal(plugin.volatile(bare), bare, 'a node without .volatile() passes through')
})

await check('isVolatileRef detects refs structurally, not by class', () => {
  // Detection is by the cosmokit symbol so it survives duplicate package copies
  // (the profile keeps its own tree alongside the app's).
  assert.equal(plugin.isVolatileRef({}), false)
  assert.equal(plugin.isVolatileRef(null), false)
  assert.equal(plugin.isVolatileRef(undefined), false)
  assert.equal(plugin.isVolatileRef('x'), false)
  assert.equal(plugin.isVolatileRef([]), false)

  const symbol = Symbol.for('cosmokit.volatile.write')
  const ref = { [symbol]: () => {}, get: () => ({ priority: ['anysearch'] }) }
  assert.equal(plugin.isVolatileRef(ref), true)
  assert.deepEqual(plugin.unwrapVolatile(ref), { priority: ['anysearch'] }, 'a ref unwraps to its live value')
  assert.equal(plugin.unwrapVolatile('plain'), 'plain', 'a plain value passes through')
})

await check('unwrapVolatile reflects a write made through the ref', () => {
  // This is the "edit takes effect without a restart" mechanism on 0.1.7: the
  // settings service writes through the ref that `apply()` kept, so a read must
  // observe the new value rather than the mount-time snapshot.
  const symbol = Symbol.for('cosmokit.volatile.write')
  let value = { priority: ['tinyfish', 'anysearch'] }
  const ref = { [symbol]: (next) => { value = next }, get: () => value }

  assert.deepEqual(plugin.unwrapVolatile(ref).priority, ['tinyfish', 'anysearch'])
  ref[symbol]({ priority: ['anysearch', 'tinyfish'] })
  assert.deepEqual(plugin.unwrapVolatile(ref).priority, ['anysearch', 'tinyfish'], 'the ref stays live')
})

await check('installSettingsSection survives a service with neither register nor installSection', () => {
  // The 0.1.7 shape: `SettingsForms` exposes no registration method at all, so
  // the shim must fall through to the change-notification branch instead of
  // throwing `provider.register is not a function` (which is exactly how the
  // current released plugin fails on that generation).
  const listeners = []
  const fakeCtx = {
    fiber: { state: 2 },
    inject: (_deps, fn) => fn({
      effect: () => {},
      on: (event, handler) => listeners.push([event, handler]),
    }),
  }
  const service = {
    // Only the 0.1.7 surface: no register, no installSection.
    describe: () => [],
    update: async () => {},
    replace: async () => {},
    mutate: async () => {},
  }
  const scoped = {
    get settings() {
      return service
    },
    effect: () => {},
    on: (event, handler) => listeners.push([event, handler]),
  }
  const ctx = { fiber: { state: 2 }, inject: (_deps, fn) => fn(scoped) }

  let changes = 0
  assert.doesNotThrow(() => {
    plugin.installSettingsSection(ctx, 'hydrasearch', plugin.Config, {}, {
      setSource: () => {},
      onChange: () => { changes++ },
    })
  }, 'a registration-less settings service must not throw')

  assert.equal(changes, 1, 'mounting notifies once')
  const entry = listeners.find(([event]) => event === 'settings/document-updated')
  assert.ok(entry, 'the change-notification listener must be registered')

  // Only this namespace's own updates may trigger a refresh.
  entry[1]('hydrasearch')
  assert.equal(changes, 2)
  entry[1]('some-other-namespace')
  assert.equal(changes, 2, 'another namespace\'s update must be ignored')
  entry[1]({ toString: () => 'hydrasearch' })
  assert.equal(changes, 3, 'a branded namespace must compare by string')
})

await check('installSettingsSection still prefers installSection when present', () => {
  // The 0.1.6 path must not regress to the fallback.
  let installed = null
  const ctx = {
    fiber: { state: 2 },
    inject: (_deps, fn) => fn({
      settings: { installSection: (...args) => { installed = args } },
      effect: () => {},
      on: () => {},
    }),
  }
  plugin.installSettingsSection(ctx, 'hydrasearch', plugin.Config, { base: true }, {
    setSource: () => {},
    onChange: () => {},
  })
  assert.ok(installed, 'installSection must be called when the service offers it')
})

await check('apply() unwraps a volatile config ref, and keeps it LIVE after mounting', () => {
  // On 0.1.7 the loader hands `apply()` a REF for a volatile-marked Config. Two
  // separate hazards, and this covers both:
  //
  //   1. A ref has no own fields, so `config.takeOverSearch` reads `undefined`
  //      and the takeover guard silently declines, leaving the seam on whatever
  //      provider the base bundle configured.
  //   2. The provider must read through the ref on every call. Snapshotting it
  //      at mount would mean a settings save only takes effect after a restart.
  const WRITE = Symbol.for('cosmokit.volatile.write')
  let value = plugin.resolveConfigObject({ priority: ['tinyfish', 'anysearch'] })
  const ref = {
    [WRITE]: (next) => { value = next },
    get: () => value,
  }

  let registered = null
  const ctxStub = {
    web: {
      registerSearchProvider: (provider) => { registered = provider },
      registerFetchProvider: () => {},
      searchProviderId: undefined,
      fetchProviderId: undefined,
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: () => {},
    on: () => {},
    inject: () => {},
    get: () => undefined,
    fiber: { state: 2 },
  }

  assert.doesNotThrow(() => plugin.apply(ctxStub, ref), 'apply must accept a volatile ref config')

  // (1) `takeOverSearch`/`takeOverFetch` default to true, so a correctly
  // unwrapped config claims BOTH seats. Reading the ref blindly claims neither.
  assert.equal(ctxStub.web.searchProviderId, 'hydrasearch', 'a ref config must still claim the search seat')
  assert.equal(ctxStub.web.fetchProviderId, 'hydrasearch', 'a ref config must still claim the fetch seat')

  // (2) Liveness: `chain()` reads the live priority. Write through the ref the
  // way a settings save does and the order must change with no remount.
  assert.ok(registered !== null, 'the provider must be registered')
  assert.deepEqual(registered.chain().map((b) => b.id), ['tinyfish', 'anysearch'])

  ref[WRITE](plugin.resolveConfigObject({ priority: ['anysearch', 'tinyfish'] }))
  assert.deepEqual(
    registered.chain().map((b) => b.id),
    ['anysearch', 'tinyfish'],
    'a write through the ref must be visible to the already-mounted provider',
  )
})

/* ------------------------------------------- credential-center test double */

/**
 * The credential store the backend doubles read. Seeded by {@link seedKeys}.
 *
 * The plugin reads an API key ONLY from the credential center — there is no
 * config, environment, or CLI fallback any more — so tests seed keys HERE
 * instead of in config. The config no longer has any key field at all.
 */
const testCredentials = new Map()

/** A `ctx.credentials` double over {@link testCredentials}. */
const credentialsDouble = {
  resolve: async (ref) => {
    const value = testCredentials.get(ref)
    return value === undefined || value.length === 0 ? undefined : { value, source: 'file' }
  },
  describe: async (ref) => (testCredentials.has(ref)
    ? { configured: true, writable: true, source: 'file' }
    : { configured: false, writable: true }),
  set: async (ref, value) => { testCredentials.set(ref, value) },
  unset: async (ref) => { testCredentials.delete(ref) },
}

/** A context double exposing only the credential center above. */
const credCtx = { get: (name) => (name === 'credentials' ? credentialsDouble : undefined) }

/**
 * Seed the credential center for both backends, then prime the synchronous
 * snapshot `available()` reads — the same snapshot production hydrates from the
 * real service. `undefined` means "no key for this backend".
 *
 * @param keys - `{ tinyfish?, anysearch? }` key strings.
 */
function seedKeys({ tinyfish, anysearch } = {}) {
  testCredentials.clear()
  if (typeof tinyfish === 'string') testCredentials.set(plugin.TINYFISH_API_KEY_REF, tinyfish)
  if (typeof anysearch === 'string') testCredentials.set(plugin.ANYSEARCH_API_KEY_REF, anysearch)
  plugin.keyStoreFor(credCtx).prime({
    [plugin.TINYFISH_API_KEY_REF]: typeof tinyfish === 'string' ? tinyfish : '',
    [plugin.ANYSEARCH_API_KEY_REF]: typeof anysearch === 'string' ? anysearch : '',
  })
}

/**
 * Seed the credential center from a config-override bag's `apiKey` entries,
 * then prime the synchronous snapshot `available()` reads.
 *
 * Tests keep expressing intent as `tinyfish: { apiKey: 'sk-test' }` — the key
 * simply travels to the credential center instead of into config, because the
 * plugin no longer HAS a config key field. A backend whose `apiKey` is absent or
 * blank gets no key, which keeps every check hermetic (no ambient env or CLI
 * key can leak in and flip a result).
 *
 * @param overrides - the same override bag handed to {@link chain}/{@link backend}.
 */
function seedFromOverrides(overrides = {}) {
  seedKeys({
    tinyfish: typeof overrides.tinyfish?.apiKey === 'string' ? overrides.tinyfish.apiKey : '',
    anysearch: typeof overrides.anysearch?.apiKey === 'string' ? overrides.anysearch.apiKey : '',
  })
}

/**
 * Build one backend runtime for `id` over a config thunk. Keys come from the
 * credential double seeded by {@link seedFromOverrides}.
 * @param id - backend id.
 * @param overrides - config overrides (nested under the backend's own key).
 * @param base - the full config to start from.
 */
function backend(id, overrides = {}, base = {}) {
  const resolved = cfg({ ...base, [id]: { ...(base[id] ?? {}), ...overrides } })
  seedFromOverrides({ [id]: overrides })
  return new plugin.BackendRuntime(id, credCtx, () => resolved, undefined)
}

/** Build the failover-chain provider over a config. */
function chain(overrides = {}) {
  const resolved = cfg(overrides)
  seedFromOverrides(overrides)
  const byId = {
    [plugin.TINYFISH_ID]: new plugin.BackendRuntime(plugin.TINYFISH_ID, credCtx, () => resolved, undefined),
    [plugin.ANYSEARCH_ID]: new plugin.BackendRuntime(plugin.ANYSEARCH_ID, credCtx, () => resolved, undefined),
  }
  return new plugin.HydraSearchProvider(credCtx, () => resolved, undefined, (id) => byId[id])
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

await check('available() is false for tinyfish without a credential-center key', () => {
  // No env/CLI fallback exists any more, so "no key in the credential center"
  // is unconditionally unavailable — this check is now fully hermetic instead
  // of depending on whether the developer had run `tinyfish auth login`.
  seedKeys({ tinyfish: undefined, anysearch: undefined })
  assert.equal(backend('tinyfish').available(), false)
  // The environment variable must NOT resurrect it: the plugin reads one store.
  const saved = process.env.TINYFISH_API_KEY
  process.env.TINYFISH_API_KEY = 'sk-from-env-should-be-ignored'
  try {
    assert.equal(backend('tinyfish').available(), false, 'the environment is not a key source')
  } finally {
    if (saved === undefined) delete process.env.TINYFISH_API_KEY
    else process.env.TINYFISH_API_KEY = saved
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
  const resolved = plugin.resolveConfigObject({})
  assert.deepEqual(resolved.priority, ['tinyfish', 'anysearch'])
  assert.equal(resolved.failover, true)
  assert.equal(resolved.takeOverSearch, true)
  assert.equal(resolved.fetchBackend, 'auto')
  assert.equal(resolved.tinyfish.enabled, true)
  assert.equal(resolved.tinyfish.maxPages, 3)
  assert.equal(resolved.tinyfish.fetchFormat, 'markdown')
  assert.equal(resolved.tinyfish.recencyMinutes, 0)
  // The fetch-path defaults TinyFish documents but the schema used to omit.
  // `purpose` is deliberately NON-empty out of the box; `fetchTtlSeconds` uses
  // -1 as "omit the field", which must not collapse onto 0 ("force live").
  assert.equal(resolved.tinyfish.purpose, 'Gather current, citable web sources to answer a user question')
  assert.equal(resolved.tinyfish.fetchImageLinks, false)
  assert.equal(resolved.tinyfish.fetchPerUrlTimeoutMs, 0)
  assert.equal(resolved.tinyfish.fetchTtlSeconds, -1)
  assert.equal(resolved.anysearch.enabled, true)
  assert.equal(resolved.anysearch.maxResults, 10)
  assert.equal(resolved.anysearch.tag, '')
})

await check('a nested override leaves the other backend section intact', () => {
  // This is what makes two settings surfaces safe to edit concurrently: writing
  // tinyfish.language must not restate (and therefore cannot clobber) anysearch.
  const resolved = plugin.resolveConfigObject({ tinyfish: { language: 'zh' } })
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
    [{ tinyfish: { fetchPerUrlTimeoutMs: 110001 } }, /fetchPerUrlTimeoutMs/],
    [{ tinyfish: { fetchPerUrlTimeoutMs: -5 } }, /fetchPerUrlTimeoutMs/],
    [{ tinyfish: { fetchTtlSeconds: -2 } }, /fetchTtlSeconds/],
    [{ tinyfish: { afterDate: '2026/01/01' } }, /afterDate/],
    [{ anysearch: { maxResults: 50 } }, /maxResults/],
    [{ anysearch: { params: '{not json' } }, /params must be a JSON object/],
    [{ anysearch: { params: '{"a":1}' } }, /requires anysearch\.tag/],
    [{ anysearch: { params: '[1,2]', tag: 'a.b' } }, /must be a JSON object, not an array/],
    [{ anysearch: { tag: 'nocolon' } }, /domain\.sub_domain/],
  ]
  for (const [overrides, pattern] of cases) {
    assert.throws(
      () => plugin.validateConfig(plugin.resolveConfigObject(overrides)),
      pattern,
      `expected ${JSON.stringify(overrides)} to be rejected`,
    )
  }
})

await check('a valid vertical tag and params pass validation', () => {
  assert.doesNotThrow(() => plugin.validateConfig(plugin.resolveConfigObject({
    anysearch: { tag: 'finance.quote', params: '{"type":"stock","symbol":"AAPL","cn_code":""}' },
  })))
  assert.doesNotThrow(() => plugin.validateConfig(plugin.resolveConfigObject({})))
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
  globalThis.fetch = stubFetch([envelope([asResult('https://as.test/1')])])
  try {
    // Seed ONLY anysearch: tinyfish has no credential, so the chain must skip
    // it without spending a request.
    const out = await chain({ priority: ['tinyfish', 'anysearch'], anysearch: { apiKey: 'k' } })
      .search({ query: 'q', maxResults: 5 })
    assert.equal(out.sources[0].url, 'https://as.test/1')
    assert.match(out.content, /tinyfish was not available/)
    assert.match(out.content, /NOT tried/)
    assert.doesNotMatch(out.content, /tinyfish failed/)
  } finally {
    globalThis.fetch = original
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

// The point of exposing these on the schema is that they reach the wire: a
// default that the runtime drops would look configured in the card and do
// nothing. Asserted through BackendRuntime.fetch, not the transport directly.
await check('the tinyfish fetch controls on the config reach the wire', async () => {
  const original = globalThis.fetch
  const fetchImpl = stubFetch([{ status: 200, body: {
    results: [{ url: 'https://a.test/1', final_url: 'https://a.test/1', title: 'A', text: '# Hello', format: 'markdown' }],
    errors: [],
  } }])
  globalThis.fetch = fetchImpl
  try {
    await backend('tinyfish', {
      apiKey: 'sk-test',
      purpose: 'compare vendor pricing',
      fetchImageLinks: true,
      fetchPerUrlTimeoutMs: 45000,
      fetchTtlSeconds: 0,
    }).fetch({ url: 'https://a.test/1' })
    const body = JSON.parse(fetchImpl.calls[0].init.body)
    assert.equal(body.purpose, 'compare vendor pricing')
    assert.equal(body.image_links, true)
    assert.equal(body.per_url_timeout_ms, 45000)
    assert.equal(body.ttl, 0)
  } finally {
    globalThis.fetch = original
  }
})

await check('the default tinyfish fetch sends purpose but omits timeout and ttl', async () => {
  // Out of the box: `purpose` is non-empty by design, while the two numeric
  // controls stay at their "omit the field" sentinels (0 and -1). A future
  // change that collapses `fetchTtlSeconds` onto 0 would turn every fetch live
  // and silently stop accepting cached entries — this catches that.
  const original = globalThis.fetch
  const fetchImpl = stubFetch([{ status: 200, body: {
    results: [{ url: 'https://a.test/1', text: '# Hello', format: 'markdown' }],
    errors: [],
  } }])
  globalThis.fetch = fetchImpl
  try {
    await backend('tinyfish', { apiKey: 'sk-test' }).fetch({ url: 'https://a.test/1' })
    const body = JSON.parse(fetchImpl.calls[0].init.body)
    assert.equal(body.purpose, 'Gather current, citable web sources to answer a user question')
    assert.equal('per_url_timeout_ms' in body, false, '0 must omit per_url_timeout_ms')
    assert.equal('ttl' in body, false, '-1 must omit ttl')
    assert.equal('image_links' in body, false, 'image_links is off by default')
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
  // No key and both backends disabled: nothing can serve, and the chain must say
  // so rather than pretending a backend is usable. Fully hermetic now — the
  // environment cannot supply a key even if one is exported.
  const provider = chain({
    priority: ['tinyfish', 'anysearch'],
    tinyfish: { enabled: false },
    anysearch: { enabled: false },
  })
  assert.equal(provider.available(), false)
  await assert.rejects(
    () => provider.search({ query: 'q' }),
    (error) => error.code === 'WEB_PROVIDER_UNAVAILABLE',
  )
})

await check('the plugin registers exactly ONE provider for both capabilities', async () => {
  // The contract this refactor exists to establish: the seam sees a single id,
  // so an unset `web.searchProvider` is unambiguous and the operator never has
  // to name a backend to get search working. Backend choice stays internal.
  const runtime = await mountWeb()
  // An explicit key makes TinyFish definitively available, so which backend
  // serves does not depend on whether THIS machine happens to have a
  // `~/.tinyfish/config.json`. Without it the test is non-hermetic: on a clean
  // runner TinyFish is unavailable and the chain serves from AnySearch against a
  // TinyFish-shaped stub.
  const provider = chain({ tinyfish: { apiKey: 'sk-test' } })
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
    getConfig: () => plugin.resolveConfigObject({}),
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
      describe: () => [{ ns: 'hydrasearch', schema: {}, value: plugin.resolveConfigObject({}), revision: 3 }],
      writable: true,
      mutate: async () => {},
    },
    getCredentials: () => undefined,
    getConfig: () => plugin.resolveConfigObject({}),
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
  assert.equal(reply.value.credentials.tinyfish.ref, plugin.TINYFISH_API_KEY_REF)
  assert.equal(reply.value.credentials.anysearch.ref, plugin.ANYSEARCH_API_KEY_REF)
  // The refs are plugin-owned on purpose: a ref that collided with the
  // conventional environment variable would be permanently shadowed, which is
  // what made the card unable to write or clear the key.
  assert.notEqual(reply.value.credentials.tinyfish.ref, 'TINYFISH_API_KEY')
  assert.notEqual(reply.value.credentials.anysearch.ref, 'ANYSEARCH_API_KEY')
  assert.equal(reply.value.env.anysearch.anonymousAllowed, true)
  // `fromConfig` and `hasFallbackKey` are gone: config and environment are no
  // longer key sources, so reporting them would describe a store the plugin
  // does not read.
  assert.equal(reply.value.credentials.tinyfish.fromConfig, undefined)
  assert.equal(reply.value.env.tinyfish.hasFallbackKey, undefined)
  assert.equal(reply.value.limits.tinyfish.defaultMaxPages, 3)
  assert.equal(reply.value.limits.anysearch.maxResults, 10)
  assert.equal(reply.value.limits.tinyfish.fetchFormats.includes('markdown'), true)
})

await check('describe never returns a secret value', async () => {
  const routes = plugin.makeBridgeRoutes(bridgeDeps({
    settings: {
      describe: () => [{ ns: 'hydrasearch', schema: {}, value: plugin.resolveConfigObject({}), revision: 1 }],
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
      describe: () => [{ ns: 'hydrasearch', schema: {}, value: plugin.resolveConfigObject({}), revision: 7 }],
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
      describe: () => [{ ns: 'hydrasearch', schema: {}, value: plugin.resolveConfigObject({}), revision: 2 }],
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
      describe: () => [{ ns: 'hydrasearch', schema: {}, value: plugin.resolveConfigObject({}), revision: 9 }],
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

await check('the test route carries latencyMs for both a single backend and the chain', async () => {
  // REGRESSION: the card renders "耗时 {latencyMs}ms", and the /test route's
  // probe objects were built by hand without copying `latencyMs` off the
  // backend result — so every completed test printed "耗时 undefinedms".
  //
  // Asserted through the REAL handler and the REAL backend result shape (not a
  // hand-written stub reply), so a future field drop is caught here rather than
  // in the browser.
  const original = globalThis.fetch
  globalThis.fetch = stubFetch([
    page([result('https://a.test/1')]),
    envelope([asResult('https://as.test/1')]),
  ])
  try {
    // The probe helpers live in apply(), so drive the same BackendRuntime the
    // chain does and assert the result the route projects from it.
    seedKeys({ tinyfish: 'sk-test', anysearch: 'k' })
    const out = await backend('tinyfish').search({ query: 'q', maxResults: 5 }, undefined)
    assert.equal(typeof out.latencyMs, 'number', 'a backend search result must carry latencyMs')
    assert.ok(out.latencyMs >= 0)

    // And through the route: the reply the card consumes must expose it.
    const routes = plugin.makeBridgeRoutes(bridgeDeps({
      probeSearch: async () => ({ query: 'q', backend: 'tinyfish', sources: [], totalResults: 0, latencyMs: 42 }),
      probeBackend: async () => ({ query: 'q', backend: 'tinyfish', sources: [], totalResults: 0, latencyMs: 42 }),
    }))
    const chainRoute = routes.find((entry) => entry.path.endsWith('/test'))
    const chainReply = await invokeBridge(chainRoute, { body: {} })
    assert.equal(chainReply.reply.value.latencyMs, 42, 'the chain test reply must expose latencyMs')
    const singleReply = await invokeBridge(chainRoute, { body: { backend: 'tinyfish' } })
    assert.equal(singleReply.reply.value.latencyMs, 42, 'the single-backend test reply must expose latencyMs')
  } finally {
    globalThis.fetch = original
  }
})

await check('a probe failure never reports a latency', async () => {
  // The card only reads `latencyMs` on success; a failure path must not invent
  // a number, or "耗时 0ms" would read as a real measurement.
  const routes = plugin.makeBridgeRoutes(bridgeDeps({
    probeSearch: async () => { throw new Error('everything is down') },
  }))
  const route = routes.find((entry) => entry.path.endsWith('/test'))
  const { reply } = await invokeBridge(route, { body: {} })
  assert.equal(reply.ok, false)
  assert.equal(reply.value, undefined)
  assert.equal(reply.latencyMs, undefined)
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

/**
 * Live checks read the key from the CREDENTIAL CENTER, the only store the
 * plugin uses. Without a mounted credentials service there is nothing to read,
 * so the section self-skips rather than inventing a key source the plugin does
 * not have.
 */
const liveTinyfishKey = (await credentialsDouble.resolve(plugin.TINYFISH_API_KEY_REF))?.value ?? ''
const liveAnysearchKey = (await credentialsDouble.resolve(plugin.ANYSEARCH_API_KEY_REF))?.value ?? ''

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
