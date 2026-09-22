/**
 * Deploy dsh-hydrasearch into a DSH profile AS A BUNDLE.
 *
 * WHY A BUNDLE AND NOT A PATCHED ROW
 * ----------------------------------
 * The Plugins page enumerates packages: `dsh.profile.bundles` plus
 * `dependencies` (see plugin-manager `listBundles` / `readProfilePlugins`). A
 * bare row in `cordis.patch.yml` is neither, so a row-only install:
 *
 *   - never appears under 已安装, and
 *   - never dispatches its `plugins.row.config` slot, so the configuration card
 *     is unreachable even though the plugin is running.
 *
 * Installing as a bundle gives the row AND the page entry, because the package
 * declares `dsh.bundle.patch` and `dsh.client`.
 *
 * WHY A REAL DIRECTORY AND NOT A SYMLINK
 * --------------------------------------
 * The plugin imports `@deepseek-ai/dsh-web`. Node resolves that by walking up
 * from the module's REAL path, so a symlink or junction whose target lives
 * outside the profile tree resolves from outside it and dies with
 * ERR_MODULE_NOT_FOUND. pnpm's `file:` install materializes a real directory
 * under `<profile>/node_modules`, whose parent walk reaches
 * `$DSH_HOME/profiles/node_modules` and the installation closure. Verified on
 * Node 24.21.0.
 *
 * One canonical source per profile: `<profile>/plugins/<name>/`. The declared
 * `file:` dependency points there and `pnpm install` materializes
 * `node_modules/`. This script mirrors the project into the canonical directory
 * and then runs the install, so both copies stay in step.
 *
 * Usage:
 *   node scripts/deploy.mjs [--profile desktop] [--dsh-home C:\Users\x\.dsh] [--dry-run]
 *
 * Idempotent: mirroring reports exactly what changed.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PACKAGE_NAME = 'dsh-hydrasearch'
const PROFILE_PATCH = 'cordis.patch.yml'

/** Files mirrored from the source tree into the profile. */
const MIRRORED = ['lib', 'scripts', 'docs', 'package.json', PROFILE_PATCH, 'README.md', 'README.en.md', 'LICENSE', 'CHANGELOG.md']

/** Parse `--flag value` and boolean `--flag` arguments. */
function parseArgs(argv) {
  const out = { profile: 'desktop', dshHome: process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--profile') out.profile = argv[++index] ?? out.profile
    else if (arg === '--dsh-home') out.dshHome = argv[++index] ?? out.dshHome
    else throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

/** Recursively list files under `dir`, as paths relative to it. */
function listFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full).map((rel) => path.join(entry.name, rel)))
    else out.push(entry.name)
  }
  return out
}

/** Whether `target` exists and its bytes equal `source`'s. */
function sameFile(source, target) {
  if (!fs.existsSync(target)) return false
  return fs.readFileSync(source).equals(fs.readFileSync(target))
}

/** Delete a path, tolerating a missing one. */
function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true })
}

/**
 * Recursively create `target` as a copy of `source`, reporting whether anything
 * differed. Never creates a symlink: the copy must be a real directory so module
 * resolution walks up through the profile tree.
 *
 * @param source - absolute source path.
 * @param target - absolute destination path.
 * @returns `'unchanged'` or `'updated'`.
 */
function mirror(source, target) {
  const stat = fs.statSync(source)
  if (stat.isDirectory()) {
    let result = 'unchanged'
    fs.mkdirSync(target, { recursive: true })
    for (const name of fs.readdirSync(source)) {
      if (mirror(path.join(source, name), path.join(target, name)) === 'updated') result = 'updated'
    }
    return result
  }
  if (sameFile(source, target)) return 'unchanged'
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
  return 'updated'
}

/**
 * Mirror the package into `destination`, staging beside it first so a
 * half-written plugin is never loadable.
 *
 * @param destination - absolute target directory.
 * @returns the list of top-level entries that changed.
 */
function installInto(destination) {
  const staging = `${destination}.staging`
  rmrf(staging)
  fs.mkdirSync(staging, { recursive: true })
  const changed = []
  for (const entry of MIRRORED) {
    const source = path.join(ROOT, entry)
    if (!fs.existsSync(source)) continue
    if (mirror(source, path.join(staging, entry)) === 'updated') changed.push(entry)
  }
  rmrf(destination)
  fs.renameSync(staging, destination)
  return changed
}

/** Read a JSON file, or `undefined` when absent/unparseable. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

const args = parseArgs(process.argv.slice(2))
const profileDir = path.join(args.dshHome, 'profiles', args.profile)
if (!fs.existsSync(profileDir)) {
  console.error(`profile directory not found: ${profileDir}`)
  process.exit(1)
}

// The canonical in-profile source. `plugins/` (not `vendor/`) because that is
// where this profile already keeps its other vendored plugin, so the layout
// stays consistent.
const canonicalDir = path.join(profileDir, 'plugins', PACKAGE_NAME)
const moduleDir = path.join(profileDir, 'node_modules', PACKAGE_NAME)
const manifestPath = path.join(profileDir, 'package.json')

console.log(`source:    ${ROOT}`)
console.log(`canonical: ${canonicalDir}`)
console.log(`modules:   ${moduleDir}`)

if (args.dryRun) {
  console.log('\ndry run: no files written')
  process.exit(0)
}

// 1. Mirror into the canonical in-profile directory.
const canonicalChanged = installInto(canonicalDir)
console.log(canonicalChanged.length === 0
  ? '\ncanonical: unchanged'
  : `\ncanonical: updated ${canonicalChanged.join(', ')}`)

// 2. Declare the dependency and enable the bundle, so the Plugins page lists it.
const manifest = readJson(manifestPath)
if (manifest === undefined) {
  console.error(`\ncannot read ${manifestPath}`)
  process.exit(1)
}
const before = JSON.stringify(manifest)
manifest.dependencies = manifest.dependencies ?? {}
manifest.dependencies[PACKAGE_NAME] = `file:plugins/${PACKAGE_NAME}`
manifest.dsh = manifest.dsh ?? {}
manifest.dsh.profile = manifest.dsh.profile ?? {}
const bundles = manifest.dsh.profile.bundles ?? []
if (!bundles.includes(PACKAGE_NAME)) bundles.push(PACKAGE_NAME)
manifest.dsh.profile.bundles = bundles
if (JSON.stringify(manifest) !== before) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log('package.json: dependency + bundle entry written')
} else {
  console.log('package.json: unchanged')
}

// 3. Materialize `node_modules/` through pnpm. The declared `file:` dependency
//    must resolve to a REAL directory (never a symlink) or the plugin's
//    `@deepseek-ai/*` imports break; pnpm's hoisted linker does exactly that.
if (canonicalChanged.length > 0 || before !== JSON.stringify(manifest)) {
  const pnpmEntry = path.join(path.dirname(process.execPath), '..', 'pnpm', 'bin', 'pnpm.mjs')
  const pnpm = fs.existsSync(pnpmEntry) ? pnpmEntry : undefined
  if (pnpm === undefined) {
    console.log('\npnpm not found next to this Node; installing node_modules directly')
    const changed = installInto(moduleDir)
    console.log(changed.length === 0 ? 'node_modules: unchanged' : `node_modules: updated ${changed.join(', ')}`)
  } else {
    console.log('\nrunning pnpm install...')
    const result = spawnSync(process.execPath, [pnpm, 'install', '--reporter=silent'], {
      cwd: profileDir,
      stdio: 'inherit',
    })
    if (result.status !== 0) {
      console.error(`pnpm install failed (exit ${String(result.status)}); materializing directly instead`)
      const changed = installInto(moduleDir)
      console.log(changed.length === 0 ? 'node_modules: unchanged' : `node_modules: updated ${changed.join(', ')}`)
    }
  }
}

// 4. Verify the materialized copy is a real directory, not a symlink.
const installed = fs.existsSync(moduleDir) ? fs.lstatSync(moduleDir) : undefined
if (installed === undefined) {
  console.error(`\n${moduleDir} was not created`)
  process.exit(1)
}
if (installed.isSymbolicLink()) {
  console.error('\nREFUSING: node_modules entry is a symlink. The plugin imports')
  console.error('@deepseek-ai/*, which Node resolves from the module REAL path; a')
  console.error('symlink out of the profile tree breaks that walk with')
  console.error('ERR_MODULE_NOT_FOUND. Install a real copy instead.')
  process.exit(1)
}
console.log('node_modules: real directory')

// 5. Warn about a leftover row-only declaration, which would double-compose.
const patchPath = path.join(profileDir, PROFILE_PATCH)
if (fs.existsSync(patchPath) && /^\s*- id: hydrasearch\s*$/m.test(fs.readFileSync(patchPath, 'utf8'))) {
  console.log(`\nNOTE: ${PROFILE_PATCH} still declares a hydrasearch row.`)
  console.log('      Remove it — the bundle patch supplies that row, and a duplicate')
  console.log('      row id is composed twice with the later layer winning silently.')
}

console.log(`\nfiles in ${moduleDir}:`)
for (const rel of listFiles(moduleDir).sort()) console.log(`  ${rel}`)

const patchHasWebOverride = fs.existsSync(patchPath) && /^- id: web\s*$/m.test(fs.readFileSync(patchPath, 'utf8'))
console.log(`
next steps
  1. confirm ${PROFILE_PATCH} points the web seam at the chain. Set BOTH ids:
     a row config REPLACES the whole web config, so setting only one silently
     drops the other and that capability resolves to nothing.${patchHasWebOverride ? '\n     (already present — looks done)' : ''}

       - id: web
         config:
           searchProvider: hydrasearch
           fetchProvider: hydrasearch

  2. restart DeepSeek Harness.

  3. open the Plugins page: 已安装 → ${PACKAGE_NAME} → the row's configure
     control, where the backend priority is dragged and each backend's API
     parameters are edited.

  This profile installs the package from plugins/${PACKAGE_NAME}, so re-run this
  script after changing the source and it will refresh the canonical copy and
  re-materialize node_modules.
`)

