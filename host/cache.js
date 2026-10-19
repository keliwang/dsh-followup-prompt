// In-memory prediction cache and scheduler, one entry per session. Nothing is persisted.
// Callers gate on `enabled` and subagent policy; the cache only schedules and stores.

function unitHash(input) {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash / 0x1_0000_0000
}

export function isSampledOut(sessionId, turn, sampleRate) {
  if (sampleRate >= 1) return false
  if (sampleRate <= 0) return true
  return unitHash(`${sessionId}#${turn}`) >= sampleRate
}

function waitForSettlement(promise, waitMs, signal) {
  if (signal?.aborted) return Promise.resolve('aborted')
  if (!(waitMs > 0)) return Promise.resolve('timeout')
  return new Promise((resolve) => {
    const done = (outcome) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const onAbort = () => done('aborted')
    const timer = setTimeout(() => done('timeout'), waitMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(() => done('settled'))
  })
}

function resultOf(entry) {
  if (entry.dismissed) return { suggestion: null, turn: entry.turn, reason: 'stale' }
  const value = { suggestion: entry.suggestion, turn: entry.turn }
  if (entry.suggestion === null && entry.reason !== undefined) value.reason = entry.reason
  return value
}

export class PredictionCache {
  #entries = new Map()
  #generate
  #getConfig
  #disposed = false

  constructor({ generate, getConfig }) {
    this.#generate = generate
    this.#getConfig = getConfig
  }

  async wait({ session, turn, waitMs, signal }) {
    if (this.#disposed) return { suggestion: null, turn, reason: 'aborted' }
    this.sweep()
    const entry = this.#ensure(session, turn, false)
    if (entry === null) return { suggestion: null, turn, reason: 'busy' }
    if (entry.dismissed || entry.state === 'done') return resultOf(entry)
    if (signal?.aborted) return { suggestion: null, turn, reason: 'aborted' }

    entry.waiters += 1
    let outcome = 'aborted'
    try {
      outcome = await waitForSettlement(entry.promise, waitMs, signal)
      if (entry.dismissed || entry.state === 'done') return resultOf(entry)
      return { suggestion: null, turn, reason: outcome === 'timeout' ? 'timeout' : 'aborted' }
    } finally {
      entry.waiters -= 1
      // Only explicit caller cancellation releases the work: a plain waitMs
      // timeout ends this poll, but the prediction may still settle into the
      // cache for a later wait (the client can re-poll; a reopened session can
      // catch up). Aborting here would silently discard slow predictions.
      if (outcome !== 'timeout' || signal?.aborted) this.#abortIfUnobserved(entry)
    }
  }

  prefetch(session, turn) {
    if (this.#disposed) return
    this.sweep()
    this.#ensure(session, turn, true)
  }

  dismiss(sessionId, turn) {
    const entry = this.#entries.get(String(sessionId))
    if (entry === undefined || (turn !== undefined && entry.turn !== turn)) return
    entry.dismissed = true
    this.#cancel(entry, 'dismiss')
  }

  invalidate(sessionId) {
    const id = String(sessionId)
    const entry = this.#entries.get(id)
    if (entry === undefined) return
    this.#entries.delete(id)
    this.#cancel(entry, 'invalidate')
  }

  sweep() {
    const now = Date.now()
    const ttl = this.#getConfig().cacheTtlMs
    for (const [sessionId, entry] of this.#entries) {
      if (now - entry.at < ttl) continue
      this.#entries.delete(sessionId)
      this.#cancel(entry, 'ttl')
    }
  }

  dispose() {
    this.#disposed = true
    for (const entry of this.#entries.values()) this.#cancel(entry, 'dispose')
    this.#entries.clear()
  }

  #ensure(session, turn, prefetch) {
    const sessionId = String(session.id)
    const existing = this.#entries.get(sessionId)
    if (existing?.turn === turn) return existing
    if (existing !== undefined) this.invalidate(sessionId)
    return this.#start(session, sessionId, turn, prefetch)
  }

  #start(session, sessionId, turn, prefetch) {
    const config = this.#getConfig()
    const base = { sessionId, turn, suggestion: null, reason: undefined, dismissed: false, at: Date.now() }
    if (isSampledOut(sessionId, turn, config.sampleRate)) {
      const entry = { ...base, state: 'done', reason: 'sampled-out' }
      this.#entries.set(sessionId, entry)
      return entry
    }
    if (this.#runningCount() >= config.maxConcurrent) return null

    const controller = new AbortController()
    let resolve
    const promise = new Promise((settle) => {
      resolve = settle
    })
    const entry = {
      ...base,
      state: 'running',
      controller,
      promise,
      resolve,
      waiters: 0,
      prefetch,
      abortCause: undefined,
    }
    this.#entries.set(sessionId, entry)
    Promise.resolve()
      .then(() => this.#generate(session, turn, controller.signal, config))
      .catch(() => ({ suggestion: null, reason: 'error' }))
      .then((result) => this.#settle(entry, result))
    return entry
  }

  #settle(entry, result) {
    // A cancelled entry (invalidate/dismiss/dispose) is already settled.
    if (entry.state !== 'running') return
    entry.state = 'done'
    entry.at = Date.now()
    entry.suggestion = result.suggestion ?? null
    entry.reason = entry.suggestion === null ? result.reason : undefined
    // Two null outcomes must not be cached: an unobserved generation the last
    // waiter cancelled, and `no-route` (the session had no usable request
    // header yet, so no model call was billed and a later wait may succeed).
    // Every other terminal null is cached for the turn to avoid repeat billing.
    const transient = entry.suggestion === null && (entry.abortCause === 'waiters' || result.reason === 'no-route')
    if (transient && this.#entries.get(entry.sessionId) === entry) this.#entries.delete(entry.sessionId)
    entry.resolve()
  }

  #cancel(entry, cause) {
    if (entry.state !== 'running') return
    entry.abortCause = cause
    entry.state = 'done'
    entry.at = Date.now()
    entry.reason = 'aborted'
    entry.controller.abort(new Error(`followup-prompt: ${cause}`))
    entry.resolve()
  }

  #abortIfUnobserved(entry) {
    if (entry.state !== 'running' || entry.prefetch || entry.dismissed || entry.waiters > 0) return
    entry.abortCause = 'waiters'
    entry.controller.abort(new Error('followup-prompt: no waiter'))
  }

  #runningCount() {
    let count = 0
    for (const entry of this.#entries.values()) {
      if (entry.state === 'running') count += 1
    }
    return count
  }
}
