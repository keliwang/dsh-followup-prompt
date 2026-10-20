// Package-level checks: manifest, locale, icon, bundle patch, and the packed file list.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEFAULTS } from '../host/config.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')
const pkg = JSON.parse(read('package.json'))

/** A `dir/*.ext` pattern matches when the directory holds at least one such file. */
function existsPattern(pattern) {
  if (!pattern.includes('*')) return existsSync(join(root, pattern))
  const dir = join(root, dirname(pattern))
  const extension = pattern.split('.').pop()
  return existsSync(dir) && readdirSync(dir).some((name) => name.endsWith(`.${extension}`))
}

test('manifest: exports, files, and dsh entries resolve on disk', () => {
  assert.equal(pkg.name, 'dsh-followup-prompt')
  assert.equal(pkg.type, 'module')
  for (const [key, target] of Object.entries(pkg.exports)) {
    assert.ok(existsPattern(target), `exports ${key} -> ${target} is missing`)
  }
  for (const pattern of pkg.files) assert.ok(existsPattern(pattern), `files ${pattern} is missing`)
  assert.ok(existsSync(join(root, pkg.dsh.bundle.patch)), 'dsh.bundle.patch is missing')
  assert.equal(pkg.dsh.client.platform, 'web')
})

test('locale: en and zh carry meta.title and meta.description', () => {
  for (const locale of ['en', 'zh']) {
    const { meta } = JSON.parse(read(`locale/${locale}.json`))
    assert.ok(meta?.title, `locale/${locale}.json meta.title`)
    assert.ok(meta?.description, `locale/${locale}.json meta.description`)
  }
})

test('icon: a small SVG', () => {
  const icon = read('icon.svg')
  assert.ok(icon.trimStart().startsWith('<svg'))
  assert.ok(Buffer.byteLength(icon) <= 256 * 1024)
})

function parseScalar(text) {
  const value = text.trim()
  if (/^(['"]).*\1$/.test(value)) return value.slice(1, -1)
  if (value === 'true' || value === 'false') return value === 'true'
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  return value
}

// A patch config replaces the whole row config, so it must restate every
// user-facing field with exactly the schema default.
test('cordis.patch.yml: one followup-prompt row restating every user field default', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /^\s*-\s*id:\s*followup-prompt\s*$/m)
  assert.match(patch, /^\s*name:\s*dsh-followup-prompt\s*$/m)
  const header = patch.match(/^([ ]*)config:\s*$/m)
  assert.ok(header !== null, 'patch row has no config block')
  const fields = []
  for (const line of patch.slice(header.index + header[0].length).split('\n')) {
    const child = line.match(/^([ ]*)([A-Za-z]\w*):(.*)$/)
    if (child === null) continue
    if (child[1].length <= header[1].length) break
    fields.push([child[2], parseScalar(child[3])])
  }
  assert.deepEqual(fields.map(([key]) => key), Object.keys(DEFAULTS))
  for (const [key, value] of fields) assert.equal(value, DEFAULTS[key], `patch default for ${key}`)
})

const pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8' })

test('pack: the tarball ships every declared file and nothing from verify/', { skip: pnpm.status !== 0 && 'pnpm not found' }, () => {
  const result = spawnSync('pnpm', ['pack', '--dry-run'], { cwd: root, encoding: 'utf8', timeout: 180_000 })
  assert.equal(result.status, 0, result.stderr)
  const output = result.stdout + result.stderr
  for (const pattern of pkg.files) {
    const prefix = pattern.split('*')[0]
    assert.ok(output.includes(prefix), `tarball is missing ${pattern}`)
  }
  assert.ok(!output.includes('node_modules/'), 'tarball contains node_modules/')
  assert.ok(!output.includes('verify/'), 'tarball contains verify/')
})
