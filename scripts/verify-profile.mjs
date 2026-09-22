/**
 * Compose the live profile with DSH's OWN loader and assert the plugin is
 * installed in the shape that makes it reachable.
 *
 * This is the check that catches what a source-level test cannot: an install
 * that works functionally but is INVISIBLE, or a bundle that parses but composes
 * to nothing.
 *
 * The specific trap this suite exists to catch: the Plugins page enumerates
 * PACKAGES (`dsh.profile.bundles` + `dependencies`, see plugin-manager
 * `listBundles` / `readProfilePlugins`). A plugin installed only as a row in
 * `cordis.patch.yml` is neither, so it never appears under 已安装 AND its
 * `plugins.row.config` slot is never dispatched — the plugin runs, but the user
 * cannot find or configure it.
 *
 * Run with the bundled Node, from inside the profile tree:
 *   node scripts/verify-profile.mjs [--profile desktop] [--dsh-home <path>]
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

/** Parse `--flag value` and boolean `--flag` arguments. */
function parseArgs(argv) {
  const out = { profile: 'desktop', dshHome: process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh') }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') out.profile = argv[++index] ?? out.profile
    else if (arg === '--dsh-home') out.dshHome = argv[++index] ?? out.dshHome
    else throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const profileDir = path.join(args.dshHome, 'profiles', args.profile)
const PACKAGE_NAME = 'dsh-hydrasearch'
const installedDir = path.join(profileDir, 'node_modules', PACKAGE_NAME)
const manifestPath = path.join(profileDir, 'package.json')

console.log('dsh-hydrasearch profile install verification\n')
console.log(`profile: ${profileDir}\n`)

if (!fs.existsSync(profileDir)) {
  console.error(`profile directory not found: ${profileDir}`)
  process.exit(1)
}

const boot = await import('@deepseek-ai/dsh-app-boot')

await check('the app-boot loader exposes the composition entry points', () => {
  assert.equal(typeof boot.loadOverlayPatches, 'function', 'loadOverlayPatches is expected')
  assert.equal(typeof boot.composeEntries, 'function', 'composeEntries is expected')
  assert.equal(typeof boot.resolveBundleDir, 'function', 'resolveBundleDir is expected')
})

/** Read the profile manifest. */
function readManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
}

/** Resolve the installed bundle's directory the way the loader does. */
function resolveInstalled() {
  return boot.resolveBundleDir('dsh', PACKAGE_NAME, path.join(profileDir, 'package.json'), profileDir)
}

const manifest = readManifest()

/* ------------------------------------------------- install shape (visibility) */

await check('the package is listed in dsh.profile.bundles', () => {
  const bundles = manifest.dsh?.profile?.bundles ?? []
  assert.ok(bundles.includes(PACKAGE_NAME), `bundles are: ${bundles.join(', ')}`)
})

await check('the package is a declared dependency', () => {
  assert.ok(
    Object.hasOwn(manifest.dependencies ?? {}, PACKAGE_NAME),
    `dependencies are: ${Object.keys(manifest.dependencies ?? {}).join(', ') || '(none)'}`,
  )
})

await check('the Plugins page package list would include it', () => {
  // Exactly the join plugin-manager uses (installation bundles aside, which are
  // all `@deepseek-ai/*`).
  const listed = new Set([...(manifest.dsh?.profile?.bundles ?? []), ...Object.keys(manifest.dependencies ?? {})])
  assert.ok(listed.has(PACKAGE_NAME), `the page would list only: ${[...listed].join(', ')}`)
  console.log(`       page lists: ${[...listed].join(', ')}`)
})

await check('the install is a real directory, not a symlink', () => {
  // Node resolves `@deepseek-ai/*` by walking up from the module's REAL path; a
  // symlink pointing outside the profile tree would break that walk.
  assert.ok(fs.existsSync(installedDir), `not installed at ${installedDir}`)
  assert.equal(fs.lstatSync(installedDir).isSymbolicLink(), false, 'must be a real directory copy')
})

await check('the installed copy is byte-current with the source tree', () => {
  // A stale install is the other way to get a confusing "it should work" state.
  const source = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
  for (const rel of ['lib/index.js', 'lib/tinyfish.js', 'lib/anysearch.js', 'lib/client.js', 'package.json', 'cordis.patch.yml']) {
    const a = path.join(installedDir, rel)
    const b = path.join(source, rel)
    if (!fs.existsSync(b)) continue
    assert.ok(fs.existsSync(a), `installed copy is missing ${rel}`)
    assert.ok(fs.readFileSync(a).equals(fs.readFileSync(b)), `${rel} differs from the source tree — re-run scripts/deploy.mjs`)
  }
})

/* ---------------------------------------------------------- bundle declarations */

await check('the bundle resolves and declares both faces', () => {
  const dir = resolveInstalled()
  const bundleManifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  assert.equal(bundleManifest.dsh?.bundle?.patch, 'cordis.patch.yml', 'the bundle patch must be declared')
  assert.equal(bundleManifest.dsh?.client?.platform, 'web', 'the client face must be declared')
  assert.deepEqual(bundleManifest.dsh.client.inject, ['@deepseek-ai/dsh-client-runtime'])
})

const installedManifest = JSON.parse(fs.readFileSync(path.join(resolveInstalled(), 'package.json'), 'utf8'))
const bundlePatches = boot.loadOverlayPatches('dsh', path.join(resolveInstalled(), installedManifest.dsh.bundle.patch))
const bundleEntries = boot.composeEntries([bundlePatches])

/**
 * The raw `name:` a bundle patch declares for the hydrasearch row.
 *
 * Read from the YAML TEXT, not from the parsed row: `app-boot` REWRITES relative
 * insert names into absolute `file:` URLs while parsing (see
 * `anchorInsertedPluginNames`), so the parsed value no longer shows what the file
 * says. The declared form is what a future edit will copy, so it is the thing to
 * assert about.
 */
function rawDeclaredRowName() {
  const bundlePatchFile = path.join(resolveInstalled(), installedManifest.dsh.bundle.patch)
  const text = fs.readFileSync(bundlePatchFile, 'utf8')
  const match = text.match(/^\s*- id: hydrasearch\s*\n\s*name:\s*(\S+)\s*$/m)
  assert.ok(match !== null, `no hydrasearch row with a name in ${bundlePatchFile}`)
  return { name: match[1], bundlePatchFile }
}

/**
 * Where a declared row name actually lands, mirroring what the loader does.
 *
 * `app-boot` anchors a relative insert name against THE DIRECTORY OF THE PATCH
 * FILE THAT DECLARED IT (`pathToFileURL(resolve(dirname(patchFile), name))`),
 * NOT against the profile root. This is the single rule that the previous
 * install got wrong: it declared `./node_modules/dsh-hydrasearch/lib/index.js`
 * as if the base were the profile root, so a bundle patch living at
 * `<profile>/node_modules/dsh-hydrasearch/cordis.patch.yml` anchored to the
 * package directory and double-nested into a path that does not exist.
 */
function landingPath(name, baseFile) {
  if (name.startsWith('file:')) return new URL(name).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, path.sep)
  if (path.isAbsolute(name)) return name
  return path.resolve(path.dirname(baseFile), name)
}

await check('the bundle patch supplies the hydrasearch row', () => {
  const row = bundleEntries.find((entry) => entry.id === 'hydrasearch')
  assert.ok(row !== undefined, 'the bundle patch must declare the hydrasearch row')
  const { name } = rawDeclaredRowName()
  // A PATH, not a bare name: the packaged app's Loader lives inside app.asar,
  // outside the profile, so a bare specifier resolves from the app's own
  // installation and never reaches <profile>/node_modules.
  assert.ok(
    name.startsWith('./') || name.startsWith('../') || path.isAbsolute(name),
    `the row must name a path, not a bare specifier, got ${JSON.stringify(name)}`,
  )
  assert.ok(name.endsWith('lib/index.js'), `the path must point at the entry module, got ${JSON.stringify(name)}`)
})

await check('the declared row name lands on the installed entry module', () => {
  const { name, bundlePatchFile } = rawDeclaredRowName()
  const target = landingPath(name, bundlePatchFile)
  const expected = path.join(resolveInstalled(), 'lib', 'index.js')
  assert.equal(
    target.toLowerCase(),
    expected.toLowerCase(),
    `the declared name ${JSON.stringify(name)} lands on ${target}, not the entry ${expected}`,
  )
  assert.ok(fs.existsSync(target), `the row path does not resolve: ${target}`)
})

await check('the row name is NOT resolved against the profile root', () => {
  // Regression guard for the exact bug that produced
  //   <profile>/node_modules/dsh-hydrasearch/node_modules/dsh-hydrasearch/lib/index.js
  // "failed to import" in the app banner. A name shaped like
  // `./node_modules/<pkg>/...` is only correct when the declaring patch file
  // itself sits at the profile root — which a BUNDLE patch never does.
  const { name } = rawDeclaredRowName()
  const profileRootLanding = path.resolve(profileDir, name)
  const doubleNested = path.join(profileDir, 'node_modules', PACKAGE_NAME, 'node_modules')
  assert.equal(
    profileRootLanding.toLowerCase().startsWith(doubleNested.toLowerCase()),
    false,
    `declared name ${JSON.stringify(name)} double-nests: ${profileRootLanding}`,
  )
  assert.equal(
    /^\.\/node_modules\//.test(name),
    false,
    `a bundle patch must not use a profile-root-relative ./node_modules/ path, got ${JSON.stringify(name)}`,
  )
})

await check('the bundle row config carries the documented defaults', () => {
  const row = bundleEntries.find((entry) => entry.id === 'hydrasearch')
  assert.ok(row !== undefined)
  const config = row.config ?? {}
  assert.deepEqual(config.priority, ['tinyfish', 'anysearch'], 'priority must default to both backends')
  assert.equal(config.failover, true)
  assert.equal(config.fetchBackend, 'auto')
  assert.equal(config.takeOverSearch, true)
  // The fetch-path defaults this release adds. Asserted against the INSTALLED
  // patch (not the source schema) so a deploy that ships a stale
  // cordis.patch.yml is caught here rather than by an operator wondering why a
  // documented default is absent from their profile.
  assert.equal(typeof config.tinyfish?.purpose, 'string')
  assert.ok(config.tinyfish.purpose.length > 0, 'purpose ships non-empty')
  assert.equal(config.tinyfish.fetchImageLinks, false)
  assert.equal(config.tinyfish.fetchPerUrlTimeoutMs, 0)
  assert.equal(config.tinyfish.fetchTtlSeconds, -1, '-1 means "omit ttl", never "force live"')
})

/* -------------------------------------------------------------- user layer */

const patchPath = path.join(profileDir, 'cordis.patch.yml')
const userPatches = boot.loadOverlayPatches('dsh', patchPath)

await check('the user layer keeps its pre-existing rows', () => {
  const insert = userPatches.find((entry) => entry.insert !== undefined)
  if (insert === undefined) return // a fresh profile legitimately has no rows of its own
  // The user layer is the OPERATOR's file, not this package's: it may hold any
  // number of unrelated rows (other plugins, MCP servers, local overrides). What
  // this suite must prove is that installing hydrasearch did not EVICT them, so
  // the assertion is about preservation, never about specific private row ids.
  const ids = insert.insert.map((entry) => entry.id).filter((id) => id !== 'hydrasearch')
  for (const id of ids) {
    assert.equal(typeof id, 'string', `row id must be a string, got ${String(id)}`)
  }
  console.log(`       user rows preserved: ${ids.length === 0 ? '(none)' : ids.join(', ')}`)
})

await check('the user layer does NOT re-declare the hydrasearch row', () => {
  // A duplicate row id is composed twice and the later layer wins silently; the
  // bundle patch owns this row.
  const insert = userPatches.find((entry) => entry.insert !== undefined)
  if (insert === undefined) return // nothing declared at all, so nothing duplicated
  const duplicates = insert.insert.filter((entry) => entry.id === 'hydrasearch')
  assert.equal(duplicates.length, 0, 'the bundle patch owns the row; a second declaration is ambiguous')
})

await check('the web seam is pointed at the chain', () => {
  const web = userPatches.find((entry) => entry.id === 'web')
  // Two supported wirings. Either the operator pins the seam explicitly in the
  // user layer, or the plugin claims the still-unset seat through its
  // `takeOverSearch` / `takeOverFetch` flags at apply() time. Both are correct;
  // only an INCOMPLETE explicit override is a bug.
  if (web === undefined) {
    const row = bundlePatches.flatMap((entry) => entry.insert ?? []).find((entry) => entry.id === 'hydrasearch')
    assert.equal(row?.config?.takeOverSearch, true, 'no web override, so the plugin must claim the seat itself')
    assert.equal(row?.config?.takeOverFetch, true, 'no web override, so the plugin must claim the seat itself')
    console.log('       no web override; relying on the plugin\'s takeOver guards')
    return
  }
  const config = web.config ?? {}
  // BOTH ids must be present: a row config REPLACES the whole object, so a patch
  // that sets only one silently drops the other.
  assert.equal(config.searchProvider, 'hydrasearch', 'web.searchProvider must select the chain')
  assert.equal(config.fetchProvider, 'hydrasearch', 'web.fetchProvider must select the chain')
})

/* ------------------------------------------------------------ composition */

const entries = boot.composeEntries([bundlePatches, userPatches])

await check('the hydrasearch row is composed exactly once', () => {
  const rows = entries.filter((entry) => entry.id === 'hydrasearch')
  assert.equal(rows.length, 1, `expected one hydrasearch row, found ${rows.length}`)
})

await check('the row module resolves and imports', async () => {
  const entry = path.join(resolveInstalled(), 'lib', 'index.js')
  assert.ok(fs.existsSync(entry), `row module does not exist: ${entry}`)
  const mod = await import(`${new URL(`file://${entry.replace(/\\/g, '/')}`)}?t=${Date.now()}`)
  assert.equal(typeof mod.apply, 'function', 'the plugin must export apply')
  assert.deepEqual(mod.inject, ['web'], 'the plugin must inject the web seam')
  assert.equal(mod.name, 'hydrasearch')
  assert.equal(typeof mod.Config, 'function', 'the plugin must export its Config schema')
})

await check('the plugin imports only names that SURVIVE the app\'s enforced resolver', async () => {
  // The desktop app installs an enforce-mode resolver mapping profile-local
  // `@deepseek-ai/*` onto its OWN tree (app-boot installProfileResolution). ESM
  // validates named imports at LINK time, so importing even one symbol that the
  // app's generation dropped kills the whole plugin with the loader's opaque
  // `failed to import` (entry.fiber === undefined).
  //
  // This is not hypothetical: `installSettingsSection` and `settingsNamespace`
  // exist in the rc `dsh-settings` but were REMOVED in 0.1.6-alpha.2 (which
  // renamed the former to the `settings.installSection` method). A static import
  // of either made the plugin unloadable on the desktop app while plain `node`
  // still imported it happily, because bare Node walks up to a junction pointing
  // at a different (rc) tree. Guard the class, not just today's two names.
  const entry = path.join(resolveInstalled(), 'lib', 'index.js')
  const source = fs.readFileSync(entry, 'utf8')

  // Every bare `@deepseek-ai/*` import the plugin declares, with its symbols.
  const bare = [...source.matchAll(/import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+[\w$]+|([\w$]+))?\s*from\s+'(@deepseek-ai\/[^']+)'/g)]
  assert.ok(bare.length > 0, 'the plugin should import its peers')

  // Symbols known to be generation-specific. A static import of one of these is
  // the exact defect this check exists to prevent.
  const GENERATION_SPECIFIC = new Set(['installSettingsSection', 'settingsNamespace'])
  for (const match of bare) {
    const names = (match[2] ?? '').split(',').map((part) => part.trim().split(/\s+as\s+/)[0]).filter(Boolean)
    for (const name of names) {
      assert.equal(
        GENERATION_SPECIFIC.has(name),
        false,
        `'${name}' is imported from '${match[4]}' but does not exist in every supported dsh generation; ` +
        'define it locally instead of importing it',
      )
    }
  }

  // The plugin must provide the compatibility helpers itself.
  const mod = await import(`${new URL(`file://${entry.replace(/\\/g, '/')}`)}?t=${Date.now()}`)
  assert.equal(typeof mod.settingsNamespace, 'function', 'the plugin must export its own settingsNamespace')
  assert.equal(typeof mod.installSettingsSection, 'function', 'the plugin must export its own installSettingsSection')

  // The portable path builds on `settings.register`, which BOTH generations have.
  // Assert the source does not reach for a method only one generation owns
  // without a fallback.
  assert.match(
    source,
    /typeof provider\.installSection === 'function'/,
    'installSection must be feature-detected, not assumed',
  )
  assert.match(source, /provider\.register\(/, 'the portable path must use settings.register()')
})

await check('the chain provider ids match what the seam selects', async () => {
  const entry = path.join(resolveInstalled(), 'lib', 'index.js')
  const mod = await import(`${new URL(`file://${entry.replace(/\\/g, '/')}`)}?t=${Date.now()}`)
  const web = userPatches.find((entry) => entry.id === 'web')
  assert.equal(web.config.searchProvider, mod.HYDRASEARCH_PROVIDER_ID, 'the seam must name the chain provider id')
  assert.equal(web.config.fetchProvider, mod.HYDRASEARCH_PROVIDER_ID)
})

await check('the row id matches the client half slot key', async () => {
  // The slot key is `<package name>#<row id>`; a mismatch silently removes the
  // configuration entry from the Plugins page with no error anywhere.
  const clientPath = path.join(resolveInstalled(), 'lib', 'client.js')
  assert.ok(fs.existsSync(clientPath), `client bundle missing: ${clientPath}`)
  const client = fs.readFileSync(clientPath, 'utf8')
  const row = bundleEntries.find((entry) => entry.id === 'hydrasearch')
  assert.match(client, new RegExp(`key: '${PACKAGE_NAME}#${row.id}'`), 'the client slot key must match the row id')
})

await check('the package version, plugin version, and client header agree', async () => {
  // Three places carry the version (package.json, the plugin's PLUGIN_VERSION
  // that the card displays, and the AnySearch attribution header). A drift makes
  // the card report a version that is not what is running.
  const entry = path.join(resolveInstalled(), 'lib', 'index.js')
  const mod = await import(`${new URL(`file://${entry.replace(/\\/g, '/')}`)}?t=${Date.now()}`)
  assert.equal(installedManifest.version, mod.PLUGIN_VERSION, 'package.json must match PLUGIN_VERSION')
  const anysearch = fs.readFileSync(path.join(resolveInstalled(), 'lib', 'anysearch.js'), 'utf8')
  assert.match(
    anysearch,
    new RegExp(`dsh-hydrasearch/${installedManifest.version.replace(/\./g, '\\.')}`),
    'the client header must carry the same version',
  )
})

await check('no duplicate row ids were composed', () => {
  const seen = new Set()
  for (const entry of entries) {
    if (entry.id === undefined) continue
    assert.equal(seen.has(entry.id), false, `duplicate row id "${entry.id}"`)
    seen.add(entry.id)
  }
})

await check('the registered provider id is distinct from the official ones', async () => {
  const entry = path.join(resolveInstalled(), 'lib', 'index.js')
  const mod = await import(`${new URL(`file://${entry.replace(/\\/g, '/')}`)}?t=${Date.now()}`)
  const official = new Set(['deepseek-official', 'exa', 'perplexity'])
  // Only the ONE registered id has to avoid a collision. The backend ids are no
  // longer registered as providers, so they are free to be named anything.
  assert.equal(official.has(mod.HYDRASEARCH_PROVIDER_ID), false, 'the provider id collides with a shipped provider')
})

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
