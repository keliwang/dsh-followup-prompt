/**
 * Followup Prompt Host configuration.
 *
 * `Config` is the schemastery schema the Loader validates the plugin row
 * against and the Settings page renders. Every field is `.volatile()`: DSH
 * 0.2.1 replaces volatile fields with live references (`{ get() }`) that the
 * Settings page updates in place, so runtime code must never assume the
 * resolved config is a plain frozen snapshot. `resolveConfig()` is the single
 * place that unwraps those references and clamps every value into its
 * documented range; callers re-resolve a config at use sites instead of
 * caching one across a settings change.
 *
 * The hard-coded defaults follow `dsh-followup-prompt-plan.md` §4.8; the
 * bundle patch restates the same values because a patch `config` replaces the
 * whole row config instead of deep-merging.
 *
 * @module dsh-followup-prompt/host/config
 */

import z from '@deepseek-ai/schemastery'

/** Reasoning levels accepted for a prediction call; `''` follows the provider default. */
export const REASONING_EFFORTS = Object.freeze(['', 'off', 'low', 'high', 'max'])

/** Browser presentation modes; `dock` is the shipped suggestion bar. */
export const UI_MODES = Object.freeze(['dock', 'ghost'])

/** Accepted bounds applied by `resolveConfig()`. */
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

/** Documented defaults (`dsh-followup-prompt-plan.md` §4.8), before validation. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  provider: '',
  model: '',
  reasoningEffort: '',
  maxTokens: 160,
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
  uiMode: 'dock',
  prompt: '',
})

/** The complete ordered field list; the bundle patch must restate all of them. */
export const CONFIG_KEYS = Object.freeze(Object.keys(DEFAULTS))

/**
 * Build one bounded integer schema field. Schema bounds mirror the runtime
 * clamps in `resolveConfig()`, so the Settings form rejects impossible values
 * while hand-edited rows are still clamped instead of crashing a session.
 * @param {keyof typeof LIMITS} limitsKey - `LIMITS` entry holding `[min, max]`.
 * @param {number} fallback - documented default value.
 * @returns {object} the volatile schemastery field.
 */
function boundedInteger(limitsKey, fallback) {
  const [min, max] = LIMITS[limitsKey]
  return z.number().step(1).min(min).max(max).default(fallback).volatile()
}

/**
 * Loader/Settings schema for the Host plugin.
 *
 * `resolveConfig()` below is the runtime mirror: it unwraps the volatile live
 * references, treats `provider`/`model` as a pair, and clamps every value.
 */
export const Config = z.object({
  /** Master switch; when false no model call is ever made. */
  enabled: z.boolean().default(DEFAULTS.enabled).volatile(),
  /** Route override provider; empty means reuse the source session route. */
  provider: z.string().default(DEFAULTS.provider).volatile(),
  /** Route override model; empty means reuse the source session route (`provider` and `model` are a pair). */
  model: z.string().default(DEFAULTS.model).volatile(),
  /** Reasoning effort for the prediction call; empty follows the route default. */
  reasoningEffort: z.union(REASONING_EFFORTS).default(DEFAULTS.reasoningEffort).volatile(),
  /** Output-token ceiling on the prediction reply. */
  maxTokens: boundedInteger('maxTokens', DEFAULTS.maxTokens),
  /** Whole-prediction deadline in milliseconds, shared by every tool-rejection round. */
  timeoutMs: boundedInteger('timeoutMs', DEFAULTS.timeoutMs),
  /** Keep at most this many human turns; 0 keeps the full history (best prompt-prefix reuse). */
  maxTurns: boundedInteger('maxTurns', DEFAULTS.maxTurns),
  /** Input character budget; 0 disables trimming. Trimming only happens in the degraded path. */
  maxInputChars: boundedInteger('maxInputChars', DEFAULTS.maxInputChars),
  /** Tool-call rejection rounds before the prediction is abandoned (0 = abandon on the first tool call). */
  maxToolRejectRounds: boundedInteger('maxToolRejectRounds', DEFAULTS.maxToolRejectRounds),
  /** Unified error tool-result text; empty uses the built-in constant. */
  toolRejectionText: z.string().max(LIMITS.toolRejectionText).default(DEFAULTS.toolRejectionText).volatile(),
  /** Hard cap on the suggestion length in UTF-16 code units. */
  maxSuggestionChars: boundedInteger('maxSuggestionChars', DEFAULTS.maxSuggestionChars),
  /** Strip image/file blocks to text placeholders in the degraded (trimmed) path; never in the full-prefix path. */
  stripMedia: z.boolean().default(DEFAULTS.stripMedia).volatile(),
  /** Deterministic per-(session, turn) sampling rate in [0, 1]; 1.0 predicts every completed turn. */
  sampleRate: z.number().min(0).max(1).default(DEFAULTS.sampleRate).volatile(),
  /** Pre-generate right after `turn/end(completed)` instead of waiting for a client request. */
  prefetchOnTurnEnd: z.boolean().default(DEFAULTS.prefetchOnTurnEnd).volatile(),
  /** In-memory cache TTL in milliseconds. */
  cacheTtlMs: boundedInteger('cacheTtlMs', DEFAULTS.cacheTtlMs),
  /** Maximum simultaneous prediction generations across all sessions. */
  maxConcurrent: boundedInteger('maxConcurrent', DEFAULTS.maxConcurrent),
  /** Skip sessions created as subagent children (`header.origin === 'subagent'`). */
  excludeSubagents: z.boolean().default(DEFAULTS.excludeSubagents).volatile(),
  /** Browser presentation mode: suggestion bar (`dock`) or inline ghost text (`ghost`, P2). */
  uiMode: z.union(UI_MODES).default(DEFAULTS.uiMode).volatile(),
  /** Advanced: replaces the built-in prediction instruction. Empty uses the built-in prompt. */
  prompt: z.string().max(LIMITS.prompt).default(DEFAULTS.prompt).volatile(),
})

/**
 * Read one config field, unwrapping a 0.2.1 volatile reference.
 * @param {unknown} raw - raw plugin config (volatile references or plain values).
 * @param {string} key - field name.
 * @returns {unknown} the live value, or undefined when absent/unreadable.
 */
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

/**
 * Coerce to a bounded integer.
 * @param {unknown} value - candidate value.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @param {number} fallback - value used when the candidate is not a finite number.
 * @returns {number} the clamped integer.
 */
function asInteger(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * Coerce to a bounded float.
 * @param {unknown} value - candidate value.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @param {number} fallback - value used when the candidate is not a finite number.
 * @returns {number} the clamped float.
 */
function asNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * Coerce to a boolean.
 * @param {unknown} value - candidate value.
 * @param {boolean} fallback - value used for any non-boolean.
 * @returns {boolean} the boolean.
 */
function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Coerce to a bounded string.
 * @param {unknown} value - candidate value.
 * @param {string} fallback - value used for any non-string.
 * @param {number} maxLength - maximum accepted length.
 * @returns {string} the string.
 */
function asString(value, fallback, maxLength = Number.POSITIVE_INFINITY) {
  if (typeof value !== 'string') return fallback
  return value.length > maxLength ? value.slice(0, maxLength) : value
}

/**
 * Pick one value from a fixed vocabulary.
 * @param {unknown} value - candidate value.
 * @param {readonly string[]} allowed - accepted values.
 * @param {string} fallback - value used when the candidate is outside the vocabulary.
 * @returns {string} the selected value.
 */
function asEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

/**
 * Resolve raw plugin config into a plain, validated, immutable snapshot.
 *
 * This is the only config reader the runtime uses: it unwraps volatile
 * references, treats `provider`/`model` as a pair (a half-configured pair
 * falls back to the source session route), clamps numeric bounds, and coerces
 * every value so a bad hand-edited row can never crash a session.
 *
 * @param {unknown} raw - raw config from the Loader (volatile references or plain values).
 * @returns {Readonly<typeof DEFAULTS>} the resolved config snapshot.
 */
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
    uiMode: asEnum(readField(raw, 'uiMode'), UI_MODES, DEFAULTS.uiMode),
    prompt: asString(readField(raw, 'prompt'), DEFAULTS.prompt, LIMITS.prompt).trim(),
  })
}

/**
 * Pure alias for {@link resolveConfig}, kept for call sites that describe the
 * operation as normalization rather than resolution.
 * @param {unknown} raw - raw config.
 * @returns {Readonly<typeof DEFAULTS>} the resolved config snapshot.
 */
export const normalizeConfig = resolveConfig

/** The fully resolved default configuration. */
export const DEFAULT_CONFIG = Object.freeze(resolveConfig(DEFAULTS))

/**
 * Report config fields whose value is not one the schema would accept.
 * Intended for the offline verification script, not for runtime gating.
 * @param {unknown} raw - raw config.
 * @returns {{ normalized: Readonly<typeof DEFAULTS>, issues: string[] }} the
 *   resolved snapshot plus one message per field that differed from the raw value.
 */
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
    if (key === 'uiMode' && given !== resolved) {
      issues.push(`${key}: ${JSON.stringify(given)} is not one of ${UI_MODES.join('/')}`)
    }
  }
  return { normalized, issues }
}
