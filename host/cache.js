// In-memory prediction cache and scheduler, one entry per session. Nothing is persisted.
// Callers gate on `enabled` and subagent policy; the cache only schedules and stores.
// Entries live until the session's next turn/start, its disposal, or plugin disposal.

/** Global cap on running generations; extra requests answer `busy` instead of queueing. */
export const MAX_CONCURRENT = 2

function waitForSettlement(promise, waitMs, signal) {
  if (signal?.aborted) return Promise.resolve('aborted')
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
  #disposed = false

  /** `generate(session, turn, signal)` resolves to `{ suggestion, reason? }` and never rejects. */
  constructor({ generate }) {
    this.#generate = generate
  }

  /**
   * Resolves once this turn's generation settles. `waitMs` only guards against a
   * generation that ignores its own deadline; the caller sets it above that deadline.
   */
  async wait({ session, turn, waitMs, signal }) {
    if (this.#disposed) return { suggestion: null, turn, reason: 'aborted' }
    const entry = this.#ensure(session, turn, false)
    if (entry === null) return { suggestion: null, turn, reason: 'busy' }
    if (entry.dismissed || entry.state === 'done') return resultOf(entry)

    entry.waiters += 1
    try {
      const outcome = await waitForSettlement(entry.promise, waitMs, signal)
      if (entry.dismissed || entry.state === 'done') return resultOf(entry)
      return { suggestion: null, turn, reason: outcome }
    } finally {
      entry.waiters -= 1
      this.#releaseIfUnobserved(entry)
    }
  }

  prefetch(session, turn) {
    if (this.#disposed) return
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
    if (this.#runningCount() >= MAX_CONCURRENT) return null

    const controller = new AbortController()
    let resolve
    const promise = new Promise((settle) => {
      resolve = settle
    })
    const entry = {
      sessionId,
      turn,
      state: 'running',
      suggestion: null,
      reason: undefined,
      dismissed: false,
      controller,
      promise,
      resolve,
      waiters: 0,
      prefetch,
    }
    this.#entries.set(sessionId, entry)
    Promise.resolve()
      .then(() => this.#generate(session, turn, controller.signal))
      .catch(() => ({ suggestion: null, reason: 'error' }))
      .then((result) => this.#settle(entry, result))
    return entry
  }

  #settle(entry, result) {
    // A cancelled entry (invalidate/dismiss/dispose) is already settled.
    if (entry.state !== 'running') return
    entry.state = 'done'
    entry.suggestion = result.suggestion ?? null
    entry.reason = entry.suggestion === null ? result.reason : undefined
    // `no-route` is not cached: the session had no usable request header yet, so
    // nothing was billed and a later wait may succeed. Every other terminal result,
    // null included, is cached for the turn to avoid repeat billing.
    if (result.reason === 'no-route') this.#forget(entry)
    entry.resolve()
  }

  #cancel(entry, cause) {
    if (entry.state !== 'running') return
    entry.state = 'done'
    entry.reason = 'aborted'
    entry.controller.abort(new Error(`followup-prompt: ${cause}`))
    entry.resolve()
  }

  /**
   * The last waiter leaving stops a generation nobody else will read (prefetch excepted)
   * and forgets it, so a later wait regenerates instead of reading a cancelled result.
   * Settling it here also frees its concurrency slot even if the provider ignores abort.
   */
  #releaseIfUnobserved(entry) {
    if (entry.state !== 'running' || entry.prefetch || entry.dismissed || entry.waiters > 0) return
    this.#forget(entry)
    this.#cancel(entry, 'no waiter')
  }

  #forget(entry) {
    if (this.#entries.get(entry.sessionId) === entry) this.#entries.delete(entry.sessionId)
  }

  #runningCount() {
    let count = 0
    for (const entry of this.#entries.values()) {
      if (entry.state === 'running') count += 1
    }
    return count
  }
}
