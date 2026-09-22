/**
 * In-process integration verification: mount the plugin on a REAL Cordis root
 * context with the REAL DSH services it injects, then exercise the whole stack.
 *
 * This is the layer the unit suites cannot reach. They stub or hand-build the
 * pieces; here the plugin's own `apply()` runs against:
 *
 *   - a real `WebRuntime`             (`ctx.web`)
 *   - a real `FileSettingsProvider`   (`ctx.settings`, backed by a temp file)
 *   - a real `LocalCredentialProvider` (`ctx.credentials`)
 *   - a real `SystemPrompt`           (`ctx.systemPrompt`)
 *   - a real `WebServer`? no — the bridge is driven directly, because binding a
 *     port in a test would collide with the running app.
 *
 * What it proves that the other suites do not:
 *
 *   1. `apply()` completes on a real context (its `inject` graph actually
 *      resolves) and registers the single hydrasearch provider.
 *   2. A settings write through the bridge persists to disk and is re-read by
 *      the next search — the "persisted and effective without restart" contract.
 *   3. Reordering `priority` through the bridge changes which backend answers,
 *      using the real settings round trip.
 *   4. The credential center round trip works and its key is what the provider
 *      actually sends.
 *   5. `ctx.web.search()` dispatches through the chain and the seam caps it.
 *
 * Run with the bundled Node, from inside the profile tree:
 *   node scripts/verify-integration.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

let failures = 0
let checks = 0

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

console.log('dsh-hydrasearch in-process integration\n')

/*
 * Ambient credential environment variables can no longer interfere.
 *
 * The plugin reads plugin-owned references (`HYDRASEARCH_*`), which no launcher
 * exports, so the old shadowing hazard is gone by construction. The plain
 * `TINYFISH_API_KEY` / `ANYSEARCH_API_KEY` names are still cleared below to
 * prove that: a test asserting the key comes from the credential center must
 * fail if the plugin secretly consulted the environment.
 */
for (const name of ['TINYFISH_API_KEY', 'ANYSEARCH_API_KEY']) {
  process.env[name] = 'sk-from-env-must-be-ignored'
}
process.on('exit', () => {
  for (const name of ['TINYFISH_API_KEY', 'ANYSEARCH_API_KEY']) delete process.env[name]
})

/* ---------------------------------------------------------- fetch double */

/** Calls made through the installed fetch double. */
const fetchCalls = []

/**
 * Install a `fetch` double that answers TinyFish and AnySearch by host and
 * records every call, so assertions can prove WHICH backend was reached.
 */
function installFetchDouble() {
  fetchCalls.length = 0
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url))
    const headers = (init && init.headers) || {}
    fetchCalls.push({ url: target, headers, init })

    const reply = (body) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body })

    if (target.hostname === 'api.search.tinyfish.ai') {
      return reply({
        query: target.searchParams.get('query'),
        results: [
          { position: 1, site_name: 'tf.test', snippet: 'tf snippet', title: 'tf result', url: 'https://tf.test/1', date: 'Aug 17, 2026' },
          { position: 2, site_name: 'tf2.test', snippet: 'tf snippet 2', title: 'tf result 2', url: 'https://tf.test/2' },
        ],
        total_results: 2,
        page: 0,
      })
    }
    if (target.hostname === 'api.fetch.tinyfish.ai') {
      return reply({
        results: [{ url: 'https://tf.test/1', final_url: 'https://tf.test/1', title: 'tf', text: 'tinyfish body', format: 'markdown' }],
        errors: [],
      })
    }
    if (target.hostname === 'api.anysearch.com') {
      if (target.pathname === '/v1/search') {
        return reply({
          code: 0,
          message: 'ok',
          data: {
            results: [{ title: 'as result', url: 'https://as.test/1', snippet: 'as snippet', content: 'as content' }],
            metadata: { total_results: 1, search_time_ms: 9 },
          },
        })
      }
      if (target.pathname === '/v1/extract') {
        return reply({ code: 0, data: { url: 'https://as.test/1', title: 'as', content: 'anysearch body' } })
      }
      return reply({ code: 0, data: { domains: [] } })
    }
    throw new Error(`unexpected fetch target: ${target.href}`)
  }
}

/* ------------------------------------------------------- real services */

const { Context } = await import('@deepseek-ai/cordis')
const { WebRuntime } = await import('@deepseek-ai/dsh-web')
const { FileSettingsProvider } = await import('@deepseek-ai/dsh-settings-file')
const { LocalCredentialProvider } = await import('@deepseek-ai/dsh-credentials-local')
const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')

const pluginPath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '../lib/index.js',
)
const plugin = await import(`${new URL(`file://${pluginPath.replace(/\\/g, '/')}`)}?t=${Date.now()}`)

/** A scratch directory for the settings document and credentials file. */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hydrasearch-it-'))
const settingsPath = path.join(scratch, 'settings.yaml')
const credentialsPath = path.join(scratch, '.credentials.yaml')

/** Scratch directories created by {@link mount}, removed at the end. */
const scratchDirs = [scratch]

/**
 * Mount a real context with the services the plugin injects, then run the
 * plugin's own `apply()`.
 *
 * Keys are NOT config any more: they are written into the real mounted
 * credential center under the plugin's own references, which is exactly how the
 * settings card writes them. `config.tinyfish.apiKey` / `config.anysearch.apiKey`
 * are accepted as conveniences for the call sites below and translated here.
 *
 * @param config - composition entry config (the plugin fills the rest).
 * @param options - `fresh: true` gives this mount its own settings file, so a
 *   priority reordered by an earlier mount cannot leak in. (That leak is the
 *   persistence feature working, but it makes an assertion about "the first
 *   backend fails" depend on test order.)
 * @returns the root context.
 */
async function mount(config = {}, options = {}) {
  let docPath = settingsPath
  let credPath = credentialsPath
  if (options.fresh === true) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydrasearch-it-'))
    scratchDirs.push(dir)
    docPath = path.join(dir, 'settings.yaml')
    credPath = path.join(dir, '.credentials.yaml')
  }
  const ctx = new Context()
  await ctx.plugin(WebRuntime, {})
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(FileSettingsProvider, { path: docPath })
  await ctx.plugin(LocalCredentialProvider, { path: credPath })
  // Move any test-supplied key into the credential center, the one store the
  // plugin reads, then strip it from the config so a schema field cannot
  // silently reintroduce a second source.
  const credentials = ctx.get('credentials')
  const sanitized = structuredClone(config)
  for (const [id, ref] of [[plugin.TINYFISH_ID, plugin.TINYFISH_API_KEY_REF], [plugin.ANYSEARCH_ID, plugin.ANYSEARCH_API_KEY_REF]]) {
    const key = sanitized[id]?.apiKey
    if (sanitized[id] !== undefined) delete sanitized[id].apiKey
    if (typeof key === 'string' && key.length > 0) await credentials.set(ref, key)
  }
  // `apply` expects the schema-resolved config, exactly as the loader passes it.
  const resolved = plugin.Config(sanitized)
  plugin.apply(ctx, resolved)
  // Hydrate the availability snapshot the way production does before deciding
  // which backends can serve.
  await plugin.keyStoreFor(ctx).refresh()
  return ctx
}

installFetchDouble()

const ctx = await mount({
  tinyfish: { apiKey: 'sk-tinyfish-it' },
  anysearch: { apiKey: 'as_sk_it' },
})

await check('apply() completes on a real context and registers the single provider', () => {
  // ONE provider per capability. A second registration would make an unset
  // `web.searchProvider` ambiguous (WEB_PROVIDER_AMBIGUOUS), so this count is
  // the load-bearing assertion behind the whole single-provider design.
  assert.equal(ctx.web.searchProviders.size, 1, `expected 1 search provider, got ${ctx.web.searchProviders.size}`)
  assert.equal(ctx.web.fetchProviders.size, 1, `expected 1 fetch provider, got ${ctx.web.fetchProviders.size}`)
  assert.ok(ctx.web.searchProviders.has(plugin.HYDRASEARCH_PROVIDER_ID), 'the hydrasearch search provider is missing')
  assert.ok(ctx.web.fetchProviders.has(plugin.HYDRASEARCH_PROVIDER_ID), 'the hydrasearch fetch provider is missing')
  // The backend ids are internal now: registering them would have made the seam
  // treat them as peer providers.
  assert.equal(ctx.web.searchProviders.has(plugin.TINYFISH_ID), false, 'a backend must not be a provider')
  assert.equal(ctx.web.searchProviders.has(plugin.ANYSEARCH_ID), false, 'a backend must not be a provider')
})

await check('the web seam selects the chain', () => {
  // `WebRuntime` is constructed with no configured id, so the ONLY reason
  // selection works is the plugin's takeover guard.
  assert.equal(ctx.web.searchProviderId, plugin.HYDRASEARCH_PROVIDER_ID)
  assert.equal(ctx.web.fetchProviderId, plugin.HYDRASEARCH_PROVIDER_ID)
})

await check('ctx.web.search() dispatches through the chain', async () => {
  const result = await ctx.web.search({ query: 'integration query', maxResults: 5 })
  assert.equal(result.sources.length, 2, 'expected the TinyFish page')
  assert.equal(result.sources[0].url, 'https://tf.test/1')
  // The date must have been normalized to ISO on the way through.
  assert.equal(result.sources[0].publishedAt, new Date('Aug 17, 2026').toISOString())
  assert.equal(new URL(fetchCalls.at(-1).url).hostname, 'api.search.tinyfish.ai')
})

await check('the seam caps over-returned sources and flags truncation', async () => {
  const result = await ctx.web.search({ query: 'q', maxResults: 1 })
  assert.equal(result.sources.length, 1)
  assert.equal(result.truncated, true, 'the seam must report its own cut')
})

await check('ctx.web.fetch() returns the seam body shape', async () => {
  const result = await ctx.web.fetch({ url: 'https://tf.test/1' })
  assert.equal(result.statusCode, 200)
  assert.equal(result.body.kind, 'text')
  assert.equal(result.body.content, 'tinyfish body')
  assert.equal(new URL(fetchCalls.at(-1).url).hostname, 'api.fetch.tinyfish.ai')
})

await check('the default purpose reaches the wire on both search and fetch', async () => {
  // The defaulting happens in the schema, and the forwarding happens in
  // BackendRuntime. Only an end-to-end call through the real seam proves BOTH
  // halves agree — a schema default the runtime never reads would look set in
  // the card and send nothing.
  const expected = plugin.Config({}).tinyfish.purpose
  assert.ok(expected.length > 0, 'the shipped default must be non-empty')

  await ctx.web.search({ query: 'purpose provenance', maxResults: 1 })
  const searchUrl = fetchCalls.filter((call) => call.url.hostname === 'api.search.tinyfish.ai').at(-1).url
  assert.equal(searchUrl.searchParams.get('purpose'), expected)

  fetchCalls.length = 0
  await ctx.web.fetch({ url: 'https://tf.test/1' })
  const fetchBody = JSON.parse(fetchCalls.at(-1).init.body)
  assert.equal(fetchBody.purpose, expected, 'the fetch path must honour purpose too')
})

await check('the plugin contributed a system-prompt section naming both backends', async () => {
  // `assemble()` is the real public surface: it runs every registered section
  // and returns the prompt the model would receive. Asserting on it proves the
  // section is live, not merely that a registration call was made.
  const assembly = await ctx.systemPrompt.assemble()
  const text = JSON.stringify(assembly)
  assert.match(text, /hydrasearch/, 'the backend section must reach the assembled prompt')
  assert.match(text, /tinyfish/, 'the section must name the TinyFish backend')
  assert.match(text, /anysearch/, 'the section must name the AnySearch backend')
  assert.match(text, /failover|故障|priority/i, 'the section must describe the chain')
})

/* --------------------------------------------- settings round trip */

// Use the PLUGIN's own helper, not one imported from `@deepseek-ai/dsh-settings`:
// the rc-generation exports `settingsNamespace`, the 0.1.6-alpha generation does
// not, and the plugin must run on both. Importing it here would make this suite
// pass on a machine where the plugin itself cannot even load.
const { settingsNamespace } = plugin

/** Invoke one bridge route on the mounted context's live services. */
async function bridge(route, body) {
  // Rebuild the routes against the SAME live services `apply` used, so the
  // assertions exercise the real handlers end to end.
  const routes = plugin.makeBridgeRoutes({
    settings: ctx.settings,
    getCredentials: () => ctx.get('credentials'),
    getConfig: () => plugin.Config({
      ...plugin.Config({}),
      ...readConfigured(),
    }),
    probeSearch: async () => ({}),
    probeBackend: async () => ({}),
    subDomains: async () => ({}),
    adoptKey: async () => ({}),
    // The real bridge refreshes the availability snapshot after a durable
    // credential write; the double must too, or key-set/key-unset assertions
    // would not observe the production behaviour.
    refreshKeys: async () => { await plugin.keyStoreFor(ctx).refresh() },
  })
  const handler = routes.find((entry) => entry.path === `${plugin.BRIDGE_PREFIX}${route}`)
  assert.ok(handler !== undefined, `no bridge route ${route}`)
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1' },
    method: 'POST',
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
  let reply
  await handler.handler(req, { writeHead: () => {}, end: (text) => { reply = JSON.parse(text) } })
  return reply
}

/** The config as the settings service currently resolves it. */
function readConfigured() {
  return ctx.settings.get(settingsNamespace('hydrasearch')) ?? {}
}

await check('the settings namespace is registered and readable', () => {
  const value = readConfigured()
  assert.deepEqual(value.priority, ['tinyfish', 'anysearch'], 'the namespace must resolve the composition defaults')
  // The key is NOT in settings any more — that is the point of the single-store
  // contract. It lives only in the credential center.
  assert.equal(value.tinyfish.apiKey, undefined, 'config must expose no key field')
  assert.equal(value.tinyfish.apiKeyEnv, undefined, 'config must expose no key-ref field')
})

await check('describe reports the live chain and both credential slots', async () => {
  const reply = await bridge('/describe', {})
  assert.equal(reply.ok, true, `describe failed: ${reply.message}`)
  assert.deepEqual(reply.value.chain.priority, ['tinyfish', 'anysearch'])
  assert.equal(reply.value.credentials.tinyfish.ref, plugin.TINYFISH_API_KEY_REF)
  assert.equal(reply.value.credentials.anysearch.ref, plugin.ANYSEARCH_API_KEY_REF)
  // The key seeded by mount() is visible through the credential center with the
  // layer named, so the card can say where it came from and whether it is
  // replaceable.
  assert.equal(reply.value.credentials.tinyfish.configured, true)
  assert.equal(reply.value.credentials.tinyfish.source, 'file')
  assert.equal(reply.value.credentials.tinyfish.writable, true)
})

await check('a settings write persists to disk and is re-read immediately', async () => {
  const reply = await bridge('/mutate', {
    ns: 'hydrasearch',
    ops: [{ op: 'set', path: ['tinyfish', 'language'], value: 'zh' }],
  })
  assert.equal(reply.ok, true, `mutate failed: ${reply.message}`)
  assert.equal(reply.value.value.tinyfish.language, 'zh', 'the reply must carry the new value')

  // The contract under test: a write is durable AND visible to the next read
  // without a restart. Check both the in-memory resolution and the file.
  assert.equal(readConfigured().tinyfish.language, 'zh')
  const onDisk = fs.readFileSync(settingsPath, 'utf8')
  assert.match(onDisk, /language: zh/, 'the write must reach the settings document')
})

await check('the persisted scoping actually reaches the next request', async () => {
  await ctx.web.search({ query: 'scoped query', maxResults: 2 })
  const call = fetchCalls.at(-1)
  assert.equal(call.url.searchParams.get('language'), 'zh', 'the saved language must ride the request')
})

await check('reordering priority through the bridge changes which backend answers', async () => {
  const reply = await bridge('/mutate', {
    ns: 'hydrasearch',
    ops: [{ op: 'set', path: ['priority'], value: ['anysearch', 'tinyfish'] }],
  })
  assert.equal(reply.ok, true, `mutate failed: ${reply.message}`)
  assert.deepEqual(reply.value.value.priority, ['anysearch', 'tinyfish'])

  // The live config the providers read is the settings scope, so the very next
  // search must hit AnySearch. This is the "takes effect without a restart"
  // claim, asserted through the real settings round trip.
  const result = await ctx.web.search({ query: 'reordered', maxResults: 2 })
  assert.equal(new URL(fetchCalls.at(-1).url).hostname, 'api.anysearch.com', 'AnySearch must now be first')
  assert.equal(result.sources[0].url, 'https://as.test/1')
})

await check('a stale revision is refused instead of clobbering', async () => {
  const reply = await bridge('/mutate', {
    ns: 'hydrasearch',
    ops: [{ op: 'set', path: ['failover'], value: false }],
    expectedRevision: 999,
  })
  assert.equal(reply.ok, false)
  assert.equal(reply.code, 'settings-conflict', `expected a conflict, got ${reply.code}: ${reply.message}`)
})

await check('a per-backend write leaves the other backend section untouched', async () => {
  await bridge('/mutate', { ns: 'hydrasearch', ops: [{ op: 'set', path: ['anysearch', 'zone'], value: 'US' }] })
  const value = readConfigured()
  assert.equal(value.anysearch.zone, 'US')
  assert.equal(value.tinyfish.language, 'zh', 'the TinyFish section must survive an AnySearch write')
  assert.deepEqual(value.priority, ['anysearch', 'tinyfish'], 'the order must survive too')
})

await check('invalid settings are refused with an actionable message', async () => {
  const reply = await bridge('/mutate', {
    ns: 'hydrasearch',
    ops: [{ op: 'set', path: ['anysearch', 'params'], value: '{not json' }],
  })
  assert.equal(reply.ok, false, 'a malformed params blob must be refused')
  assert.match(reply.message, /params/, `the message must name the field: ${reply.message}`)
  // And the refusal must not have corrupted the stored section.
  assert.equal(readConfigured().anysearch.zone, 'US')
})

/* ---------------------------------------------- credential round trip */

await check('the credential center round trip supplies the key the provider sends', async () => {
  const credentials = ctx.get('credentials')
  await credentials.set(plugin.ANYSEARCH_API_KEY_REF, 'as_sk_from_center')
  // Refresh the availability snapshot the way the bridge does after a write, so
  // the synchronous `available()` sees the new key immediately.
  await plugin.keyStoreFor(ctx).refresh()

  // The credential center is the ONLY key source, so the next request must
  // carry the newly stored value.
  await ctx.web.search({ query: 'credential check', maxResults: 2 })
  const call = fetchCalls.at(-1)
  assert.equal(call.url.hostname, 'api.anysearch.com')
  assert.equal(call.headers.authorization, 'Bearer as_sk_from_center')
})

await check('an environment variable is NOT a key source', async () => {
  // The suite exports plausible-looking `TINYFISH_API_KEY` / `ANYSEARCH_API_KEY`
  // values at startup. Reading one would defeat the single-store contract, so a
  // cleared credential center must leave TinyFish unavailable regardless.
  const credentials = ctx.get('credentials')
  await credentials.unset(plugin.TINYFISH_API_KEY_REF)
  await plugin.keyStoreFor(ctx).refresh()
  const reply = await bridge('/describe', {})
  assert.equal(reply.value.credentials.tinyfish.configured, false, 'the environment must not configure the key')
  // And a direct search proves the request would not carry it either.
  const before = fetchCalls.length
  await ctx.web.search({ query: 'no key', maxResults: 1 })
  const hosts = fetchCalls.slice(before).map((call) => call.url.hostname)
  assert.ok(!hosts.includes('api.search.tinyfish.ai'), 'TinyFish must not be called without a credential')
})

await check('the bridge reports the credential center as configured', async () => {
  const reply = await bridge('/describe', {})
  assert.equal(reply.value.credentials.anysearch.configured, true)
  assert.equal(reply.value.credentials.anysearch.writable, true)
})

await check('a key set through the bridge lands in the credential center', async () => {
  const reply = await bridge('/key-set', { backend: 'tinyfish', value: 'sk-tinyfish-from-card' })
  assert.equal(reply.ok, true, `key-set failed: ${reply.message}`)
  const stored = await ctx.get('credentials').resolve(plugin.TINYFISH_API_KEY_REF)
  assert.equal(stored?.value, 'sk-tinyfish-from-card')
  // The write must be live for the very next availability test, with no restart
  // and no wait for an event.
  assert.equal(plugin.keyStoreFor(ctx).get(plugin.TINYFISH_API_KEY_REF), 'sk-tinyfish-from-card')
})

await check('a key unset through the bridge removes it and says so', async () => {
  const reply = await bridge('/key-unset', { backend: 'tinyfish' })
  assert.equal(reply.ok, true, `key-unset failed: ${reply.message}`)
  assert.equal(reply.value.cleared, true, 'a clear the store actually honoured must be reported as cleared')
  const stored = await ctx.get('credentials').resolve(plugin.TINYFISH_API_KEY_REF)
  assert.equal(stored, undefined)
  // The clear must take effect immediately, not on the next resolution.
  assert.equal(plugin.keyStoreFor(ctx).get(plugin.TINYFISH_API_KEY_REF), '')
})

await check('a clear shadowed by a read-only layer is reported honestly, not as success', async () => {
  // Simulate the exact production trap: the credentials provider resolves the
  // reference from a read-only layer that outranks its writable document.
  // `unset` cannot remove that layer, so reporting "cleared" would be a lie —
  // the very lie that made a configured key feel stuck.
  const shadowedRef = plugin.ANYSEARCH_API_KEY_REF
  const realCredentials = ctx.get('credentials')
  const originalUnset = realCredentials.unset.bind(realCredentials)
  const originalDescribe = realCredentials.describe.bind(realCredentials)
  realCredentials.unset = async () => { /* durable clear succeeds; layer remains */ }
  realCredentials.describe = async (ref) => (ref === shadowedRef
    ? { configured: true, writable: false, source: 'env' }
    : originalDescribe(ref))
  try {
    const reply = await bridge('/key-unset', { backend: 'anysearch' })
    assert.equal(reply.ok, true)
    assert.equal(reply.value.cleared, false, 'a still-resolving key must NOT be reported as cleared')
    assert.equal(reply.value.shadowedBy, 'env', 'the reply must name the layer still supplying the key')
  } finally {
    realCredentials.unset = originalUnset
    realCredentials.describe = originalDescribe
  }
})

/* ----------------------------------------------------- failover on a real context */

await check('a failing first backend fails over on the real chain', async () => {
  // A FRESH settings document: the earlier tests deliberately persisted a
  // reordered priority (that is the feature under test), and this assertion is
  // about the ORDER's failover behaviour, so it needs its own clean namespace.
  const failing = await mount({
    priority: ['tinyfish', 'anysearch'],
    tinyfish: { apiKey: 'sk-x', searchBaseURL: 'https://127.0.0.1:1/' },
    anysearch: { apiKey: 'as_sk_it' },
  }, { fresh: true })
  const result = await failing.web.search({ query: 'failover', maxResults: 2 })
  assert.equal(result.sources[0].url, 'https://as.test/1', 'AnySearch must serve the result')
  assert.match(result.content, /tinyfish failed/, 'the note must name the failed backend')
  assert.match(result.content, /using anysearch/, 'the note must name the serving backend')
})

await check('pinning search to one backend works through a real context', async () => {
  // `searchBackend` is the config-level replacement for the old design that
  // registered each backend as its own provider. The seam still dispatches to
  // the single hydrasearch provider; the pin is honoured inside it.
  const pinned = await mount({
    priority: ['tinyfish', 'anysearch'],
    searchBackend: plugin.ANYSEARCH_ID,
    tinyfish: { apiKey: 'sk-x' },
    anysearch: { apiKey: 'as_sk_it' },
  }, { fresh: true })
  // `fetchCalls` accumulates across every mount in this file, so the proof has
  // to look only at the calls THIS search made.
  const before = fetchCalls.length
  const result = await pinned.web.search({ query: 'pinned', maxResults: 2 })
  assert.equal(result.sources[0].url, 'https://as.test/1')
  // TinyFish is first in priority and would have served this search, so its
  // absence from this search's calls is the proof the pin took effect.
  const hosts = fetchCalls.slice(before).map((call) => call.url.hostname)
  assert.deepEqual(hosts, ['api.anysearch.com'], 'a pinned search must reach only the pinned backend')
})

await check('a priority reorder survives a full remount', async () => {
  // The persistence claim at its strongest: a fresh context reading the SAME
  // document must come up with the reordered chain.
  const remounted = await mount({ tinyfish: { apiKey: 'sk-tinyfish-it' }, anysearch: { apiKey: 'as_sk_it' } })
  const value = remounted.settings.get(settingsNamespace('hydrasearch'))
  assert.deepEqual(value.priority, ['anysearch', 'tinyfish'], 'the reorder must outlive the process')
  assert.equal(value.tinyfish.language, 'zh', 'the scoping write must outlive the process too')
})

/* ---------------------------------------------------------------- cleanup */

await check('the scratch settings document holds every write', () => {
  const onDisk = fs.readFileSync(settingsPath, 'utf8')
  for (const fragment of ['priority', 'anysearch', 'zh']) {
    assert.match(onDisk, new RegExp(fragment), `the document must contain ${fragment}`)
  }
})

for (const dir of scratchDirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // A leftover temp dir is not a test failure.
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
