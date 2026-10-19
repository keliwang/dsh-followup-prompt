/**
 * In-memory prediction cache and generation scheduler.
 *
 * One entry per session (`Map<sessionId, Entry>`); the entry's `turn` scopes it
 * to the latest completed turn. The cache owns the lifecycle that the Host
 * plugin wires to session events:
 *
 * - in-flight dedupe: concurrent `wait` calls share one generation;
 * - waiter accounting: an RPC abort only removes a waiter, and the last waiter
 *   leaving cancels an unobserved generation (unless it was prefetched);
 * - dismissal: a dismissed turn never serves a suggestion again;
 * - deterministic sampling: `hash(sessionId, turn)` decides `sampled-out`;
 * - a global `maxConcurrent` gate that answers `busy` instead of queueing;
 * - TTL sweep by `cacheTtlMs` (opportunistic, on every entry point, so the
 *   cache installs no timer of its own and needs no extra disposal).
 *
 * Nothing here is persisted: process exit drops every prediction.
 *
 * @module dsh-followup-prompt/host/cache
 */

/** Fallback wait budget when a caller omits one. */
const DEFAULT_WAIT_MS = 12000

/**
 * Coerce to a finite number.
 * @param {unknown} value - candidate.
 * @param {number} fallback - fallback.
 * @returns {number} the finite number.
 */
function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Resolve the latest completed turn from a session's event log tail.
 *
 * Walk backwards over the persisted events; the first turn boundary decides:
 * `turn/end` with `reason.kind === 'completed'` is the prediction target, any
 * other `turn/end` reason or a `turn/start` (an open turn) means there is no
 * completed turn to predict for. Sequence numbers are deliberately not used:
 * they shift when compaction replaces history, while `turn` is stable.
 *
 * @param {object} session - live Session (needs `snapshotEvents()`).
 * @returns {number | null} the latest completed turn, or null.
 */
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

/**
 * Whether a session was created as a subagent child.
 *
 * User-visible forks also carry `parentSession`, so they are intentionally NOT
 * excluded: only the subagent marker and a nonzero delegation depth are.
 * @param {object} session - live Session (needs `header`).
 * @returns {boolean} true for subagent sessions.
 */
export function isSubagentSession(session) {
  const header = session?.header
  if (header === null || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0
}

/**
 * FNV-1a 32-bit hash of `sessionId#turn`, mapped into [0, 1).
 * @param {string} input - hash input.
 * @returns {number} unit-interval value.
 */
function unitHash(input) {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash / 0x1_0000_0000
}

/**
 * Deterministic per-turn sampling decision. The same `(sessionId, turn)` always
 * yields the same outcome, so every window and every retry agrees and the
 * decision can be cached for the turn.
 * @param {string} sessionId - session identity.
 * @param {number} turn - completed turn.
 * @param {number} sampleRate - rate in [0, 1]; 1 predicts every turn, 0 none.
 * @returns {boolean} true when this turn is skipped.
 */
export function isSampledOut(sessionId, turn, sampleRate) {
  const rate = Math.min(1, Math.max(0, finite(sampleRate, 1)))
  if (rate >= 1) return false
  if (rate <= 0) return true
  return unitHash(`${String(sessionId)}#${String(turn)}`) >= rate
}

/**
 * Wait for a settlement promise, bounded by `waitMs` and the caller's signal.
 *
 * Installs exactly one timer and at most one abort listener and removes both
 * on every outcome, so a timed-out long poll leaves no dangling handles.
 *
 * @param {Promise<unknown>} promise - settlement promise (never rejects).
 * @param {number} waitMs - maximum wait in milliseconds.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @returns {Promise<'settled' | 'timeout' | 'aborted'>} why the wait ended.
 */
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

/**
 * One session's prediction entry.
 * @typedef {object} PredictionEntry
 * @property {string} sessionId - owning session.
 * @property {number} turn - completed turn this entry answers.
 * @property {'running' | 'done'} state - generation state.
 * @property {string | null} suggestion - normalized suggestion, or null.
 * @property {string | undefined} reason - why a null suggestion was produced.
 * @property {boolean} dismissed - the client accepted/closed this turn.
 * @property {number} at - creation/settlement timestamp for TTL.
 * @property {AbortController | null} controller - generation cancellation.
 * @property {Promise<PredictionEntry> | null} promise - resolves on settlement.
 * @property {Function | null} resolve - settlement resolver.
 * @property {Set<symbol>} waiters - live long-poll waiters.
 * @property {number} rounds - model requests performed.
 * @property {boolean} toolRejected - the model tried to call a tool.
 * @property {boolean} prefetch - started by `prefetchOnTurnEnd` (never waiter-aborted).
 * @property {string | undefined} abortCause - who cancelled a running generation.
 */

/**
 * Per-session prediction cache and scheduler.
 */
export class PredictionCache {
  /** @type {Map<string, PredictionEntry>} */
  #entries = new Map()
  #generate
  #getConfig
  #now
  #disposed = false

  /**
   * @param {object} options - cache dependencies.
   * @param {(session: object, turn: number, signal: AbortSignal, config: object) => Promise<object>} options.generate
   *   background generation; must resolve to `{ suggestion, reason?, rounds, toolRejected, ... }`.
   * @param {() => object} options.getConfig - live resolved-config reader (volatile fields may change at runtime).
   * @param {() => number} [options.now] - clock, injectable for tests.
   */
  constructor({ generate, getConfig, now = Date.now }) {
    if (typeof generate !== 'function') throw new TypeError('PredictionCache: generate must be a function')
    if (typeof getConfig !== 'function') throw new TypeError('PredictionCache: getConfig must be a function')
    this.#generate = generate
    this.#getConfig = getConfig
    this.#now = now
  }

  /** Number of cached sessions (diagnostics/tests). */
  get size() {
    return this.#entries.size
  }

  /**
   * Read one session's entry without starting work.
   * @param {string} sessionId - session identity.
   * @returns {PredictionEntry | undefined} the entry, if any.
   */
  get(sessionId) {
    return this.#entries.get(String(sessionId))
  }

  /**
   * Return the entry for `(sessionId, turn)`, starting a generation when absent.
   *
   * An entry for a different turn is invalidated first: the cache only ever
   * serves the latest requested completed turn.
   *
   * @param {object} session - live Session.
   * @param {number} turn - completed turn.
   * @param {{ prefetch?: boolean }} [options] - whether this is a prefetch start.
   * @returns {PredictionEntry | null} the entry, or null when disabled/sampled/busy.
   */
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

  /**
   * Long-poll for the suggestion of `turn`.
   *
   * Returns immediately for a terminal entry (including a cached null), shares
   * a running generation with other waiters, and maps expiry/cancellation to
   * `timeout`/`aborted`. Explicit cancellation (the caller's signal) only
   * removes its waiter and aborts an unobserved, non-prefetched generation when
   * nobody is left to observe it; a plain `waitMs` timeout leaves the
   * generation running so a later poll can still observe the cached result.
   *
   * @param {object} input - wait request.
   * @param {object} input.session - live Session.
   * @param {number | null} input.turn - latest completed turn resolved by the caller.
   * @param {number} [input.waitMs] - maximum wait in milliseconds.
   * @param {AbortSignal} [input.signal] - RPC/plugin cancellation.
   * @returns {Promise<{ suggestion: string | null, turn: number | null, reason?: string }>} the protocol value.
   */
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

  /**
   * Start a background generation right after `turn/end(completed)`.
   * @param {object} session - live Session.
   * @param {number} turn - completed turn.
   * @returns {PredictionEntry | null} the started/reused entry, or null when skipped.
   */
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

  /**
   * Mark a turn dismissed (client accepted or explicitly closed the suggestion).
   * Idempotent; a running generation is cancelled because nobody may observe it.
   * @param {string} sessionId - session identity.
   * @param {number} [turn] - expected turn; a mismatch is a no-op.
   * @returns {{ ok: true }} the protocol value.
   */
  dismiss(sessionId, turn) {
    const entry = this.#entries.get(String(sessionId))
    if (entry === undefined) return { ok: true }
    if (typeof turn === 'number' && entry.turn !== turn) return { ok: true }
    entry.dismissed = true
    if (entry.state === 'running') this.#cancel(entry, 'dismiss')
    return { ok: true }
  }

  /**
   * Drop a session's entry (new turn started, new turn ended, disposal).
   * A running generation is cancelled; its waiters wake with `aborted`.
   * @param {string} sessionId - session identity.
   * @returns {PredictionEntry | null} the removed entry, if any.
   */
  invalidate(sessionId) {
    const id = String(sessionId)
    const entry = this.#entries.get(id)
    if (entry === undefined) return null
    this.#entries.delete(id)
    if (entry.state === 'running') this.#cancel(entry, 'invalidate')
    entry.resolve?.(entry)
    return entry
  }

  /**
   * Drop entries older than `cacheTtlMs` (aborting a still-running one).
   * Called opportunistically from entry points; no timer is installed.
   * @param {number} [now] - clock override.
   * @returns {number} count of entries removed.
   */
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

  /**
   * Cancel every generation and forget every entry (plugin/session disposal).
   * The cache stays unusable afterwards; the Host plugin fiber owns its lifetime.
   * @returns {void}
   */
  dispose() {
    this.#disposed = true
    for (const [sessionId, entry] of this.#entries) {
      this.#entries.delete(sessionId)
      if (entry.state === 'running') this.#cancel(entry, 'dispose')
    }
  }

  /**
   * Start one generation entry.
   * @param {object} session - live Session.
   * @param {number} turn - completed turn.
   * @param {boolean} prefetch - whether this start is prefetch-driven.
   * @returns {PredictionEntry | null} the new entry, or null when skipped.
   */
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
    /** @type {PredictionEntry} */
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

  /**
   * Build an already-settled entry (sampling decision, no model call).
   * @param {string} sessionId - session identity.
   * @param {number} turn - completed turn.
   * @param {string | null} suggestion - suggestion (null here).
   * @param {string} reason - terminal reason.
   * @returns {PredictionEntry} the terminal entry.
   */
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

  /**
   * Commit a generation result to its entry and wake waiters.
   * @param {PredictionEntry} entry - entry being settled.
   * @param {object} result - generator result.
   * @returns {void}
   */
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

  /**
   * Cancel a running entry immediately: mark it settled as `aborted`, abort the
   * generation, and wake waiters without waiting for the stream to unwind.
   * @param {PredictionEntry} entry - entry to cancel.
   * @param {string} cause - diagnostic cancellation cause.
   * @returns {void}
   */
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

  /**
   * Cancel an unobserved generation after its last waiter left.
   * Prefetched generations intentionally keep running.
   * @param {PredictionEntry} entry - entry whose waiter set shrank.
   * @returns {void}
   */
  #abortIfUnobserved(entry) {
    if (entry.state !== 'running' || entry.prefetch || entry.dismissed) return
    if (entry.waiters.size > 0) return
    entry.abortCause = 'waiters'
    entry.controller?.abort(new Error('followup-prompt: no waiter'))
  }

  /** Count running generations across every session. */
  #runningCount() {
    let count = 0
    for (const entry of this.#entries.values()) {
      if (entry.state === 'running') count += 1
    }
    return count
  }
}

/**
 * Shape a settled entry into the protocol value.
 * @param {PredictionEntry} entry - settled entry.
 * @returns {{ suggestion: string | null, turn: number, reason?: string }} protocol value.
 */
function resultOf(entry) {
  const value = { suggestion: entry.suggestion, turn: entry.turn }
  if (entry.suggestion === null && typeof entry.reason === 'string') value.reason = entry.reason
  return value
}
