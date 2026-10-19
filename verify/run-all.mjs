#!/usr/bin/env node
/**
 * Offline verification for the dsh-followup-prompt bundle.
 *
 * Runs, in order:
 *   1. `node --check` on every runtime JavaScript file;
 *   2. package manifest / exports / `files` integrity;
 *   3. locale JSON, icon, and bundle patch sanity;
 *   4. Host and Client stub-driven smoke scripts;
 *   5. `pnpm pack --dry-run` packed-file inspection (skipped for `--checks`).
 *
 * Usage:
 *   node verify/run-all.mjs            # full offline verification
 *   node verify/run-all.mjs --checks   # static checks only
 *   node verify/run-all.mjs --no-pack  # everything except tarball inspection
 *
 * Exits non-zero when a required check fails. This is an offline contract and
 * assembly check — it does not prove live behavior inside the Harness.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = new Set(process.argv.slice(2))
const checksOnly = argv.has('--checks')
const noPack = checksOnly || argv.has('--no-pack')

const EXPECTED_CONFIG_KEYS = [
  'enabled',
  'provider',
  'model',
  'reasoningEffort',
  'maxTokens',
  'timeoutMs',
  'maxTurns',
  'maxInputChars',
  'maxToolRejectRounds',
  'toolRejectionText',
  'maxSuggestionChars',
  'stripMedia',
  'sampleRate',
  'prefetchOnTurnEnd',
  'cacheTtlMs',
  'maxConcurrent',
  'excludeSubagents',
  'uiMode',
  'prompt',
]

const REQUIRED_PACKED_FILES = [
  'host/index.js',
  'host/config.js',
  'host/prediction.js',
  'host/cache.js',
  'host/channel.js',
  'client.js',
  'cordis.patch.yml',
  'locale/en.json',
  'locale/zh.json',
  'icon.svg',
  'docs/protocol.md',
  'README.md',
  'LICENSE',
]

let passed = 0
const failures = []
let skipped = 0

function pass(name, detail = '') {
  passed += 1
  console.log(`  \u2713 ${name}${detail ? ` — ${detail}` : ''}`)
}

function fail(name, detail) {
  failures.push({ name, detail })
  console.log(`  \u2717 ${name} — ${detail}`)
}

function skip(name, detail) {
  skipped += 1
  console.log(`  \u2500 ${name} — skipped (${detail})`)
}

function read(path) {
  return readFileSync(join(root, path), 'utf8')
}

function nodeCheck(path) {
  const result = spawnSync(process.execPath, ['--check', path], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `exit ${result.status}`).trim())
  }
}

/**
 * Parse one scalar value from the flat `config:` block of cordis.patch.yml.
 * Only the YAML subset this patch uses is supported (quoted strings, booleans,
 * integers/floats); anything else is returned as its trimmed text.
 * @param {string} text - raw scalar text after `key:`.
 * @returns {string | number | boolean | undefined} the parsed value.
 */
function parsePatchScalar(text) {
  const value = text.trim()
  if (value === '') return undefined
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1)
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  return value
}

// ── 1. Syntax ────────────────────────────────────────────────────────────────
console.log('\n[1/5] JavaScript syntax')
const runtimeJs = ['client.js']
for (const entry of ['host', 'scripts', 'verify']) {
  const dir = join(root, entry)
  if (!existsSync(dir)) continue
  for (const file of readdirSync(dir)) {
    if (file.endsWith('.js') || file.endsWith('.mjs')) runtimeJs.push(join(entry, file))
  }
}
for (const file of runtimeJs) {
  if (!existsSync(join(root, file))) {
    fail(`syntax ${file}`, 'file missing')
    continue
  }
  try {
    nodeCheck(file)
    pass(`syntax ${file}`)
  } catch (error) {
    fail(`syntax ${file}`, String(error.message ?? error))
  }
}

// ── 2. Package manifest, exports, files ─────────────────────────────────────
console.log('\n[2/5] package.json / exports / files')
let pkg
try {
  pkg = JSON.parse(read('package.json'))
  if (pkg.name !== 'dsh-followup-prompt') throw new Error(`unexpected name ${JSON.stringify(pkg.name)}`)
  if (pkg.type !== 'module') throw new Error('type must be "module"')
  if (!pkg.exports || typeof pkg.exports !== 'object') throw new Error('exports is missing')
  for (const key of ['.', './client', './icon', './package.json']) {
    if (!(key in pkg.exports)) throw new Error(`exports is missing ${key}`)
  }
  if (!pkg.exports['./locale/*.json']) throw new Error('exports is missing ./locale/*.json')
  if (!pkg.dsh?.bundle?.patch) throw new Error('dsh.bundle.patch is missing')
  if (pkg.dsh?.client?.platform !== 'web') throw new Error('dsh.client.platform must be "web"')
  if (!pkg.files?.includes('host/') || !pkg.files?.includes('client.js')) {
    throw new Error('files must include host/ and client.js')
  }
  pass('package.json manifest', `${pkg.name}@${pkg.version}`)
} catch (error) {
  fail('package.json manifest', String(error.message ?? error))
}

if (pkg?.exports) {
  for (const [key, target] of Object.entries(pkg.exports)) {
    if (key === './package.json') continue
    if (key.includes('*')) {
      // Expand a wildcard target against its directory and confirm at least one file.
      const dir = dirname(join(root, String(target)))
      const extension = String(target).split('.').pop()
      const found = existsSync(dir)
        && readdirSync(dir).some((name) => name.endsWith(`.${extension}`))
      if (found) pass(`exports ${key}`)
      else fail(`exports ${key}`, `no ${extension} file under ${dir}`)
      continue
    }
    const path = join(root, String(target))
    if (existsSync(path)) pass(`exports ${key} -> ${target}`)
    else fail(`exports ${key}`, `target missing: ${target}`)
  }
}

if (Array.isArray(pkg?.files)) {
  for (const pattern of pkg.files) {
    if (pattern.includes('*')) {
      const dir = dirname(join(root, pattern))
      const extension = pattern.split('.').pop()
      const found = existsSync(dir) && readdirSync(dir).some((name) => name.endsWith(`.${extension}`))
      if (found) pass(`files ${pattern}`)
      else fail(`files ${pattern}`, `unmatched under ${dir}`)
      continue
    }
    const path = join(root, pattern)
    if (existsSync(path)) pass(`files ${pattern}`)
    else fail(`files ${pattern}`, 'missing on disk')
  }
}

// ── 3. Locale, icon, patch ──────────────────────────────────────────────────
console.log('\n[3/5] locale / icon / bundle patch')
try {
  for (const locale of ['en', 'zh']) {
    const document = JSON.parse(read(`locale/${locale}.json`))
    if (typeof document?.meta?.title !== 'string' || document.meta.title.length === 0) {
      throw new Error(`locale/${locale}.json meta.title is missing`)
    }
    if (typeof document?.meta?.description !== 'string' || document.meta.description.length === 0) {
      throw new Error(`locale/${locale}.json meta.description is missing`)
    }
  }
  pass('locale resources', 'en + zh meta.title/meta.description')
} catch (error) {
  fail('locale resources', String(error.message ?? error))
}

try {
  const icon = join(root, 'icon.svg')
  if (!existsSync(icon)) throw new Error('icon.svg is missing')
  const bytes = statSync(icon).size
  if (bytes > 256 * 1024) throw new Error(`icon.svg is ${bytes} bytes (>256 KiB)`)
  const text = readFileSync(icon, 'utf8').trimStart()
  if (!text.startsWith('<svg')) throw new Error('icon.svg does not start with <svg')
  pass('icon.svg', `${bytes} bytes, valid SVG root`)
} catch (error) {
  fail('icon.svg', String(error.message ?? error))
}

try {
  const patch = read('cordis.patch.yml')
  if (/\t/.test(patch)) throw new Error('patch contains tab characters')
  if (!/^\s*-\s*insert:\s*$/m.test(patch)) throw new Error('patch has no insert block')
  if (!/^\s*-\s*id:\s*followup-prompt\s*$/m.test(patch)) throw new Error('patch row id is not followup-prompt')
  if (!/^\s*name:\s*dsh-followup-prompt\s*$/m.test(patch)) throw new Error('patch row name is not dsh-followup-prompt')
  // `config:` is a mapping key under the inserted list item; its indent is
  // 4/6/8 spaces depending on the patch style (plan §6.2 uses 4). Read the
  // direct children of that block instead of hard-coding an indent.
  const configMatch = patch.match(/^([ ]*)config:\s*$/m)
  if (configMatch === null) throw new Error('patch row has no config block')
  const configIndent = configMatch[1].length
  const configBlock = patch.slice(configMatch.index + configMatch[0].length)
  const keys = []
  const values = new Map()
  for (const line of configBlock.split('\n')) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    const child = line.match(/^([ ]*)([A-Za-z][A-Za-z0-9]*):(.*)$/)
    if (child === null) continue
    if (child[1].length <= configIndent) break
    if (child[1].length === configIndent + 2) {
      keys.push(child[2])
      values.set(child[2], parsePatchScalar(child[3]))
    }
  }
  const missing = EXPECTED_CONFIG_KEYS.filter((key) => !keys.includes(key))
  const unknown = keys.filter((key) => !EXPECTED_CONFIG_KEYS.includes(key))
  if (missing.length > 0) throw new Error(`patch config is missing fields: ${missing.join(', ')}`)
  if (unknown.length > 0) throw new Error(`patch config has unknown fields: ${unknown.join(', ')}`)

  // Cross-check both the field set and every default against the Host schema so
  // the patch (which replaces the whole row config) cannot drift from Config.
  let defaults
  try {
    const module = await import(pathToFileURL(join(root, 'host/config.js')).href)
    defaults = module.DEFAULTS
  } catch (error) {
    throw new Error(`cannot import host/config.js (run "npm run links" first): ${String(error.message ?? error)}`)
  }
  const schemaKeys = Object.keys(defaults)
  if (JSON.stringify(schemaKeys) !== JSON.stringify(EXPECTED_CONFIG_KEYS)) {
    throw new Error('EXPECTED_CONFIG_KEYS is out of sync with host/config.js DEFAULTS')
  }
  const mismatched = []
  for (const key of keys) {
    if (!Object.is(values.get(key), defaults[key])) {
      mismatched.push(`${key}: patch ${JSON.stringify(values.get(key))} != default ${JSON.stringify(defaults[key])}`)
    }
  }
  if (mismatched.length > 0) throw new Error(`patch defaults differ from Config: ${mismatched.join('; ')}`)
  pass('cordis.patch.yml', `row followup-prompt, ${keys.length} config fields match Config defaults`)
} catch (error) {
  fail('cordis.patch.yml', String(error.message ?? error))
}

// ── 4. Entry contracts + stub smoke scripts ────────────────────────────────
console.log('\n[4/5] Host/Client entry contracts, Config schema, and stub smoke tests')
try {
  const { Config, DEFAULTS: configDefaults, resolveConfig } = await import(
    pathToFileURL(join(root, 'host/config.js')).href
  )
  // The Loader validates the row config through this schema; volatile fields
  // arrive as live `{ get() }` refs, which resolveConfig must unwind.
  const validated = Config(configDefaults)
  const resolvedValidated = resolveConfig(validated)
  for (const key of Object.keys(configDefaults)) {
    if (!Object.is(resolvedValidated[key], configDefaults[key])) {
      throw new Error(`resolveConfig(${key}) = ${JSON.stringify(resolvedValidated[key])}`)
    }
  }
  // An empty row config must materialize every documented default through the schema.
  const resolvedEmpty = resolveConfig(Config({}))
  for (const key of Object.keys(configDefaults)) {
    if (!Object.is(resolvedEmpty[key], configDefaults[key])) {
      throw new Error(`empty config default ${key} = ${JSON.stringify(resolvedEmpty[key])}`)
    }
  }
  // Documented bounds must reject an impossible row instead of half-applying it.
  let rejected = false
  try {
    Config({ ...configDefaults, maxConcurrent: 999 })
  } catch {
    rejected = true
  }
  if (!rejected) throw new Error('Config accepted maxConcurrent 999 (outside 1..16)')
  // A half-configured provider/model pair must fall back to the session route.
  const pair = resolveConfig(Config({ ...configDefaults, provider: 'p', model: '' }))
  if (pair.provider !== '' || pair.model !== '') throw new Error('half-configured provider/model pair was not dropped')
  pass('Config schema', '19 defaults / volatile refs / bounds / provider-model pair')
} catch (error) {
  fail('Config schema', String(error.message ?? error))
}

try {
  const host = read('host/index.js')
  if (!/export\s+const\s+name\s*=\s*['"]followup-prompt['"]/.test(host)) throw new Error('host name export is missing')
  const injectMatch = host.match(/export\s+const\s+inject\s*=\s*\[([^\]]*)\]/)
  if (injectMatch === null) throw new Error('host inject export is missing')
  const injectNames = [...injectMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1])
  for (const required of ['connection', 'llm', 'sessions', 'webServer']) {
    if (!injectNames.includes(required)) throw new Error(`host inject is missing "${required}"`)
  }
  if (!/export\s+const\s+Config\b/.test(host)) throw new Error('host Config export is missing')
  if (!/export\s+function\s+apply\s*\(/.test(host)) throw new Error('host apply export is missing')
  pass('host entry contract', `name / inject [${injectNames.join(', ')}] / Config / apply`)
} catch (error) {
  fail('host entry contract', String(error.message ?? error))
}

try {
  const client = read('client.js')
  if (!client.includes('window.__ModuleLoader__.load(')) throw new Error('ModuleLoader registration is missing')
  if (!/id:\s*['"]dsh-followup-prompt['"]/.test(client)) throw new Error('client module id is not dsh-followup-prompt')
  if (!/require\(\s*['"]react['"]\s*\)/.test(client)) throw new Error("client does not require('react') from the module table")
  // The browser half is loaded as a classic script by the ModuleLoader: an
  // import/export statement would parse only under ESM and never execute.
  if (/^\s*(?:import|export)\s/m.test(client)) throw new Error('client.js must be a classic script (no import/export)')
  if (!client.includes("'conversation.composer.dock'")) throw new Error('composer dock slot is not registered')
  if (!client.includes("'suggestions/wait'")) throw new Error('suggestions/wait endpoint is not called')
  if (!client.includes("'suggestions/dismiss'")) throw new Error('suggestions/dismiss endpoint is not called')
  if (!client.includes('data-composer-input')) throw new Error('[data-composer-input] accept gate is missing')
  if (/\.submit\s*\(/.test(client)) throw new Error('client must never call submit()')
  if (/\bcontenteditable\b/.test(client) && !/data-composer-input/.test(client)) {
    throw new Error('contenteditable referenced without the [data-composer-input] gate')
  }
  pass('client entry contract', 'classic script / module id / dock slot / RPC endpoints / no submit')
} catch (error) {
  fail('client entry contract', String(error.message ?? error))
}

const smokeScripts = ['verify/host-smoke.mjs', 'verify/client-smoke.mjs']
for (const script of smokeScripts) {
  if (!existsSync(join(root, script))) {
    if (checksOnly) skip(script, 'not written yet')
    else fail(script, 'smoke script is missing')
    continue
  }
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', timeout: 120_000 })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status === 0) {
    pass(script, 'exit 0')
    for (const line of output.split('\n').filter(Boolean).slice(-2)) console.log(`      ${line}`)
  } else {
    fail(script, `exit ${result.status}`)
    for (const line of output.split('\n').filter(Boolean).slice(-12)) console.log(`      ${line}`)
  }
}

// ── 5. Packed file list ────────────────────────────────────────────────────
console.log('\n[5/5] packed file list')
if (noPack) {
  skip('pnpm pack --dry-run', checksOnly ? '--checks' : '--no-pack')
} else {
  const result = spawnSync('pnpm', ['pack', '--dry-run'], { cwd: root, encoding: 'utf8', timeout: 180_000 })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.error !== undefined || result.status !== 0) {
    fail('pnpm pack --dry-run', result.error?.message ?? `exit ${result.status}`)
  } else {
    const missing = REQUIRED_PACKED_FILES.filter((file) => !output.includes(file))
    if (missing.length > 0) {
      fail('packed file list', `missing from tarball: ${missing.join(', ')}`)
    } else if (output.includes('node_modules/')) {
      fail('packed file list', 'tarball unexpectedly contains node_modules/')
    } else {
      pass('packed file list', `${REQUIRED_PACKED_FILES.length} required files present`)
    }
  }
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log('\n──────────────────────────────────────────────')
if (failures.length === 0) {
  console.log(`Offline verification PASSED: ${passed} checks, ${skipped} skipped.`)
  console.log('Live Harness behavior is NOT covered — see dsh-followup-prompt-plan.md §7.2.')
  process.exit(0)
}
console.log(`Offline verification FAILED: ${failures.length} failure(s), ${passed} passed, ${skipped} skipped.`)
for (const failure of failures) console.log(`  - ${failure.name}: ${failure.detail}`)
process.exit(1)
