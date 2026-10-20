// `/api/followup-prompt/rpc` exact Fetch route. Wire contract: docs/protocol.md.

import { isSubagentSession, latestCompletedTurn } from './session.js'

export const ROUTE = '/api/followup-prompt/rpc'

/** Headroom over `timeoutMs` before a long poll gives up on a generation ignoring its deadline. */
export const WAIT_GRACE_MS = 2000

export const ERROR_BAD_REQUEST = 'followup-prompt/bad-request'
export const ERROR_BAD_ENDPOINT = 'followup-prompt/bad-endpoint'
export const ERROR_INTERNAL = 'followup-prompt/internal'

function failure(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSessionId(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0
}

function parseWaitRequest(payload) {
  if (!isPlainObject(payload) || !isSessionId(payload.sessionId)) return null
  return { sessionId: payload.sessionId }
}

function parseDismissRequest(payload) {
  if (!isPlainObject(payload) || !isSessionId(payload.sessionId)) return null
  if (payload.turn !== undefined && !isCount(payload.turn)) return null
  return { sessionId: payload.sessionId, turn: payload.turn }
}

function lookupSession(ctx, sessionId) {
  try {
    return ctx.sessions.get(sessionId)
  } catch {
    return undefined
  }
}

async function waitForSuggestion({ ctx, cache, getConfig }, request, signal) {
  const config = getConfig()
  if (!config.enabled) return { suggestion: null, turn: null, reason: 'disabled' }
  const session = lookupSession(ctx, request.sessionId)
  // Subagent traffic must not bill the user or surface in the composer.
  if (session === undefined || isSubagentSession(session)) {
    return { suggestion: null, turn: null, reason: 'unknown-session' }
  }
  const turn = latestCompletedTurn(session)
  if (turn === null) return { suggestion: null, turn: null, reason: 'no-completed-turn' }
  return cache.wait({ session, turn, waitMs: config.timeoutMs + WAIT_GRACE_MS, signal })
}

function dismissSuggestion({ cache }, request) {
  cache.dismiss(request.sessionId, request.turn)
  return { ok: true }
}

const ENDPOINTS = new Map([
  ['suggestions/wait', { parse: parseWaitRequest, run: waitForSuggestion }],
  ['suggestions/dismiss', { parse: parseDismissRequest, run: dismissSuggestion }],
])

export function createFetchRoute(deps) {
  const dispatch = async (body, signal) => {
    if (!isPlainObject(body)) return failure(ERROR_BAD_REQUEST, 'request body must be a JSON object')
    const name = body.endpoint
    if (typeof name !== 'string' || name.length === 0) {
      return failure(ERROR_BAD_REQUEST, 'endpoint must be a non-empty string')
    }
    const endpoint = ENDPOINTS.get(name)
    if (endpoint === undefined) return failure(ERROR_BAD_ENDPOINT, `unknown endpoint ${JSON.stringify(name)}`)
    const request = endpoint.parse(body.payload)
    if (request === null) return failure(ERROR_BAD_REQUEST, `invalid ${name} payload`)
    return { ok: true, value: await endpoint.run(deps, request, signal) }
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
        return Response.json(failure(ERROR_BAD_REQUEST, 'request body must be JSON'))
      }
      try {
        return Response.json(await dispatch(body, request.signal))
      } catch (error) {
        // Never throw: the transport would answer 500 instead of a protocol envelope.
        deps.ctx.logger?.debug?.('followup-prompt: api route failed: %s', String(error?.message ?? error).slice(0, 500))
        return Response.json(failure(ERROR_INTERNAL, 'internal error'))
      }
    },
  }
}
