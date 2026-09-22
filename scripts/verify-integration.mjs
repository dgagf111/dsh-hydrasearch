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
 *      resolves) and registers all three providers.
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
 * Isolate from ambient credential environment variables.
 *
 * The real `LocalCredentialProvider` treats an environment variable as a
 * READ-ONLY source and refuses `set` while one shadows the reference — correct
 * behaviour, but it makes the credential round-trip assertions depend on how
 * this script was launched. Clearing the two names under test keeps the suite
 * deterministic; they are restored on exit.
 */
const SAVED_ENV = new Map()
for (const name of ['TINYFISH_API_KEY', 'ANYSEARCH_API_KEY']) {
  if (process.env[name] !== undefined) SAVED_ENV.set(name, process.env[name])
  delete process.env[name]
}
process.on('exit', () => {
  for (const [name, value] of SAVED_ENV) process.env[name] = value
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
  // `apply` expects the schema-resolved config, exactly as the loader passes it.
  const resolved = plugin.Config(config)
  plugin.apply(ctx, resolved)
  return ctx
}

installFetchDouble()

const ctx = await mount({
  tinyfish: { apiKey: 'sk-tinyfish-it' },
  anysearch: { apiKey: 'as_sk_it' },
})

await check('apply() completes on a real context and registers all providers', () => {
  assert.equal(ctx.web.searchProviders.size, 3, `expected 3 search providers, got ${ctx.web.searchProviders.size}`)
  assert.equal(ctx.web.fetchProviders.size, 3, `expected 3 fetch providers, got ${ctx.web.fetchProviders.size}`)
  for (const id of ['hydrasearch', 'tinyfish', 'anysearch']) {
    assert.ok(ctx.web.searchProviders.has(id), `search provider "${id}" is missing`)
    assert.ok(ctx.web.fetchProviders.has(id), `fetch provider "${id}" is missing`)
  }
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
  assert.equal(value.tinyfish.apiKey, 'sk-tinyfish-it')
})

await check('describe reports the live chain and both credential slots', async () => {
  const reply = await bridge('/describe', {})
  assert.equal(reply.ok, true, `describe failed: ${reply.message}`)
  assert.deepEqual(reply.value.chain.priority, ['tinyfish', 'anysearch'])
  assert.equal(reply.value.credentials.tinyfish.ref, 'TINYFISH_API_KEY')
  assert.equal(reply.value.credentials.anysearch.ref, 'ANYSEARCH_API_KEY')
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
  await credentials.set('ANYSEARCH_API_KEY', 'as_sk_from_center')

  // The credential-center ref outranks the configured key, so the next request
  // must carry the newly stored value.
  await ctx.web.search({ query: 'credential check', maxResults: 2 })
  const call = fetchCalls.at(-1)
  assert.equal(call.url.hostname, 'api.anysearch.com')
  assert.equal(call.headers.authorization, 'Bearer as_sk_from_center')
})

await check('the bridge reports the credential center as configured', async () => {
  const reply = await bridge('/describe', {})
  assert.equal(reply.value.credentials.anysearch.configured, true)
  assert.equal(reply.value.credentials.anysearch.writable, true)
})

await check('a key set through the bridge lands in the credential center', async () => {
  const reply = await bridge('/key-set', { backend: 'tinyfish', value: 'sk-tinyfish-from-card' })
  assert.equal(reply.ok, true, `key-set failed: ${reply.message}`)
  const stored = await ctx.get('credentials').resolve('TINYFISH_API_KEY')
  assert.equal(stored?.value, 'sk-tinyfish-from-card')
})

await check('a key unset through the bridge removes it', async () => {
  const reply = await bridge('/key-unset', { backend: 'tinyfish' })
  assert.equal(reply.ok, true, `key-unset failed: ${reply.message}`)
  const stored = await ctx.get('credentials').resolve('TINYFISH_API_KEY')
  assert.equal(stored, undefined)
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

await check('a pinned single backend is reachable through a real context', async () => {
  const pinned = await mount({ tinyfish: { apiKey: 'sk-x' }, anysearch: { apiKey: 'as_sk_it' } }, { fresh: true })
  pinned.web.searchProviderId = plugin.ANYSEARCH_ID
  const result = await pinned.web.search({ query: 'pinned', maxResults: 2 })
  assert.equal(result.sources[0].url, 'https://as.test/1')
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
