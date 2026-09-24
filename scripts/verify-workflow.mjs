/**
 * Structural validation of `.github/workflows/ci.yml`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The workflow is the only place the plugin's supported-generation matrix is
 * declared, and a mistake there is invisible until GitHub runs it. Two failures
 * already happened in this repository, both from that file:
 *
 *   1. a floating `@deepseek-ai/schemastery@^3.18.2`, which silently changed
 *      what CI tested when 3.18.4 was published — an unchanged commit went red;
 *   2. an install list that did not match the generation being tested.
 *
 * The checks below pin the properties that fix depends on: exact pins only, the
 * four-generation matrix, and the steps that must be skipped for the generation
 * with no `dsh-settings-file` package.
 *
 * Parses the YAML for real when the `yaml` package is resolvable (it is a
 * transitive dependency of `dsh-settings`), and falls back to structural string
 * checks otherwise, so this script never becomes a new way for the suite to fail
 * on a machine with a different dependency tree.
 *
 * Run with: node scripts/verify-workflow.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FILE = path.resolve(HERE, '../.github/workflows/ci.yml')
const SOURCE = fs.readFileSync(FILE, 'utf8')

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

console.log('dsh-hydrasearch CI workflow validation\n')

const YAML = await import('yaml').then((mod) => mod.default ?? mod).catch(() => null)
console.log(YAML === null
  ? '  note the `yaml` package is unavailable; falling back to structural checks\n'
  : '  note parsed with the `yaml` package\n')

await check('the workflow declares the four supported generations, pinned exactly', () => {
  // The pins ARE the fix. A range here is how an unchanged commit changed what
  // CI tested, so this is asserted structurally even without a YAML parser.
  for (const id of ['rc6-3182', 'rc6-3184', 'alpha016', 'rc1']) {
    assert.match(SOURCE, new RegExp(`id:\\s*${id}\\b`), `generation ${id} must be in the matrix`)
  }
  for (const pin of ["'3.18.2'", "'3.18.4'", "'0.1.0-rc.6'", "'0.1.6-alpha.2'", "'0.1.7-rc.1'", "'4.0.1'", "'4.0.2'", "'4.0.4'"]) {
    assert.ok(SOURCE.includes(pin), `expected the exact pin ${pin}`)
  }

  // No floating range may survive anywhere in an install command.
  assert.doesNotMatch(SOURCE, /@deepseek-ai\/[a-z-]+@[\^~]/, 'no floating @deepseek-ai range may remain')
  assert.doesNotMatch(SOURCE, /(react|react-dom)@[\^~]/, 'react must be pinned exactly too')
})

await check('the install step pins every dependency to the matrix entry', () => {
  assert.match(SOURCE, /schemastery@\$\{\{ matrix\.generation\.schemastery \}\}/)
  assert.match(SOURCE, /cordis@\$\{\{ matrix\.generation\.cordis \}\}/)
  assert.match(SOURCE, /dsh-web@\$\{\{ matrix\.generation\.dsh \}\}/)
  // dsh-settings-file does not exist for 0.1.7-rc.1, so it must be conditional.
  assert.match(SOURCE, /settingsFile/, 'the settings-file flag must be declared')
  assert.match(SOURCE, /PKGS\+=/, 'the settings-file package must be added conditionally')
  // The self-referential peer graph still needs this flag.
  assert.match(SOURCE, /--legacy-peer-deps/)
})

await check('the suites that need a file-backed settings service are gated', () => {
  for (const suite of ['verify-integration.mjs', 'verify-e2e.mjs']) {
    assert.match(SOURCE, new RegExp(`run: node scripts/${suite.replace('.', '\\.')}`), `${suite} must be run`)
  }
  const gates = [...SOURCE.matchAll(/if:\s*matrix\.generation\.settingsFile/g)]
  assert.equal(gates.length, 2, 'both file-provider suites must carry the settingsFile gate')
})

await check('the install step reports the versions that actually landed', () => {
  // A silent resolution change is the failure mode this job exists to expose, so
  // the job must echo what npm installed rather than trust the request.
  for (const pkg of ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-web', '@deepseek-ai/cordis']) {
    assert.ok(SOURCE.includes(pkg), `${pkg} must appear in the version readout`)
  }
  assert.match(SOURCE, /\.version/, 'the readout must print a resolved version')
})

if (YAML !== null) {
  await check('the workflow parses as YAML and the matrix is well formed', () => {
    const doc = YAML.parse(SOURCE)
    const matrix = doc.jobs.test.strategy.matrix
    assert.deepEqual(matrix.node, ['20', '22'])
    assert.equal(matrix.generation.length, 4)
    const byId = Object.fromEntries(matrix.generation.map((entry) => [entry.id, entry]))
    assert.deepEqual(Object.keys(byId).sort(), ['alpha016', 'rc1', 'rc6-3182', 'rc6-3184'])
    assert.equal(byId.rc1.settingsFile, false, 'rc.1 has no dsh-settings-file package')
    assert.equal(byId.rc1.dsh, '0.1.7-rc.1')
    assert.equal(byId['rc6-3182'].schemastery, '3.18.2')
    assert.equal(byId['rc6-3184'].schemastery, '3.18.4')

    for (const entry of matrix.generation) {
      for (const key of ['dsh', 'cordis', 'schemastery']) {
        assert.doesNotMatch(String(entry[key]), /[\^~><*]|\bx\b/, `${entry.id}.${key} must be an exact pin, got ${entry[key]}`)
      }
    }

    const steps = doc.jobs.test.steps
    const install = steps.find((step) => step.name === 'Install DSH service modules')
    assert.ok(install, 'the install step must exist')
    assert.match(install.run, /legacy-peer-deps/)

    for (const name of ['In-process integration checks', 'End-to-end regression proof']) {
      const step = steps.find((entry) => entry.name === name)
      assert.ok(step, `${name} must exist`)
      assert.equal(step.if, 'matrix.generation.settingsFile', `${name} must be gated on settingsFile`)
    }
  })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
