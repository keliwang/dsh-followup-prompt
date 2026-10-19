/**
 * Host HTTP route for the Followup Prompt.
 *
 * DSH ships one authenticated shared API channel at `/api`; a Host feature
 * contributes an exact Fetch route on it with
 * `ctx.connection.fetch.register({ path, methods, requestBody, fetch })`. The
 * route is hosted by the Connection plugin (so no `webServer` injection is
 * needed on the calling plugin), is reachable only by the owner Peer, and
 * inherits the Host/Origin fence, browser-cookie authentication, and buffered
 * JSON body handling of the shared channel. This is the same mechanism the
 * shipped feature plugins and the installed third-party `ds-bot` bundle use.
 *
 * Wire contract (`docs/protocol.md`, `dsh-followup-prompt-plan.md` §3.1):
 * - `POST /api/followup-prompt/rpc`
 * - body `{ endpoint: 'suggestions/wait' | 'suggestions/dismiss', payload }`
 * - HTTP 200 JSON envelope `{ ok: true, value }` or
 *   `{ ok: false, error: { code, message, details } }`
 *
 * Every field is validated at this wire boundary, the handler never throws,
 * and `request.signal` (client disconnect) cancels the long poll.
 *
 * @module dsh-followup-prompt/host/channel
 */

import { resolveConfig } from './config.js'
import { isSubagentSession, latestCompletedTurn } from './cache.js'

/** Exact Fetch route on the shared authenticated `/api` channel. */
export const ROUTE = '/api/followup-prompt/rpc'

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
 * Wrap one envelope as an HTTP 200 JSON response.
 * @param {{ ok: boolean }} envelope - protocol envelope.
 * @returns {Response} the JSON response.
 */
function jsonResponse(envelope) {
  return Response.json(envelope)
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
 * @param {AbortSignal | undefined} input.signal - client-disconnect cancellation.
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
 * Create the `/api/followup-prompt/rpc` exact Fetch route.
 *
 * The returned route object is passed straight to
 * `ctx.connection.fetch.register(route)` inside `ctx.effect`, so the
 * registration is removed with the plugin fiber. The `fetch` handler reads the
 * buffered JSON body, dispatches one endpoint, and always answers HTTP 200
 * with a protocol envelope — a malformed body or endpoint is a `bad-request`,
 * an unknown endpoint is a `bad-endpoint`, and an unexpected exception is
 * `internal`. It never throws.
 *
 * @param {object} options - route dependencies.
 * @param {object} options.ctx - plugin context (`sessions`, `logger`).
 * @param {object | (() => object)} options.config - resolved config snapshot, or the live
 *   resolved-config reader (preferred, so Settings changes apply immediately).
 * @param {object} options.cache - PredictionCache instance.
 * @returns {{ path: string, methods: ['POST'], requestBody: 'buffered',
 *   fetch: (request: Request) => Promise<Response> }} the Fetch route object.
 */
export function createFetchRoute({ ctx, config, cache }) {
  const getConfig = typeof config === 'function' ? config : () => resolveConfig(config)

  /**
   * Dispatch one decoded request body.
   * @param {unknown} body - decoded JSON body.
   * @param {AbortSignal | undefined} signal - client-disconnect cancellation.
   * @returns {Promise<object>} protocol envelope.
   */
  const dispatch = async (body, signal) => {
    if (!isPlainObject(body)) return failure(ERROR_BAD_REQUEST, 'request body must be a JSON object')
    const endpoint = body.endpoint
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      return failure(ERROR_BAD_REQUEST, 'endpoint must be a non-empty string')
    }
    if (endpoint === ENDPOINT_WAIT) {
      const request = parseWaitRequest(body.payload)
      if (request === null) return failure(ERROR_BAD_REQUEST, 'invalid suggestions/wait payload')
      return {
        ok: true,
        value: await waitForSuggestion({ ctx, cache, getConfig, request, signal }),
      }
    }
    if (endpoint === ENDPOINT_DISMISS) {
      const request = parseDismissRequest(body.payload)
      if (request === null) return failure(ERROR_BAD_REQUEST, 'invalid suggestions/dismiss payload')
      return { ok: true, value: dismissSuggestion({ ctx, cache, request }) }
    }
    return failure(ERROR_BAD_ENDPOINT, `unknown endpoint ${JSON.stringify(endpoint)}`)
  }

  return {
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      // The route declares POST only; this guard keeps a direct in-process
      // caller honest without pretending another method is supported.
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } })
      }
      let body
      try {
        body = await request.json()
      } catch {
        return jsonResponse(failure(ERROR_BAD_REQUEST, 'request body must be JSON'))
      }
      try {
        return jsonResponse(await dispatch(body, request.signal))
      } catch (error) {
        // Every expected failure is mapped above; this is a bug or unexpected
        // runtime failure. Never throw (the transport would answer 500), log a
        // short non-sensitive line, and stay silent to the client.
        try {
          ctx.logger?.debug?.('followup-prompt: api route failed: %s', String(error?.message ?? error).slice(0, 500))
        } catch {
          // logging must never break the response
        }
        return jsonResponse(failure(ERROR_INTERNAL, 'internal error'))
      }
    },
  }
}
