/**
 * End-to-end regression proof for the two reported bugs, run against the REAL
 * services on a scratch home that reproduces the reporter's conditions.
 *
 * The two bugs:
 *
 *   1. "配置页最下方测试链路，完成后的耗时异常，提示为 耗时 undefinedms"
 *      — the /test route's probe objects dropped `latencyMs`.
 *   2. "tinyfish 配置 api-key 后无法切换清除，要求配置 api-key 后可以清除"
 *      — the key could be neither saved nor cleared, because the reference was
 *      shadowed by a conventional environment variable.
 *
 * The reporter's machine had `TINYFISH_API_KEY` exported (and the CLI's
 * `~/.tinyfish/config.json` set), with nothing in the credential center. This
 * script recreates EXACTLY that and asserts the card's operations now work and
 * tell the truth.
 *
 * Run with the bundled Node:
 *   node scripts/verify-e2e.mjs
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

console.log('dsh-hydrasearch end-to-end regression proof\n')

/* ------------------------------------------------ the reporter's conditions */

// The reporter's shell had this exported. Under the OLD code it shadowed the
// credential reference and made set/unset throw.
const REPORTER_ENV_KEY = 'sk-tinyfish-exported-in-shell'
process.env.TINYFISH_API_KEY = REPORTER_ENV_KEY
process.env.ANYSEARCH_API_KEY = 'as_sk_exported_in_shell'

const { Context } = await import('@deepseek-ai/cordis')
const { WebRuntime } = await import('@deepseek-ai/dsh-web')
const { FileSettingsProvider } = await import('@deepseek-ai/dsh-settings-file')
const { LocalCredentialProvider } = await import('@deepseek-ai/dsh-credentials-local')

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const plugin = await import(`${new URL(`file://${path.resolve(here, '../lib/index.js').replace(/\\/g, '/')}`)}?t=${Date.now()}`)

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hydrasearch-e2e-'))

/** Mount the real services and the plugin's own `apply()`. */
async function mount() {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, {})
  await ctx.plugin(FileSettingsProvider, { path: path.join(scratch, 'settings.yaml') })
  await ctx.plugin(LocalCredentialProvider, { path: path.join(scratch, '.credentials.yaml') })
  plugin.apply(ctx, plugin.Config({}))
  await plugin.keyStoreFor(ctx).refresh()
  return ctx
}

const ctx = await mount()

/** Invoke one bridge route exactly as the browser half does. */
async function bridge(route, body) {
  const routes = plugin.makeBridgeRoutes({
    settings: ctx.settings,
    getCredentials: () => ctx.get('credentials'),
    getConfig: () => plugin.Config({}),
    refreshKeys: async () => { await plugin.keyStoreFor(ctx).refresh() },
    probeSearch: async () => ({
      query: 'q', backend: 'tinyfish', sources: [], totalResults: 0, latencyMs: 137,
    }),
    probeBackend: async () => ({
      query: 'q', backend: 'tinyfish', sources: [], totalResults: 0, latencyMs: 137,
    }),
    subDomains: async () => ({}),
    adoptKey: async () => ({}),
  })
  const entry = routes.find((item) => item.path === `${plugin.BRIDGE_PREFIX}${route}`)
  assert.ok(entry !== undefined, `no route ${route}`)
  const chunks = [Buffer.from(JSON.stringify(body ?? {}))]
  let reply
  await entry.handler({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1' },
    method: 'POST',
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }, { writeHead: () => {}, end: (text) => { reply = JSON.parse(text) } })
  return reply
}

/* ------------------------------------------------------------- bug 2: keys */

await check('the environment variable is NOT a key source', async () => {
  const reply = await bridge('/describe', {})
  assert.equal(reply.ok, true)
  // The reporter's shell exports TINYFISH_API_KEY. Under the old code that made
  // `configured: true` with `writable: false` — a key the card could not touch.
  assert.equal(reply.value.credentials.tinyfish.configured, false, 'the shell export must not configure the key')
  assert.equal(reply.value.credentials.tinyfish.writable, true, 'the store must be writable')
  // The reference must be plugin-owned, so no conventional name can shadow it.
  assert.equal(reply.value.credentials.tinyfish.ref, 'HYDRASEARCH_TINYFISH_API_KEY')
})

await check('saving a key succeeds even with the variable exported', async () => {
  const reply = await bridge('/key-set', { backend: 'tinyfish', value: 'sk-from-the-card' })
  assert.equal(reply.ok, true, `save failed: ${reply.message} — this is the reported bug`)
  const stored = await ctx.get('credentials').resolve(plugin.TINYFISH_API_KEY_REF)
  assert.equal(stored?.value, 'sk-from-the-card')
})

await check('the saved key is live immediately and reachable', async () => {
  // The card re-reads /describe after a save; it must show the key as present.
  const reply = await bridge('/describe', {})
  assert.equal(reply.value.credentials.tinyfish.configured, true)
  assert.equal(reply.value.credentials.tinyfish.writable, true)
  assert.equal(reply.value.credentials.tinyfish.source, 'file')
})

await check('clearing the key works and reports success', async () => {
  const reply = await bridge('/key-unset', { backend: 'tinyfish' })
  assert.equal(reply.ok, true, `clear failed: ${reply.message} — this is the reported bug`)
  assert.equal(reply.value.cleared, true, 'a real clear must be reported as cleared')
  assert.equal(reply.value.shadowedBy, undefined)
  const stored = await ctx.get('credentials').resolve(plugin.TINYFISH_API_KEY_REF)
  assert.equal(stored, undefined, 'the key must be gone from the store')
})

await check('after clearing, the key is really gone from the card too', async () => {
  const reply = await bridge('/describe', {})
  assert.equal(reply.value.credentials.tinyfish.configured, false)
  // And it must not have "come back" through the exported environment variable.
  assert.equal(plugin.keyStoreFor(ctx).get(plugin.TINYFISH_API_KEY_REF), '')
})

await check('a read-only layer still supplying the key is reported, not hidden', async () => {
  // Even with plugin-owned refs, a user CAN store one in a layered source (for
  // example their own .env). If the writable copy is cleared but the read-only
  // layer still resolves, the card must say so rather than claim success.
  const credentials = ctx.get('credentials')
  const realUnset = credentials.unset.bind(credentials)
  const realDescribe = credentials.describe.bind(credentials)
  credentials.unset = async () => {}
  credentials.describe = async (ref) => (ref === plugin.TINYFISH_API_KEY_REF
    ? { configured: true, writable: false, source: 'project-env' }
    : realDescribe(ref))
  try {
    const reply = await bridge('/key-unset', { backend: 'tinyfish' })
    assert.equal(reply.ok, true)
    assert.equal(reply.value.cleared, false, 'must not claim a shadowed clear succeeded')
    assert.equal(reply.value.shadowedBy, 'project-env')
  } finally {
    credentials.unset = realUnset
    credentials.describe = realDescribe
  }
})

/* --------------------------------------------------------- bug 1: latency */

await check('the test route returns a real latency, not undefined', async () => {
  // Bug 1 was here: the card renders `耗时 {latencyMs}ms`, and the probe dropped
  // the field, so a SUCCESSFUL test printed "耗时 undefinedms".
  const chainReply = await bridge('/test', {})
  assert.equal(chainReply.ok, true)
  assert.equal(typeof chainReply.value.latencyMs, 'number', `chain test latency was ${chainReply.value.latencyMs}`)
  const singleReply = await bridge('/test', { backend: 'tinyfish' })
  assert.equal(typeof singleReply.value.latencyMs, 'number', `single test latency was ${singleReply.value.latencyMs}`)
})

await check('the card would render a number, never the string "undefined"', async () => {
  // The exact copy-table expression the browser half uses.
  const zh = (r) => '成功：' + r.backend + ' 返回 ' + r.sources.length + ' 条结果（共 ' + r.totalResults + ' 条匹配），耗时 ' + r.latencyMs + 'ms'
  const reply = await bridge('/test', {})
  const rendered = zh(reply.value)
  assert.doesNotMatch(rendered, /undefined/, `rendered: ${rendered}`)
  assert.match(rendered, /耗时 \d+ms/)
  console.log(`       → ${rendered}`)
})

await check('the real chain probe carries latencyMs (not just the stub)', async () => {
  // The stub above proves the ROUTE forwards it. This proves the PROBE captures
  // it in the first place — the half that was actually broken — by driving a
  // real BackendRuntime against a stubbed transport.
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ query: 'q', results: [{ url: 'https://a.test/1' }], total_results: 1, page: 0 }),
  })
  try {
    await ctx.get('credentials').set(plugin.TINYFISH_API_KEY_REF, 'sk-live-probe')
    await plugin.keyStoreFor(ctx).refresh()
    const backend = new plugin.BackendRuntime(
      plugin.TINYFISH_ID, ctx, () => plugin.Config({}), undefined,
    )
    const out = await backend.search({ query: 'q', maxResults: 5 }, undefined)
    assert.equal(typeof out.latencyMs, 'number', 'a backend search result must carry latencyMs')
  } finally {
    globalThis.fetch = original
    await ctx.get('credentials').unset(plugin.TINYFISH_API_KEY_REF)
    await plugin.keyStoreFor(ctx).refresh()
  }
})

/* --------------------------------------------------------------- teardown */

fs.rmSync(scratch, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
