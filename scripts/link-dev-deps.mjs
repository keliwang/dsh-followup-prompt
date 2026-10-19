#!/usr/bin/env node
// Dev-only: symlink ./node_modules/@deepseek-ai to the DSH shared packages so the Host
// modules resolve outside a profile. `--force` replaces an existing link.

import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const force = process.argv.includes('--force')
const REQUIRED_PACKAGES = ['schemastery', 'dsh-llm']

const candidates = []
if (process.env.DSH_PROFILE_DIR) {
  candidates.push(join(dirname(process.env.DSH_PROFILE_DIR), 'node_modules', '@deepseek-ai'))
}
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
candidates.push(join(dshHome, 'profiles', 'node_modules', '@deepseek-ai'))
candidates.push(
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai',
)

const source = candidates.find((candidate) => {
  if (!existsSync(candidate)) return false
  return REQUIRED_PACKAGES.every((name) => existsSync(join(candidate, name, 'package.json')))
})

if (source === undefined) {
  console.error('[link-dev-deps] Could not find a DSH shared package directory.')
  console.error('[link-dev-deps] Tried:')
  for (const candidate of candidates) console.error(`  - ${candidate}`)
  console.error('[link-dev-deps] Set DSH_PROFILE_DIR or DSH_HOME to the running Harness profile.')
  process.exit(1)
}

const nodeModules = join(root, 'node_modules')
const target = join(nodeModules, '@deepseek-ai')
mkdirSync(nodeModules, { recursive: true })

let exists = false
try {
  lstatSync(target)
  exists = true
} catch {
  exists = false
}

if (exists) {
  const isLink = lstatSync(target).isSymbolicLink()
  const current = isLink ? readlinkSync(target) : '(real directory)'
  if (isLink && resolve(dirname(target), current) === resolve(source)) {
    console.log(`[link-dev-deps] Already linked: node_modules/@deepseek-ai -> ${source}`)
    process.exit(0)
  }
  if (!force) {
    console.error(`[link-dev-deps] node_modules/@deepseek-ai already exists (${current}).`)
    console.error('[link-dev-deps] Re-run with --force to replace it.')
    process.exit(1)
  }
  rmSync(target, { recursive: true, force: true })
}

symlinkSync(source, target, 'dir')
console.log(`[link-dev-deps] linked node_modules/@deepseek-ai -> ${source}`)
console.log('[link-dev-deps] Host imports and `npm test` can now resolve @deepseek-ai/*.')
