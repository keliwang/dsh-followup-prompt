// In-memory prediction cache and scheduler, one entry per session. Nothing is persisted.

const DEFAULT_WAIT_MS = 12000

function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

// Keyed by `turn`, not `seq`: seq shifts when compaction replaces history.
export function latestCompletedTurn(session) {
  let events
  try {
    events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : undefined
  } catch {
    return null
  }
  if (!Array.isArray(events)) return null
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'turn/start') return null
    if (event.type !== 'turn/end') continue
    const data = event.data
    const turn = data?.turn
    if (!Number.isInteger(turn) || turn < 0) return null
    return data?.reason?.kind === 'completed' ? turn : null
  }
  return null
}

// User-visible forks also carry `parentSession`; only subagents are excluded.
export function isSubagentSession(session) {
  const header = session?.header
  if (header === null || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0
}

function unitHash(input) {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash / 0x1_0000_0000
}

export function isSampledOut(sessionId, turn, sampleRate) {
  const rate = Math.min(1, Math.max(0, finite(sampleRate, 1)))
  if (rate >= 1) return false
  if (rate <= 0) return true
  return unitHash(`${String(sessionId)}#${String(turn)}`) >= rate
}

function waitForSettlement(promise, waitMs, signal) {
  if (signal?.aborted) return Promise.resolve('aborted')
  if (!(waitMs > 0)) return Promise.resolve('timeout')
  return new Promise((resolve) => {
    let timer
    let settled = false
    const done = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve(outcome)
    }
    const onAbort = () => done('aborted')
    timer = setTimeout(() => done('timeout'), waitMs)
    signal?.addEventListener?.('abort', onAbort, { once: true })
    promise.then(() => done('settled'), () => done('settled'))
  })
}

export class PredictionCache {
  #entries = new Map()
  #generate
  #getConfig
  #now
  #disposed = false

  constructor({ generate, getConfig, now = Date.now }) {
    if (typeof generate !== 'function') throw new TypeError('PredictionCache: generate must be a function')
    if (typeof getConfig !== 'function') throw new TypeError('PredictionCache: getConfig must be a function')
    this.#generate = generate
    this.#getConfig = getConfig
    this.#now = now
  }

  get size() {
    return this.#entries.size
  }

  get(sessionId) {
    return this.#entries.get(String(sessionId))
  }

  getOrStart(session, turn, options = {}) {
    if (this.#disposed) return null
    const config = this.#getConfig()
    if (!config.enabled) {
      this.invalidate(session?.id)
      return null
    }
    const sessionId = String(session?.id ?? '')
    if (sessionId.length === 0) return null
    const existing = this.#entries.get(sessionId)
    if (existing !== undefined && existing.turn === turn) return existing
    if (existing !== undefined) this.invalidate(sessionId)
    return this.#start(session, turn, options.prefetch === true)
  }

  async wait({ session, turn, waitMs, signal }) {
    const resolvedTurn = typeof turn === 'number' && Number.isFinite(turn) ? turn : null
    if (this.#disposed) return { suggestion: null, turn: resolvedTurn, reason: 'aborted' }
    const config = this.#getConfig()
    if (!config.enabled) return { suggestion: null, turn: resolvedTurn, reason: 'disabled' }
    this.sweep()
    if (resolvedTurn === null) return { suggestion: null, turn: null, reason: 'no-completed-turn' }
    const entry = this.getOrStart(session, resolvedTurn)
    if (entry === null) return { suggestion: null, turn: resolvedTurn, reason: 'busy' }
    if (entry.dismissed) return { suggestion: null, turn: entry.turn, reason: 'stale' }
    if (entry.state === 'done') return resultOf(entry)
    if (signal?.aborted === true) return { suggestion: null, turn: entry.turn, reason: 'aborted' }

    const waiter = Symbol('followup-prompt-waiter')
    entry.waiters.add(waiter)
    let outcome = 'aborted'
    try {
      outcome = await waitForSettlement(
        entry.promise,
        Math.max(0, finite(waitMs, DEFAULT_WAIT_MS)),
        signal,
      )
      if (entry.dismissed) return { suggestion: null, turn: entry.turn, reason: 'stale' }
      if (entry.state === 'done') return resultOf(entry)
      return { suggestion: null, turn: entry.turn, reason: outcome === 'aborted' ? 'aborted' : 'timeout' }
    } finally {
      entry.waiters.delete(waiter)
      // Only explicit caller cancellation releases the work: a plain waitMs
      // timeout ends this poll, but the prediction may still settle into the
      // cache for a later wait (the client can re-poll; a reopened session can
      // catch up). Aborting here would silently discard slow predictions.
      if (outcome !== 'timeout' || signal?.aborted === true) this.#abortIfUnobserved(entry)
    }
  }

  prefetch(session, turn) {
    if (this.#disposed) return null
    const config = this.#getConfig()
    if (!config.enabled) return null
    if (config.excludeSubagents && isSubagentSession(session)) return null
    this.sweep()
    const sessionId = String(session?.id ?? '')
    if (sessionId.length === 0) return null
    const existing = this.#entries.get(sessionId)
    if (existing !== undefined && existing.turn === turn) return existing
    return this.getOrStart(session, turn, { prefetch: true })
  }

  dismiss(sessionId, turn) {
    const entry = this.#entries.get(String(sessionId))
    if (entry === undefined) return { ok: true }
    if (typeof turn === 'number' && entry.turn !== turn) return { ok: true }
    entry.dismissed = true
    if (entry.state === 'running') this.#cancel(entry, 'dismiss')
    return { ok: true }
  }

  invalidate(sessionId) {
    const id = String(sessionId)
    const entry = this.#entries.get(id)
    if (entry === undefined) return null
    this.#entries.delete(id)
    if (entry.state === 'running') this.#cancel(entry, 'invalidate')
    entry.resolve?.(entry)
    return entry
  }

  sweep(now = this.#now()) {
    const ttl = finite(this.#getConfig().cacheTtlMs, 600000)
    let removed = 0
    for (const [sessionId, entry] of this.#entries) {
      if (now - entry.at < ttl) continue
      this.#entries.delete(sessionId)
      if (entry.state === 'running') this.#cancel(entry, 'ttl')
      removed += 1
    }
    return removed
  }

  dispose() {
    this.#disposed = true
    for (const [sessionId, entry] of this.#entries) {
      this.#entries.delete(sessionId)
      if (entry.state === 'running') this.#cancel(entry, 'dispose')
    }
  }

  #start(session, turn, prefetch) {
    const config = this.#getConfig()
    const sessionId = String(session.id)
    if (config.excludeSubagents && prefetch && isSubagentSession(session)) return null
    if (isSampledOut(sessionId, turn, config.sampleRate)) {
      const entry = this.#terminalEntry(sessionId, turn, null, 'sampled-out')
      this.#entries.set(sessionId, entry)
      return entry
    }
    if (this.#runningCount() >= config.maxConcurrent) return null

    const controller = new AbortController()
    const entry = {
      sessionId,
      turn,
      state: 'running',
      suggestion: null,
      reason: undefined,
      dismissed: false,
      at: this.#now(),
      controller,
      promise: null,
      resolve: null,
      waiters: new Set(),
      rounds: 0,
      toolRejected: false,
      prefetch,
      abortCause: undefined,
    }
    entry.promise = new Promise((resolve) => {
      entry.resolve = resolve
    })
    this.#entries.set(sessionId, entry)
    Promise.resolve()
      .then(() => this.#generate(session, turn, controller.signal, config))
      .catch(() => ({ suggestion: null, reason: 'error' }))
      .then((result) => this.#settle(entry, result ?? {}))
    return entry
  }

  #terminalEntry(sessionId, turn, suggestion, reason) {
    return {
      sessionId,
      turn,
      state: 'done',
      suggestion,
      reason,
      dismissed: false,
      at: this.#now(),
      controller: null,
      promise: Promise.resolve(null),
      resolve: null,
      waiters: new Set(),
      rounds: 0,
      toolRejected: false,
      prefetch: false,
      abortCause: undefined,
    }
  }

  #settle(entry, result) {
    // A cancelled entry (invalidate/dismiss/dispose) is already settled.
    if (entry.state !== 'running') return
    const suggestion = typeof result.suggestion === 'string' && result.suggestion.length > 0
      ? result.suggestion
      : null
    entry.state = 'done'
    entry.at = this.#now()
    entry.suggestion = suggestion
    entry.reason = suggestion === null && typeof result.reason === 'string' ? result.reason : undefined
    entry.rounds = Number.isInteger(result.rounds) ? result.rounds : 0
    entry.toolRejected = result.toolRejected === true
    // Two null outcomes must not be cached: an unobserved generation the last
    // waiter cancelled, and `no-route` (the session had no usable request
    // header yet, so no model call was billed and a later wait may succeed).
    // Every other terminal null is cached for the turn to avoid repeat billing.
    const transient = suggestion === null && (entry.abortCause === 'waiters' || result.reason === 'no-route')
    if (transient && this.#entries.get(entry.sessionId) === entry) this.#entries.delete(entry.sessionId)
    entry.resolve?.(entry)
  }

  #cancel(entry, cause) {
    if (entry.state !== 'running') return
    entry.abortCause = cause
    entry.state = 'done'
    entry.at = this.#now()
    entry.suggestion = null
    entry.reason = 'aborted'
    entry.controller?.abort(new Error(`followup-prompt: ${cause}`))
    entry.resolve?.(entry)
  }

  #abortIfUnobserved(entry) {
    if (entry.state !== 'running' || entry.prefetch || entry.dismissed) return
    if (entry.waiters.size > 0) return
    entry.abortCause = 'waiters'
    entry.controller?.abort(new Error('followup-prompt: no waiter'))
  }

  #runningCount() {
    let count = 0
    for (const entry of this.#entries.values()) {
      if (entry.state === 'running') count += 1
    }
    return count
  }
}

function resultOf(entry) {
  const value = { suggestion: entry.suggestion, turn: entry.turn }
  if (entry.suggestion === null && typeof entry.reason === 'string') value.reason = entry.reason
  return value
}
