// Every field is volatile: 0.2.1 replaces values with live `{ get() }` references, so
// runtime code reads config only through resolveConfig(), never a cached snapshot.

import z from '@deepseek-ai/schemastery'

export const REASONING_EFFORTS = Object.freeze(['', 'off', 'low', 'high', 'max'])

// The single source of truth for every setting. `internal` fields are resolved like the
// rest but stay out of the schema, so neither Settings nor the bundle patch expose them.
export const FIELDS = Object.freeze({
  enabled: { type: 'boolean', default: true },
  provider: { type: 'string', default: '' },
  model: { type: 'string', default: '' },
  reasoningEffort: { type: 'enum', values: REASONING_EFFORTS, default: 'off' },
  maxTokens: { type: 'integer', range: [1, 8192], default: 400 },
  timeoutMs: { type: 'integer', range: [2000, 30000], default: 15000 },
  maxTurns: { type: 'integer', range: [0, 1000], default: 0 },
  prefetchOnTurnEnd: { type: 'boolean', default: false },
  prompt: { type: 'string', maxLength: 20000, default: '' },

  maxToolRejectRounds: { type: 'integer', range: [0, 3], default: 1, internal: true },
  toolRejectionText: { type: 'string', maxLength: 2000, default: '', internal: true },
  maxSuggestionChars: { type: 'integer', range: [1, 4000], default: 400, internal: true },
  stripMedia: { type: 'boolean', default: false, internal: true },
  sampleRate: { type: 'number', range: [0, 1], default: 1, internal: true },
  cacheTtlMs: { type: 'integer', range: [1000, 86_400_000], default: 600000, internal: true },
  maxConcurrent: { type: 'integer', range: [1, 16], default: 2, internal: true },
  excludeSubagents: { type: 'boolean', default: true, internal: true },
})

export const DEFAULTS = Object.freeze(Object.fromEntries(
  Object.entries(FIELDS).map(([key, field]) => [key, field.default]),
))

/** The user-facing fields, in order; cordis.patch.yml restates exactly these. */
export const CONFIG_KEYS = Object.freeze(Object.keys(FIELDS).filter((key) => !FIELDS[key].internal))

function fieldSchema(field) {
  switch (field.type) {
    case 'boolean':
      return z.boolean()
    case 'enum':
      return z.union(field.values)
    case 'string':
      return field.maxLength === undefined ? z.string() : z.string().max(field.maxLength)
    case 'integer':
      return z.number().step(1).min(field.range[0]).max(field.range[1])
    case 'number':
      return z.number().min(field.range[0]).max(field.range[1])
  }
  throw new TypeError(`unknown config field type ${field.type}`)
}

export const Config = z.object(Object.fromEntries(CONFIG_KEYS.map((key) => {
  const field = FIELDS[key]
  return [key, fieldSchema(field).default(field.default).volatile()]
})))

function readField(raw, key) {
  const value = raw?.[key]
  if (typeof value?.get !== 'function') return value
  try {
    return value.get()
  } catch {
    return undefined
  }
}

function resolveField(field, value) {
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean' ? value : field.default
    case 'enum':
      return field.values.includes(value) ? value : field.default
    case 'string':
      return typeof value === 'string' ? value.slice(0, field.maxLength).trim() : field.default
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return field.default
  const [min, max] = field.range
  return Math.min(max, Math.max(min, field.type === 'integer' ? Math.trunc(value) : value))
}

/** Unwraps volatile references, clamps ranges and falls back per field, so a hand-edited config never crashes a session. */
export function resolveConfig(raw) {
  const config = {}
  for (const [key, field] of Object.entries(FIELDS)) config[key] = resolveField(field, readField(raw, key))
  // The route override is a pair: a half-configured pair would silently send a
  // provider's model id to another provider, so it falls back to the session route.
  if (config.provider === '' || config.model === '') {
    config.provider = ''
    config.model = ''
  }
  return Object.freeze(config)
}
