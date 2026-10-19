// Every field is volatile: 0.2.1 replaces values with live `{ get() }` references, so
// runtime code reads config only through resolveConfig(), never a cached snapshot.

import z from '@deepseek-ai/schemastery'

export const REASONING_EFFORTS = Object.freeze(['', 'off', 'low', 'high', 'max'])

export const LIMITS = Object.freeze({
  maxTokens: [1, 8192],
  timeoutMs: [2000, 30000],
  maxTurns: [0, 1000],
  maxInputChars: [0, 2_000_000],
  maxToolRejectRounds: [0, 3],
  maxSuggestionChars: [1, 4000],
  cacheTtlMs: [1000, 86_400_000],
  maxConcurrent: [1, 16],
  toolRejectionText: 2000,
  prompt: 20000,
})

// cordis.patch.yml restates these verbatim: a patch config replaces the row config, never merges.
export const DEFAULTS = Object.freeze({
  enabled: true,
  provider: '',
  model: '',
  reasoningEffort: 'off',
  maxTokens: 400,
  timeoutMs: 15000,
  maxTurns: 0,
  maxInputChars: 20000,
  maxToolRejectRounds: 1,
  toolRejectionText: '',
  maxSuggestionChars: 400,
  stripMedia: false,
  sampleRate: 1.0,
  prefetchOnTurnEnd: false,
  cacheTtlMs: 600000,
  maxConcurrent: 2,
  excludeSubagents: true,
  prompt: '',
})

/** The complete ordered field list; the bundle patch must restate all of them. */
export const CONFIG_KEYS = Object.freeze(Object.keys(DEFAULTS))

function boundedInteger(limitsKey, fallback) {
  const [min, max] = LIMITS[limitsKey]
  return z.number().step(1).min(min).max(max).default(fallback).volatile()
}

export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).volatile(),
  provider: z.string().default(DEFAULTS.provider).volatile(),
  model: z.string().default(DEFAULTS.model).volatile(),
  reasoningEffort: z.union(REASONING_EFFORTS).default(DEFAULTS.reasoningEffort).volatile(),
  maxTokens: boundedInteger('maxTokens', DEFAULTS.maxTokens),
  timeoutMs: boundedInteger('timeoutMs', DEFAULTS.timeoutMs),
  maxTurns: boundedInteger('maxTurns', DEFAULTS.maxTurns),
  maxInputChars: boundedInteger('maxInputChars', DEFAULTS.maxInputChars),
  maxToolRejectRounds: boundedInteger('maxToolRejectRounds', DEFAULTS.maxToolRejectRounds),
  toolRejectionText: z.string().max(LIMITS.toolRejectionText).default(DEFAULTS.toolRejectionText).volatile(),
  maxSuggestionChars: boundedInteger('maxSuggestionChars', DEFAULTS.maxSuggestionChars),
  stripMedia: z.boolean().default(DEFAULTS.stripMedia).volatile(),
  sampleRate: z.number().min(0).max(1).default(DEFAULTS.sampleRate).volatile(),
  prefetchOnTurnEnd: z.boolean().default(DEFAULTS.prefetchOnTurnEnd).volatile(),
  cacheTtlMs: boundedInteger('cacheTtlMs', DEFAULTS.cacheTtlMs),
  maxConcurrent: boundedInteger('maxConcurrent', DEFAULTS.maxConcurrent),
  excludeSubagents: z.boolean().default(DEFAULTS.excludeSubagents).volatile(),
  prompt: z.string().max(LIMITS.prompt).default(DEFAULTS.prompt).volatile(),
})

function readField(raw, key) {
  const value = raw?.[key]
  if (value === null || typeof value !== 'object') return value
  if (typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

function asInteger(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function asNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function asString(value, fallback, maxLength = Number.POSITIVE_INFINITY) {
  if (typeof value !== 'string') return fallback
  return value.length > maxLength ? value.slice(0, maxLength) : value
}

function asEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

export function resolveConfig(raw) {
  const provider = asString(readField(raw, 'provider'), DEFAULTS.provider).trim()
  const model = asString(readField(raw, 'model'), DEFAULTS.model).trim()
  // The route override is a pair: a half-configured pair would silently send a
  // provider's model id to another provider, so it falls back to the session route.
  const routeOverride = provider.length > 0 && model.length > 0
  const toolRejectionText = asString(
    readField(raw, 'toolRejectionText'),
    DEFAULTS.toolRejectionText,
    LIMITS.toolRejectionText,
  ).trim()
  return Object.freeze({
    enabled: asBoolean(readField(raw, 'enabled'), DEFAULTS.enabled),
    provider: routeOverride ? provider : DEFAULTS.provider,
    model: routeOverride ? model : DEFAULTS.model,
    reasoningEffort: asEnum(readField(raw, 'reasoningEffort'), REASONING_EFFORTS, DEFAULTS.reasoningEffort),
    maxTokens: asInteger(readField(raw, 'maxTokens'), ...LIMITS.maxTokens, DEFAULTS.maxTokens),
    timeoutMs: asInteger(readField(raw, 'timeoutMs'), ...LIMITS.timeoutMs, DEFAULTS.timeoutMs),
    maxTurns: asInteger(readField(raw, 'maxTurns'), ...LIMITS.maxTurns, DEFAULTS.maxTurns),
    maxInputChars: asInteger(readField(raw, 'maxInputChars'), ...LIMITS.maxInputChars, DEFAULTS.maxInputChars),
    maxToolRejectRounds: asInteger(
      readField(raw, 'maxToolRejectRounds'),
      ...LIMITS.maxToolRejectRounds,
      DEFAULTS.maxToolRejectRounds,
    ),
    toolRejectionText,
    maxSuggestionChars: asInteger(
      readField(raw, 'maxSuggestionChars'),
      ...LIMITS.maxSuggestionChars,
      DEFAULTS.maxSuggestionChars,
    ),
    stripMedia: asBoolean(readField(raw, 'stripMedia'), DEFAULTS.stripMedia),
    sampleRate: asNumber(readField(raw, 'sampleRate'), 0, 1, DEFAULTS.sampleRate),
    prefetchOnTurnEnd: asBoolean(readField(raw, 'prefetchOnTurnEnd'), DEFAULTS.prefetchOnTurnEnd),
    cacheTtlMs: asInteger(readField(raw, 'cacheTtlMs'), ...LIMITS.cacheTtlMs, DEFAULTS.cacheTtlMs),
    maxConcurrent: asInteger(readField(raw, 'maxConcurrent'), ...LIMITS.maxConcurrent, DEFAULTS.maxConcurrent),
    excludeSubagents: asBoolean(readField(raw, 'excludeSubagents'), DEFAULTS.excludeSubagents),
    prompt: asString(readField(raw, 'prompt'), DEFAULTS.prompt, LIMITS.prompt).trim(),
  })
}

export const normalizeConfig = resolveConfig

export const DEFAULT_CONFIG = Object.freeze(resolveConfig(DEFAULTS))

export function inspectConfig(raw) {
  const normalized = resolveConfig(raw)
  const issues = []
  for (const key of CONFIG_KEYS) {
    const given = readField(raw, key)
    if (given === undefined) continue
    const resolved = normalized[key]
    if (key === 'provider' || key === 'model') {
      if (typeof given !== 'string') issues.push(`${key}: not a string`)
      continue
    }
    if (key === 'toolRejectionText' || key === 'prompt') {
      if (typeof given !== 'string') issues.push(`${key}: not a string`)
      else if (given.length > LIMITS[key]) issues.push(`${key}: longer than ${LIMITS[key]} characters`)
      continue
    }
    if (typeof resolved === 'number' && typeof given === 'number') {
      if (given !== resolved) issues.push(`${key}: ${given} clamped to ${resolved}`)
      continue
    }
    if (typeof resolved === 'boolean' && typeof given !== 'boolean') issues.push(`${key}: not a boolean`)
    if (typeof resolved === 'string' && key === 'reasoningEffort' && given !== resolved) {
      issues.push(`${key}: ${JSON.stringify(given)} is not one of ${REASONING_EFFORTS.join('/')}`)
    }
  }
  return { normalized, issues }
}
