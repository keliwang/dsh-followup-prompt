// `/api/followup-prompt/rpc` exact Fetch route. Wire contract: docs/protocol.md.

import { resolveConfig } from './config.js'
import { isSubagentSession, latestCompletedTurn } from './cache.js'

export const ROUTE = '/api/followup-prompt/rpc'

export const ENDPOINT_WAIT = 'suggestions/wait'

export const ENDPOINT_DISMISS = 'suggestions/dismiss'

export const DEFAULT_WAIT_MS = 12000
export const MAX_WAIT_MS = 15000

export const ERROR_BAD_REQUEST = 'followup-prompt/bad-request'
export const ERROR_BAD_ENDPOINT = 'followup-prompt/bad-endpoint'
export const ERROR_INTERNAL = 'followup-prompt/internal'

function failure(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}

function jsonResponse(envelope) {
  return Response.json(envelope)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseTurn(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
  return value
}

function parseSessionId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0) return null
  return value
}

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

export function parseDismissRequest(payload) {
  if (!isPlainObject(payload)) return null
  const sessionId = parseSessionId(payload.sessionId)
  if (sessionId === null) return null
  const turn = parseTurn(payload.turn)
  if (turn === null) return null
  return { sessionId, turn }
}

function lookupSession(ctx, sessionId) {
  try {
    const store = ctx?.sessions
    if (store === undefined || typeof store.get !== 'function') return undefined
    return store.get(sessionId)
  } catch {
    return undefined
  }
}

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

function dismissSuggestion({ ctx, cache, request }) {
  const session = lookupSession(ctx, request.sessionId)
  if (session === undefined) return { ok: true }
  const turn = request.turn ?? latestCompletedTurn(session) ?? undefined
  cache.dismiss(request.sessionId, turn)
  return { ok: true }
}

export function createFetchRoute({ ctx, config, cache }) {
  const getConfig = typeof config === 'function' ? config : () => resolveConfig(config)

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
        // Never throw: the transport would answer 500 instead of a protocol envelope.
        try {
          ctx.logger?.debug?.('followup-prompt: api route failed: %s', String(error?.message ?? error).slice(0, 500))
        } catch {
        }
        return jsonResponse(failure(ERROR_INTERNAL, 'internal error'))
      }
    },
  }
}
