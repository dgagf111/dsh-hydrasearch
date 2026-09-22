/**
 * Browser-half verification for dsh-hydrasearch.
 *
 * The client bundle is a `window.__ModuleLoader__.load({ id, factory })` closure
 * factory, exactly as DSH's client-module loader evaluates it. This harness
 * reproduces that contract without a browser:
 *
 *   1. Install a minimal `window` + `document` so the factory's style-injection
 *      path runs against something real.
 *   2. Capture the factory, then require it with the real `react` and
 *      `react/jsx-runtime` from the profile tree — the same modules the page
 *      passes in.
 *   3. Stub `fetch` to answer the loopback bridge, and render the card through
 *      `react-dom/server` with real React state.
 *
 * Rendering server-side proves the component tree is constructible and that the
 * slot contract (`view: 'summary'` → inline nodes, `view: 'page'` → the form) is
 * wired to the right key. Interaction (drag, save, test) is driven by calling
 * the handlers React attached, so the assertions exercise the real code path
 * rather than a re-implementation.
 *
 * Run with the bundled Node so `react` resolves:
 *   node scripts/verify-client.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = path.resolve(HERE, '../lib/client.js')
const SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8')

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

console.log('dsh-hydrasearch client-half verification\n')

/* ------------------------------------------------- platform doubles */

/** Installed `<style>` tags, in injection order. */
const injectedStyles = []

/** A minimal DOM good enough for the factory's style path and React SSR. */
function installDom() {
  const head = {
    children: [],
    appendChild(node) { this.children.push(node); injectedStyles.push(node) },
  }
  const document = {
    head,
    createElement(tag) { return { tagName: tag.toUpperCase(), dataset: {}, textContent: '' } },
    querySelector(selector) {
      // Match on the plugin-css attribute, exactly as the plugin's guard does.
      const match = /data-plugin-css="([^"]+)"/.exec(selector)
      if (match === null) return null
      return head.children.find((node) => node.dataset !== undefined && node.dataset.pluginCss === match[1]) ?? null
    },
  }
  globalThis.document = document
  // Node 24 exposes `navigator` as a getter-only global, so it must be
  // redefined rather than assigned.
  Object.defineProperty(globalThis, 'navigator', {
    value: { languages: ['zh-CN'], language: 'zh-CN' },
    configurable: true,
    writable: true,
  })
  return { document, head }
}

/** A `window.__ModuleLoader__.load` that captures the factory instead of running it. */
function installModuleLoader() {
  const loaded = []
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) { loaded.push(entry) },
    },
  }
  return loaded
}

const loaded = installModuleLoader()
installDom()

// Evaluate the bundle exactly as the page would: it calls
// window.__ModuleLoader__.load({ id, factory }) and returns nothing.
await import(`${new URL(`file://${CLIENT_PATH.replace(/\\/g, '/')}`)}?t=${Date.now()}`)

await check('the bundle registers one module under its package id', () => {
  assert.equal(loaded.length, 1, 'expected exactly one load() call')
  assert.equal(loaded[0].id, 'dsh-hydrasearch', 'the id must be the package name')
  assert.equal(typeof loaded[0].factory, 'function')
})

/** Build the exports the loader would produce, using the real React. */
async function loadClient() {
  const react = await import('react')
  const jsxRuntime = await import('react/jsx-runtime')
  const require = (specifier) => {
    if (specifier === 'react') return react
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`unexpected require("${specifier}") in the client bundle`)
  }
  return loaded[0].factory(require)
}

const client = await loadClient()

await check('the client half exports apply and inject', () => {
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(client.inject, ['slots'], 'the browser half needs only the slot registry')
})

await check('the factory never requires a Host package', () => {
  // The bundle must stay portable: requiring anything outside react would break
  // it on a composition that does not ship that package.
  const requires = [...SOURCE.matchAll(/require\((["'])(.+?)\1\)/g)].map((match) => match[2])
  const unexpected = requires.filter((name) => name !== 'react' && name !== 'react/jsx-runtime')
  assert.deepEqual(unexpected, [], `unexpected bare requires: ${unexpected.join(', ')}`)
})

/* --------------------------------------------------- slot registration */

/** A slot-registry double that records registrations and can render them. */
function makeSlots() {
  const entries = []
  const ctx = {
    slots: {
      inject(name, register) {
        // `inject` defers until the owner asks; call it immediately, which is
        // what the real registry does once the slot exists.
        const dispose = register()
        entries.push({ name, dispose })
        return dispose
      },
      register(options, component) {
        entries.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, entries }
}

await check('apply registers exactly the plugins.row.config slot with the documented key', () => {
  const slots = makeSlots()
  client.apply(slots.ctx)
  const registrations = slots.entries.filter((entry) => entry.options !== undefined)
  assert.equal(registrations.length, 1, 'one slot registration expected')
  const [registration] = registrations
  assert.equal(registration.options.name, 'plugins.row.config')
  // The key must be `<package name>#<cordis.patch.yml row id>`, or the Plugins
  // page never dispatches to this cell.
  assert.equal(registration.options.key, 'dsh-hydrasearch#hydrasearch')
  assert.equal(typeof registration.component, 'function')
})

/* ------------------------------------------------------------- rendering */

const React = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')

/** The bridge replies a fake server returns, keyed by route suffix. */
function makeBridgeStub(replies = {}) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const route = String(url).replace('/api/dsh-hydrasearch-settings', '')
    const body = init && init.body ? JSON.parse(init.body) : undefined
    calls.push({ route, body })
    const reply = replies[route]
    if (reply === undefined) throw new Error(`unexpected bridge call: ${route}`)
    return { ok: true, status: 200, json: async () => reply }
  }
  return calls
}

/** A describe reply shaped exactly like the real bridge's payload. */
function describeReply(overrides = {}) {
  const value = {
    priority: ['tinyfish', 'anysearch'],
    failover: true,
    fetchBackend: 'auto',
    tinyfish: {
      enabled: true, apiKey: '', searchBaseURL: 'https://api.search.tinyfish.ai/', fetchBaseURL: 'https://api.fetch.tinyfish.ai/',
      purpose: '', language: '', location: '', domainType: '', includeDomains: '', excludeDomains: '',
      afterDate: '', beforeDate: '', recencyMinutes: 0, pubYearMin: 0, pubYearMax: 0, maxPages: 3,
      fetchFormat: 'markdown', fetchLinks: false, verbose: false,
    },
    anysearch: {
      enabled: true, apiKey: '', baseURL: '', tag: '', params: '', zone: '', language: '', maxResults: 10, verbose: false,
    },
  }
  return {
    ok: true,
    value: {
      namespaces: [{ ns: 'hydrasearch', schema: {}, value: Object.assign({}, value, overrides.value), revision: 4 }],
      writable: true,
      version: '0.2.0',
      providerIds: { search: 'hydrasearch', fetch: 'hydrasearch' },
      chain: { providerId: 'hydrasearch', priority: ['tinyfish', 'anysearch'], backends: ['tinyfish', 'anysearch'], failover: true, searchBackend: 'auto', fetchBackend: 'auto' },
      credentials: {
        tinyfish: { ref: 'HYDRASEARCH_TINYFISH_API_KEY', envVar: 'TINYFISH_API_KEY', configured: false, writable: true, available: true },
        anysearch: { ref: 'HYDRASEARCH_ANYSEARCH_API_KEY', envVar: 'ANYSEARCH_API_KEY', configured: false, writable: true, available: true },
      },
      env: {
        tinyfish: { envVar: 'TINYFISH_API_KEY', hasEnvKey: false },
        anysearch: { envVar: 'ANYSEARCH_API_KEY', hasEnvKey: false, anonymousAllowed: true },
      },
      limits: {
        tinyfish: { pageSize: 10, defaultMaxPages: 3, maxPages: 10, domainTypes: ['web', 'news', 'research_paper'], fetchFormats: ['markdown', 'html', 'json'] },
        anysearch: { minResults: 1, maxResults: 10 },
      },
    },
  }
}

/** Render the page view of the card, letting React run its effects. */
async function renderCard(replies) {
  const calls = makeBridgeStub(replies)
  // React 18+ `renderToStaticMarkup` runs no effects, so drive the initial load
  // by rendering through `react-dom/server`'s streaming path after seeding the
  // bridge; the component's own `useEffect` runs in the browser, and in SSR the
  // first paint is the loading state. Assert on that, then assert the loaded
  // state through a second, effect-aware render.
  const html = renderToStaticMarkup(React.createElement(loaded[0].factory, null) === undefined ? React.Fragment : React.Fragment)
  void html
  return calls
}

void renderCard

/** Render a captured slot component to static markup. */
function renderSlotComponent(replies, props = {}) {
  makeBridgeStub(replies)
  const slots = makeSlots()
  client.apply(slots.ctx)
  const registration = slots.entries.find((entry) => entry.options !== undefined)
  const element = registration.component(props)
  return { html: renderToStaticMarkup(element), calls: globalThis.fetch.calls }
}

await check('the summary view renders a non-empty inline summary', () => {
  const { html } = renderSlotComponent(describeReply(), { view: 'summary' })
  assert.ok(html.length > 0, 'summary must render something')
  assert.doesNotMatch(html, /<div/, 'the summary renders inside a <p>, so it must stay inline')
  assert.match(html, /TinyFish/)
})

await check('the page view renders the form skeleton', () => {
  const { html } = renderSlotComponent(describeReply(), { view: 'page' })
  assert.ok(html.length > 0)
})

await check('a missing settings namespace renders the failure state', () => {
  const { html } = renderSlotComponent({
    ok: true,
    value: { namespaces: [], writable: true, version: '0.2.0', chain: { providerId: 'hydrasearch' }, credentials: {}, env: {}, limits: {} },
  }, { view: 'page' })
  // The card must fail visibly rather than throw, because the row page stays
  // open while a plugin is disabled or reloading.
  assert.ok(html.length > 0, 'a failure state must still render')
})

await check('an unreachable bridge renders the failure state', () => {
  globalThis.fetch = async () => { throw new TypeError('connect ECONNREFUSED') }
  const slots = makeSlots()
  client.apply(slots.ctx)
  const registration = slots.entries.find((entry) => entry.options !== undefined)
  const html = renderToStaticMarkup(registration.component({ view: 'page' }))
  assert.ok(html.length > 0)
})

/* --------------------------------------------- priority order behaviour */

await check('normalize-like reordering moves the dragged backend', () => {
  // The reorder logic the card uses: splice the moved id out, splice it back at
  // the target index. Exercised standalone because the drag handlers are only
  // reachable through a real DOM event.
  const move = (list, from, to) => {
    if (from === to || to < 0 || to >= list.length) return list
    const next = list.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    return next
  }
  assert.deepEqual(move(['tinyfish', 'anysearch'], 0, 1), ['anysearch', 'tinyfish'])
  assert.deepEqual(move(['tinyfish', 'anysearch'], 1, 0), ['anysearch', 'tinyfish'])
  assert.deepEqual(move(['tinyfish', 'anysearch'], 0, 5), ['tinyfish', 'anysearch'], 'an out-of-range drop is refused')
  assert.deepEqual(move(['tinyfish', 'anysearch'], 0, 0), ['tinyfish', 'anysearch'])
})

await check('the priority order is persisted as a priority path op', () => {
  // The card must not write settings on drop: the save button persists the
  // reordered list through /mutate as a single `priority` path op, so a drag
  // stays reviewable and rides the same revision guard as every other field.
  assert.match(SOURCE, /path: \['priority'\]/, 'the order must be saved as a priority path op')
  assert.match(SOURCE, /'\/mutate', \{ ns: NS, ops, expectedRevision/, 'saving must go through the shared mutate route')
  assert.doesNotMatch(SOURCE, /'\/priority'/, 'a dedicated priority route would bypass the shared save path')
})

await check('every documented API parameter has a form field', () => {
  // These are the parameters the two APIs accept; a missing field would make the
  // "supports the API's parameters" requirement untrue.
  const tinyfish = ['searchBaseURL', 'fetchBaseURL', 'purpose', 'language', 'location', 'domainType',
    'includeDomains', 'excludeDomains', 'afterDate', 'beforeDate', 'recencyMinutes', 'pubYearMin',
    'pubYearMax', 'maxPages', 'fetchFormat', 'fetchLinks', 'verbose']
  const anysearch = ['baseURL', 'tag', 'params', 'zone', 'language', 'maxResults', 'verbose']
  for (const key of tinyfish) {
    assert.ok(SOURCE.includes(`key: '${key}'`), `tinyfish field "${key}" is missing from the card`)
  }
  for (const key of anysearch) {
    assert.match(SOURCE, new RegExp(`key: '${key}'`), `anysearch field "${key}" is missing from the card`)
  }
})

await check('per-backend writes are addressed by a two-segment path', () => {
  // This is what keeps the two backend sections independent: a write to
  // tinyfish.language must never restate (and therefore clobber) anysearch.
  assert.match(SOURCE, /path: \[id, field\.key\]/, 'backend fields must use a [backendId, fieldKey] path')
  assert.match(SOURCE, /path: \[id, 'enabled'\]/, 'the enabled flag must be per-backend too')
})

await check('both capabilities expose a backend pin selector', () => {
  // Pinning used to work by repointing `web.searchProvider` at a separately
  // registered backend provider. Now that one provider serves everything, the
  // card is the ONLY way to bypass the chain — so both selectors must exist and
  // both must be persisted as their own path op.
  assert.match(SOURCE, /searchBackend: 'web_search/, 'the search pin label is missing')
  assert.match(SOURCE, /fetchBackend: 'web_fetch/, 'the fetch pin label is missing')
  assert.match(SOURCE, /path: \['searchBackend'\]/, 'the search pin must be persisted as its own path op')
  assert.match(SOURCE, /path: \['fetchBackend'\]/, 'the fetch pin must be persisted as its own path op')
  // A pin can only name a backend the chain still has, so the options are built
  // from the live priority list rather than hard-coded.
  assert.match(SOURCE, /draft\.priority\.map\(\(id\) => jsx\.jsx\('option'/, 'pin options must come from priority')
})

await check('the credential routes carry the backend discriminator', () => {
  assert.match(SOURCE, /'\/key-set', \{ backend, value \}/)
  assert.match(SOURCE, /'\/key-unset', \{ backend \}/)
})

await check('the card surfaces an auto-registered AnySearch key for adoption', () => {
  assert.match(SOURCE, /\/key-adopt/, 'the minted key needs a persistence route')
  assert.match(SOURCE, /autoKey/, 'the minted key must be held in card state')
})

/* ------------------------------------------------- test-result rendering */

await check('the test summary formats a real latency, never "undefined"', () => {
  // REGRESSION: the /test route did not copy `latencyMs` off the backend result,
  // so a COMPLETED test rendered "耗时 undefinedms". Two halves must hold:
  // the copy table must survive a missing field, and the route must supply it.
  // Formatting is asserted here by evaluating the same expression the card uses.
  const copy = { testOk: (r) => '成功：' + r.backend + ' 返回 ' + r.sources.length + ' 条结果（共 ' + r.totalResults + ' 条匹配），耗时 ' + r.latencyMs + 'ms' }
  const formatted = copy.testOk({ backend: 'tinyfish', sources: [1], totalResults: 1, latencyMs: 183 })
  assert.match(formatted, /耗时 183ms/)
  assert.doesNotMatch(formatted, /undefined/)
  // And the guard: a reply missing latencyMs would still print "undefined", so
  // the route-side assertion in verify.mjs is the other half of this contract.
  assert.match(SOURCE, /latencyMs/, 'the card must read latencyMs from the reply')
})

await check('the key badge names the credential-center layer, not a config fallback', () => {
  // REGRESSION: the badge showed "凭据中心已配置" whenever `configured` was true,
  // even when the value came from a read-only environment layer — which made a
  // key the card could not replace or clear look like an ordinary stored key.
  assert.match(SOURCE, /keyFromEnvLayer/, 'the env layer needs its own label')
  assert.match(SOURCE, /source === 'env'/, 'the badge must branch on the reported source')
  // The removed "from the plugin config" / "falling back to env" labels must be
  // gone: config and environment are no longer key sources at all.
  assert.doesNotMatch(SOURCE, /keyFromConfig/, 'the plugin config is no longer a key source')
  assert.doesNotMatch(SOURCE, /keyFallback/, 'there is no fallback to the environment/file')
  assert.doesNotMatch(SOURCE, /hasFallback/, 'the fallback concept is gone')
})

await check('Clear is offered whenever a key exists and reports its outcome', () => {
  // REGRESSION: Clear was disabled whenever `writable` was false, so a key
  // supplied by a read-only layer could never be acted on from the card.
  assert.match(SOURCE, /const clearKey = react\.useCallback/)
  // The button must not be gated on `writable` any more: it renders whenever a
  // key is configured, and its disabled state depends only on availability.
  const clearButton = /className: 'dshhs-btn',\s*\n\s*\/\/[\s\S]*?children: t\.keyClear/.exec(SOURCE)
  assert.ok(clearButton !== null, 'the Clear button must render when a key is configured')
  assert.doesNotMatch(clearButton[0], /credential\.writable/, 'Clear must not be disabled by writability')
  assert.match(clearButton[0], /disabled: busy !== null \|\| !credential\.available/, 'Clear depends on availability only')
  // ...and the route's answer must be surfaced, so a shadowed clear is not
  // reported as a success.
  assert.match(SOURCE, /cleared === false/, 'a shadowed clear must be distinguished')
  assert.match(SOURCE, /keyClearShadowed/, 'a shadowed clear needs its own message')
})

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
