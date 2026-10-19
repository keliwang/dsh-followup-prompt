/**
 * Connection RPC channel for the Followup Prompt.
 *
 * DSH's authenticated Connection transport gives the browser half one
 * loopback-only, cookie-authenticated unary RPC channel: the Host registers
 * `/followup-prompt` with `ctx.connection.rpc.handle(channel, handler)` (which
 * registers through `owner.webServer.register`, hence the `webServer` inject),
 * and the browser calls `connection.rpc.call('/followup-prompt', endpoint,
 * payload, signal)`. Every field is validated at this wire boundary, and the
 * handler never throws: unexpected failures become a protocol failure envelope.
 *
 * Endpoints (`dsh-followup-prompt-plan.md` §3.1, `docs/protocol.md`):
 * - `suggestions/wait`    long-poll for the latest completed turn's suggestion
 * - `suggestions/dismiss` mark the turn accepted/closed (idempotent)
 *
 * @module dsh-followup-prompt/host/channel
 */

import { resolveConfig } from './config.js'
import { isSubagentSession, latestCompletedTurn } from './cache.js'

/** Registered absolute channel prefix (`/api` is reserved by the gateway). */
export const CHANNEL = '/followup-prompt'

/** Long-poll endpoint: fetch (or wait for) the suggestion of the latest completed turn. */
export const ENDPOINT_WAIT = 'suggestions/wait'

/** Fire-and-forget endpoint: the client accepted or closed the suggestion. */
export const ENDPOINT_DISMISS = 'suggestions/dismiss'

/** Protocol wait default and hard cap in milliseconds. */
export const DEFAULT_WAIT_MS = 12000
export const MAX_WAIT_MS = 15000

/** Protocol failure codes. */
export const ERROR_BAD_REQUEST = 'followup-prompt/bad-request'
export const ERROR_BAD_ENDPOINT = 'followup-prompt/bad-endpoint'
export const ERROR_INTERNAL = 'followup-prompt/internal'

/**
 * Build one protocol failure envelope.
 * @param {string} code - stable failure code.
 * @param {string} message - short human-readable message.
 * @param {object} [details] - additional JSON-safe details.
 * @returns {{ ok: false, error: { code: string, message: string, details: object } }} the envelope.
 */
function failure(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}

/**
 * Whether a wire value is a plain JSON object.
 * @param {unknown} value - decoded payload.
 * @returns {boolean} true for a plain object.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate the optional `turn` field.
 * @param {unknown} value - candidate.
 * @returns {number | undefined | null} the turn, undefined when absent, null when invalid.
 */
function parseTurn(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
  return value
}

/**
 * Validate the required `sessionId` field.
 * @param {unknown} value - candidate.
 * @returns {string | null} the session id, or null when invalid.
 */
function parseSessionId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0) return null
  return value
}

/**
 * Validate a `suggestions/wait` payload.
 * @param {unknown} payload - decoded payload.
 * @returns {{ sessionId: string, turn: number | undefined, waitMs: number } | null} the request.
 */
export function parseWaitRequest(payload) {
  if (!isPlainObject(payload)) return null
  const sessionId = parseSessionId(payload.sessionId)
  if (sessionId === null) return null
  const turn = parseTurn(payload.turn)
  if (turn === null) return null
  let waitMs = DEFAULT_WAIT_MS
  if (payload.waitMs !== undefined) {
    if (typeof payload.waitMs !== 'number' || !Number.isInteger(payload.waitMs) || payload.waitMs < 0) return null
    waitMs = Math.min(payload.waitMs, MAX_WAIT_MS)
  }
  return { sessionId, turn, waitMs }
}

/**
 * Validate a `suggestions/dismiss` payload.
 * @param {unknown} payload - decoded payload.
 * @returns {{ sessionId: string, turn: number | undefined } | null} the request.
 */
export function parseDismissRequest(payload) {
  if (!isPlainObject(payload)) return null
  const sessionId = parseSessionId(payload.sessionId)
  if (sessionId === null) return null
  const turn = parseTurn(payload.turn)
  if (turn === null) return null
  return { sessionId, turn }
}

/**
 * Read the live session for a wire session id.
 * @param {object} ctx - plugin context.
 * @param {string} sessionId - wire session id.
 * @returns {object | undefined} the Session, or undefined when not live.
 */
function lookupSession(ctx, sessionId) {
  try {
    const store = ctx?.sessions
    if (store === undefined || typeof store.get !== 'function') return undefined
    return store.get(sessionId)
  } catch {
    return undefined
  }
}

/**
 * Implement `suggestions/wait`: resolve the latest completed turn, reject stale
 * or unknown requests, and delegate the long poll to the cache.
 * @param {object} input - request context.
 * @param {object} input.ctx - plugin context.
 * @param {object} input.cache - PredictionCache.
 * @param {() => object} input.getConfig - live config reader.
 * @param {{ sessionId: string, turn: number | undefined, waitMs: number }} input.request - validated payload.
 * @param {AbortSignal | undefined} input.signal - transport cancellation.
 * @returns {Promise<{ suggestion: string | null, turn: number | null, reason?: string }>} protocol value.
 */
async function waitForSuggestion({ ctx, cache, getConfig, request, signal }) {
  const config = getConfig()
  if (!config.enabled) return { suggestion: null, turn: null, reason: 'disabled' }
  const session = lookupSession(ctx, request.sessionId)
  if (session === undefined) return { suggestion: null, turn: null, reason: 'unknown-session' }
  if (config.excludeSubagents && isSubagentSession(session)) {
    // Subagent traffic must not bill the user or surface in the composer.
    return { suggestion: null, turn: null, reason: 'unknown-session' }
  }
  const turn = latestCompletedTurn(session)
  if (turn === null) return { suggestion: null, turn: null, reason: 'no-completed-turn' }
  if (request.turn !== undefined && request.turn !== turn) {
    // The client's view is one turn behind (e.g. it mounted mid-turn); tell it
    // the authoritative turn instead of predicting a stale one.
    return { suggestion: null, turn, reason: 'stale' }
  }
  return cache.wait({ session, turn, waitMs: request.waitMs, signal })
}

/**
 * Implement `suggestions/dismiss`: idempotent marker for accepted/closed turns.
 * @param {object} input - request context.
 * @param {object} input.ctx - plugin context.
 * @param {object} input.cache - PredictionCache.
 * @param {{ sessionId: string, turn: number | undefined }} input.request - validated payload.
 * @returns {{ ok: true }} protocol value.
 */
function dismissSuggestion({ ctx, cache, request }) {
  const session = lookupSession(ctx, request.sessionId)
  if (session === undefined) return { ok: true }
  const turn = request.turn ?? latestCompletedTurn(session) ?? undefined
  cache.dismiss(request.sessionId, turn)
  return { ok: true }
}

/**
 * Create the `/followup-prompt` Connection RPC handler.
 *
 * The handler accepts the four transport arguments
 * `(endpoint, payload, signal, peer)`; `peer` is intentionally unused (the
 * Connection adapter already authenticated the request). It never throws: an
 * unexpected exception maps to `followup-prompt/internal`.
 *
 * @param {object} options - handler dependencies.
 * @param {object} options.ctx - plugin context (`sessions`, `logger`).
 * @param {object | (() => object)} options.config - resolved config snapshot, or the live
 *   resolved-config reader (preferred, so Settings changes apply immediately).
 * @param {object} options.cache - PredictionCache instance.
 * @returns {(endpoint: string, payload: unknown, signal?: AbortSignal, peer?: unknown) =>
 *   Promise<{ ok: true, value: object } | { ok: false, error: object }>} the RPC handler.
 */
export function createChannelHandler({ ctx, config, cache }) {
  const getConfig = typeof config === 'function' ? config : () => resolveConfig(config)
  return async function followupPromptHandler(endpoint, payload, signal) {
    try {
      if (endpoint !== ENDPOINT_WAIT && endpoint !== ENDPOINT_DISMISS) {
        return failure(
          ERROR_BAD_ENDPOINT,
          `unknown endpoint ${typeof endpoint === 'string' ? JSON.stringify(endpoint) : typeof endpoint}`,
        )
      }
      if (endpoint === ENDPOINT_WAIT) {
        const request = parseWaitRequest(payload)
        if (request === null) return failure(ERROR_BAD_REQUEST, 'invalid suggestions/wait payload')
        return { ok: true, value: await waitForSuggestion({ ctx, cache, getConfig, request, signal }) }
      }
      const request = parseDismissRequest(payload)
      if (request === null) return failure(ERROR_BAD_REQUEST, 'invalid suggestions/dismiss payload')
      return { ok: true, value: dismissSuggestion({ ctx, cache, request }) }
    } catch (error) {
      // Transport-level callers treat a thrown handler as HTTP 500; map to a
      // protocol failure instead so the client can stay silent by contract.
      try {
        ctx.logger?.debug?.('followup-prompt: rpc handler failed: %s', String(error?.message ?? error).slice(0, 500))
      } catch {
        // logging must never break the response
      }
      return failure(ERROR_INTERNAL, 'internal error')
    }
  }
}
