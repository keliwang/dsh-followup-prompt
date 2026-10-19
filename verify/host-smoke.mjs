#!/usr/bin/env node
// Stub-driven smoke test: drives the real Host modules with a fake ctx, session store,
// Fetch-route registry and `ctx.llm.stream`.

import { apply, Config, name, inject } from '../host/index.js'
import {
  CONFIG_KEYS,
  DEFAULTS,
  inspectConfig,
  LIMITS,
  resolveConfig,
} from '../host/config.js'
import {
  isSampledOut,
  isSubagentSession,
  latestCompletedTurn,
} from '../host/cache.js'
import {
  buildRequestMessages,
  estimateMessageChars,
  FOLLOWUP_INSTRUCTION,
  PREDICTION_REASONS,
  TOOL_REJECTION_TEXT,
  normalizeSuggestion,
  trimRequestMessages,
} from '../host/prediction.js'
import {
  DEFAULT_WAIT_MS,
  ERROR_BAD_ENDPOINT,
  ERROR_BAD_REQUEST,
  MAX_WAIT_MS,
  ROUTE,
} from '../host/channel.js'

const DEFAULT_SUGGESTION = 'Add a unit test for the guard'

// ── Tiny assertion harness ──────────────────────────────────────────────────

const results = []

async function check(label, body) {
  try {
    await body()
    results.push({ label, ok: true })
  } catch (error) {
    results.push({ label, ok: false, error: error instanceof Error ? error : new Error(String(error)) })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`)
  }
}

function assertDeepEqual(actual, expected, message) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(`${message}: expected ${right}, observed ${left}`)
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── Stub Harness ────────────────────────────────────────────────────────────

function createSession(id, options = {}) {
  const events = []
  const messages = options.messages ?? [
    { id: 'm-0', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'You are a coding agent.' }] },
    { id: 'm-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Fix the bug in a.js' }] },
    {
      id: 'm-2',
      role: 'assistant',
      source: { kind: 'model', provider: 'fake-provider', model: 'fake-model' },
      content: [{ type: 'text', text: 'Done. I changed the guard.' }],
    },
  ]
  const session = {
    id,
    header: { version: 4, id, createdAt: 0, isSeeded: false, ...options.header },
    deriveMessages: () => messages,
    requestHeader: () => ({
      config: options.requestConfig ?? { provider: 'fake-provider', model: 'fake-model', temperature: 0.3 },
      ...(options.adapterDefaults === undefined ? {} : { adapterDefaults: options.adapterDefaults }),
      ...(options.tools === undefined
        ? { tools: [{ name: 'fs_read', description: 'Read a file', parameters: { type: 'object' } }] }
        : { tools: options.tools }),
    }),
    toolHistory: () => ({ tools: [], updates: [] }),
    snapshotEvents: () => [...events],
  }
  return { session, events }
}

function appendEvent(harness, session, events, event) {
  const stored = { ...event, seq: events.length, time: Date.now() }
  events.push(stored)
  harness.emit(session, stored)
}

function seedCompletedTurn(harness, session, events, turn) {
  appendEvent(harness, session, events, { type: 'turn/start', data: { turn } })
  appendEvent(harness, session, events, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
}

function contextMessages(options = {}) {
  const filler = 'x'.repeat(2000)
  return [
    { id: 'ctx-s', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'System prompt' }] },
    { id: 'ctx-u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `First human turn ${filler}` }] },
    {
      id: 'ctx-a1',
      role: 'assistant',
      source: { kind: 'model', provider: 'p', model: 'm' },
      content: [{ type: 'tool-call', id: 'ctx-c1', name: 'fs_read', arguments: '{"path":"a.js"}' }],
    },
    { id: 'ctx-t1', role: 'tool', source: { kind: 'tool', callId: 'ctx-c1' }, toolCallId: 'ctx-c1', content: [{ type: 'text', text: 'tool result' }] },
    { id: 'ctx-a2', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'First answer' }] },
    {
      id: 'ctx-u2',
      role: 'user',
      source: { kind: 'user' },
      content: options.image === true
        ? [{ type: 'image', attachment: { name: 'shot.png' } }]
        : [{ type: 'text', text: 'Second human turn' }],
    },
    { id: 'ctx-a3', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'Final answer.' }] },
  ]
}

async function* textChunks(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function* toolCallChunks(calls) {
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments }
    yield { type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments } }
  }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

function createHarness(options = {}) {
  const listeners = new Map()
  const effects = []
  const routes = new Map()
  const sessions = new Map()
  const calls = []
  const config = options.config ?? { ...DEFAULTS }
  const streams = options.streams ?? (() => textChunks(DEFAULT_SUGGESTION))

  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
    },
    effect(factory, label) {
      const cleanup = factory()
      effects.push({ label, cleanup })
      return async () => {
        if (typeof cleanup === 'function') await cleanup()
      }
    },
    connection: {
      fetch: {
        register(route) {
          if (route === null || typeof route !== 'object') throw new Error('fetch.register: invalid route')
          if (routes.has(route.path)) throw new Error(`duplicate fetch route registration: ${route.path}`)
          routes.set(route.path, route)
          return async () => {
            routes.delete(route.path)
          }
        },
      },
    },
    llm: {
      stream(request) {
        calls.push(request)
        return streams(request, calls.length - 1)
      },
    },
    sessions: {
      get(sessionId) {
        return sessions.get(sessionId)
      },
    },
  }

  apply(ctx, config)

  const harness = {
    ctx,
    config,
    sessions,
    calls,
    routes,
    effects,
    addSession(session) {
      sessions.set(session.id, session)
      return session
    },
    emit(session, event) {
      for (const listener of listeners.get('session/event') ?? []) listener(session, event)
    },
    emitDisposed(session) {
      for (const listener of listeners.get('session/disposed') ?? []) listener(session)
    },
    get route() {
      const route = routes.get(ROUTE)
      if (route === undefined) throw new Error(`fetch route ${ROUTE} is not registered`)
      return route
    },
    async disposeAll() {
      for (const effect of [...effects].reverse()) {
        if (typeof effect.cleanup === 'function') await effect.cleanup()
      }
      effects.length = 0
    },
  }
  return harness
}

function valueOf(result) {
  assert(result !== null && typeof result === 'object', 'route returned no envelope')
  assert(result.ok === true, `expected ok:true envelope, observed ${JSON.stringify(result)}`)
  return result.value
}

function assertFailure(result, code, label) {
  assert(result !== null && typeof result === 'object', `${label}: no envelope`)
  assertEqual(result.ok, false, `${label}: ok flag`)
  assertEqual(result.error?.code, code, `${label}: error code`)
  assert(typeof result.error?.message === 'string' && result.error.message.length > 0, `${label}: error message`)
  assert(result.error?.details !== null && typeof result.error?.details === 'object', `${label}: error details`)
}

async function post(harness, body, options = {}) {
  const init = {
    method: options.method ?? 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }
  if (options.signal !== undefined) init.signal = options.signal
  const request = new Request(`http://127.0.0.1:57434${ROUTE}`, init)
  const response = await harness.route.fetch(request)
  assertEqual(response.status, 200, 'route answers HTTP 200 for protocol results')
  assert(
    (response.headers.get('content-type') ?? '').includes('application/json'),
    'route answers JSON',
  )
  return response.json()
}

function callEndpoint(harness, endpoint, payload, signal) {
  const body = { endpoint }
  if (payload !== undefined) body.payload = payload
  return post(harness, body, signal === undefined ? {} : { signal })
}

function wait(harness, payload, signal) {
  return callEndpoint(harness, 'suggestions/wait', payload, signal)
}

function dismiss(harness, payload) {
  return callEndpoint(harness, 'suggestions/dismiss', payload)
}

// ── Checks ──────────────────────────────────────────────────────────────────

async function main() {
  // ── Entry contract ───────────────────────────────────────────────────────
  await check('entry contract: name / inject / Config / apply', () => {
    assertEqual(name, 'followup-prompt', 'plugin name')
    assertDeepEqual(inject, ['connection', 'llm', 'sessions'], 'inject list')
    assert(!inject.includes('webServer'), 'the /api Fetch route needs no webServer injection')
    assertEqual(typeof apply, 'function', 'apply export')
    assertEqual(typeof Config, 'function', 'Config export (schemastery schema)')
    const standard = Config['~standard']
    assert(standard !== undefined && typeof standard.validate === 'function', 'Config is a standard-schema')
    const validated = standard.validate({ ...DEFAULTS })
    assert(validated.issues === undefined, `Config rejected the documented defaults: ${JSON.stringify(validated.issues)}`)
  })

  await check('config: schema keys and resolved defaults', () => {
    const resolved = resolveConfig({})
    assertDeepEqual(CONFIG_KEYS, Object.keys(DEFAULTS), 'config key order')
    assertEqual(CONFIG_KEYS.length, 18, 'config field count')
    assertDeepEqual(Object.keys(resolved), CONFIG_KEYS, 'resolved key set')
    assertDeepEqual(JSON.parse(JSON.stringify(resolved)), { ...DEFAULTS }, 'resolved defaults')
  })

  await check('config: resolves volatile references and clamps bounds', () => {
    const volatile = (value) => ({ get: () => value })
    const live = resolveConfig({
      enabled: volatile(false),
      provider: volatile('  cheap-provider  '),
      model: volatile('cheap-model'),
      reasoningEffort: volatile('turbo'),
      maxTokens: volatile(0),
      timeoutMs: volatile(99999),
      maxTurns: volatile(-4),
      maxInputChars: volatile(-10),
      maxToolRejectRounds: volatile(9),
      maxSuggestionChars: volatile(1.9),
      sampleRate: volatile(5),
      maxConcurrent: volatile(0),
      cacheTtlMs: volatile(1),
      prompt: volatile('  Predict it.  '),
    })
    assertEqual(live.enabled, false, 'volatile enabled')
    assertEqual(live.provider, 'cheap-provider', 'volatile provider trimmed')
    assertEqual(live.model, 'cheap-model', 'volatile model')
    assertEqual(live.reasoningEffort, DEFAULTS.reasoningEffort, 'invalid reasoning effort falls back')
    assertEqual(live.maxTokens, LIMITS.maxTokens[0], 'maxTokens clamped up')
    assertEqual(live.timeoutMs, LIMITS.timeoutMs[1], 'timeoutMs capped at 30s')
    assertEqual(live.maxTurns, 0, 'maxTurns clamped')
    assertEqual(live.maxInputChars, 0, 'maxInputChars clamped')
    assertEqual(live.maxToolRejectRounds, LIMITS.maxToolRejectRounds[1], 'maxToolRejectRounds capped')
    assertEqual(live.maxSuggestionChars, 1, 'maxSuggestionChars truncated')
    assertEqual(live.sampleRate, 1, 'sampleRate capped')
    assertEqual(live.maxConcurrent, LIMITS.maxConcurrent[0], 'maxConcurrent clamped up')
    assertEqual(live.cacheTtlMs, LIMITS.cacheTtlMs[0], 'cacheTtlMs clamped up')
    assertEqual(live.prompt, 'Predict it.', 'prompt trimmed')

    const halfRoute = resolveConfig({ provider: 'only-provider' })
    assertEqual(halfRoute.provider, '', 'half-configured route: provider cleared')
    assertEqual(halfRoute.model, '', 'half-configured route: model cleared')
    assertEqual(resolveConfig({ timeoutMs: 1000 }).timeoutMs, 2000, 'timeout floor is 2s')
    assertEqual(resolveConfig({ reasoningEffort: 'low' }).reasoningEffort, 'low', 'valid reasoning effort kept')
  })

  await check('prediction helpers: suggestion normalization and safety filters', () => {
    const config = resolveConfig({})
    assertEqual(normalizeSuggestion('```\nRun the tests\n```', config), 'Run the tests', 'markdown fence stripped')
    assertEqual(normalizeSuggestion('"thanks"', config), 'thanks', 'double quotes stripped')
    assertEqual(normalizeSuggestion('`continue`', config), 'continue', 'backticks stripped')
    assertEqual(normalizeSuggestion('NO_PREDICTION', config), null, 'sentinel dropped')
    assertEqual(normalizeSuggestion('   ', config), null, 'empty dropped')
    assertEqual(normalizeSuggestion('bad\u0007bell', config), null, 'control character dropped')
    assertEqual(normalizeSuggestion('key sk-abcdefghijklmnopqrst', config), null, 'secret-shaped token dropped')
    const truncated = normalizeSuggestion('x'.repeat(500), config)
    assertEqual(truncated.length, config.maxSuggestionChars, 'suggestion truncated to maxSuggestionChars')
    assert(FOLLOWUP_INSTRUCTION.includes('NO_PREDICTION'), 'instruction sentinel present')
    assert(TOOL_REJECTION_TEXT.includes('Do not call any tool'), 'rejection text present')
  })

  await check('context: full history is kept when within budget (prefix reuse)', async () => {
    const { session } = createSession('context-full', { messages: contextMessages() })
    const messages = buildRequestMessages(session, resolveConfig({ maxInputChars: 20000 }))
    assert(messages !== null, 'full history fits the default budget')
    assertEqual(messages.length, 8, 'seven history messages plus one tail instruction')
    assertEqual(messages[0].role, 'system', 'system head preserved')
    assertEqual(messages[1].id, 'ctx-u1', 'oldest human turn preserved')
    assertEqual(messages.at(-1).role, 'user', 'tail instruction appended last')
    assertEqual(messages.at(-1).content[0].text, FOLLOWUP_INSTRUCTION, 'tail instruction text')
    const custom = buildRequestMessages(session, resolveConfig({ maxInputChars: 20000, prompt: '  Predict the next message.  ' }))
    assert(custom !== null, 'custom prompt builds a request')
    assertEqual(custom.at(-1).content[0].text, 'Predict the next message.', 'configured prompt overrides the built-in one')
  })

  await check('context: over-budget trimming cuts only at a human user boundary', async () => {
    const { session } = createSession('context-trim', { messages: contextMessages() })
    const config = resolveConfig({ maxInputChars: 900 })
    const messages = buildRequestMessages(session, config)
    assert(messages !== null, 'a fitting suffix exists')
    const history = messages.slice(0, -1)
    assertEqual(history[0].role, 'system', 'head preserved after trim')
    assertEqual(history[1].id, 'ctx-u2', 'suffix starts at the latest human user boundary')
    assertEqual(history[1].role, 'user', 'trim never starts on a tool result')
    const usedChars = history.reduce((sum, message) => sum + estimateMessageChars(message), 0)
      + FOLLOWUP_INSTRUCTION.length
    assert(usedChars <= 900, `trimmed request stays within budget (used ${usedChars})`)

    const tooSmall = buildRequestMessages(session, resolveConfig({ maxInputChars: 50 }))
    assertEqual(tooSmall, null, 'no safe cut point fits the budget: predict nothing')
  })

  await check('context: turn cap and stripMedia apply in the degraded path', async () => {
    const { session } = createSession('context-turns', { messages: contextMessages() })
    const capped = buildRequestMessages(session, resolveConfig({ maxTurns: 1, maxInputChars: 0 }))
    assert(capped !== null, 'maxTurns alone triggers the degraded path')
    assertEqual(capped.length, 4, 'system head + last human turn + assistant + instruction')
    assertEqual(capped[1].id, 'ctx-u2', 'only the most recent human turn kept')

    const { session: mediaSession } = createSession('context-media', {
      messages: contextMessages({ image: true }),
    })
    const stripped = buildRequestMessages(mediaSession, resolveConfig({ maxInputChars: 1100, stripMedia: true }))
    const preserved = buildRequestMessages(mediaSession, resolveConfig({ maxInputChars: 1100, stripMedia: false }))
    assert(stripped !== null && preserved !== null, 'media history trims')
    assertEqual(stripped[1].content[0].type, 'text', 'degraded + stripMedia projects media to text')
    assert(stripped[1].content[0].text.includes('image omitted'), 'media placeholder text')
    assertEqual(preserved[1].content[0].type, 'image', 'default path keeps media blocks intact')
  })

  await check('context: a history without a human boundary is never split', async () => {
    const { session } = createSession('context-no-human', {
      messages: [
        { id: 'nh-s', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'sys' }] },
        { id: 'nh-a', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'answer' }] },
      ],
    })
    assertEqual(buildRequestMessages(session, resolveConfig({ maxInputChars: 20 })), null, 'over budget without a safe cut: null')
    const full = buildRequestMessages(session, resolveConfig({ maxInputChars: 0 }))
    assert(full !== null && full.length === 3, 'within budget: full history kept')
    const trimmed = trimRequestMessages(contextMessages(), resolveConfig({ maxInputChars: 600 }), 221)
    assert(trimmed !== null && trimmed.trimmed === true, 'trim status reported')
    assertEqual(trimmed.messages[0].role, 'system', 'head preserved by trimRequestMessages')
    assertEqual(trimmed.messages[1].role, 'user', 'suffix begins at a human message')
  })

  await check('config: inspectConfig reports clamped values', () => {
    const inspected = inspectConfig({ timeoutMs: 1, sampleRate: 2, enabled: 'yes' })
    assert(inspected.issues.length >= 3, `expected clamping issues, observed ${JSON.stringify(inspected.issues)}`)
    assertEqual(inspected.normalized.timeoutMs, 2000, 'clamped timeout reported')
    assert(inspected.issues.some((issue) => issue.startsWith('sampleRate')), 'sampleRate issue reported')
    assert(inspected.issues.some((issue) => issue.startsWith('enabled')), 'enabled type issue reported')
  })

  await check('turn resolution: latest completed turn walk', async () => {
    const harness = createHarness({ config: { ...DEFAULTS, enabled: false } })
    try {
      const { session, events } = createSession('turn-walk')
      const push = (event) => appendEvent(harness, session, events, event)
      assertEqual(latestCompletedTurn(session), null, 'empty log')
      push({ type: 'turn/start', data: { turn: 0 } })
      assertEqual(latestCompletedTurn(session), null, 'open turn')
      push({ type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } })
      assertEqual(latestCompletedTurn(session), 0, 'completed turn 0')
      push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
      assertEqual(latestCompletedTurn(session), null, 'non-completed latest turn')
    } finally {
      await harness.disposeAll()
    }
    assertEqual(isSampledOut('same-session', 3, 1), false, 'sampleRate 1 never samples out')
    assertEqual(isSampledOut('same-session', 3, 0), true, 'sampleRate 0 always samples out')
    assertEqual(
      isSampledOut('same-session', 3, 0.5),
      isSampledOut('same-session', 3, 0.5),
      'sampling is deterministic per (session, turn)',
    )
    assertEqual(
      isSubagentSession({ header: { origin: 'subagent' } }),
      true,
      'subagent origin detected',
    )
    assertEqual(
      isSubagentSession({ header: { parentSession: 'parent' } }),
      false,
      'a user fork is not a subagent',
    )
  })

  // ── Channel registration and the lazy wait path ─────────────────────────
  await check('route: exact POST /api/followup-prompt/rpc registered once', async () => {
    const harness = createHarness()
    try {
      assertEqual(harness.routes.size, 1, 'one Fetch route registered')
      assert(harness.routes.has(ROUTE), `route ${ROUTE} registered`)
      assertEqual(harness.route.path, ROUTE, 'route path')
      // Mirrors Connection's `assertFetchRoute`/`endpointFromPath('/api', …)` shape check.
      assert(/^\/api\/[A-Za-z0-9_$.-]+(\/[A-Za-z0-9_$.-]+)*$/.test(ROUTE), 'route path is a valid /api endpoint path')
      assertDeepEqual(harness.route.methods, ['POST'], 'route methods')
      assertEqual(harness.route.requestBody, 'buffered', 'route body mode')
      assertEqual(typeof harness.route.fetch, 'function', 'route fetch handler')
      assertEqual(DEFAULT_WAIT_MS, 12000, 'default wait budget')
      assertEqual(MAX_WAIT_MS, 15000, 'maximum wait budget')
      const methodResponse = await harness.route.fetch(new Request(`http://127.0.0.1:57434${ROUTE}`, { method: 'GET' }))
      assertEqual(methodResponse.status, 405, 'non-POST method is rejected outside the envelope')
    } finally {
      await harness.disposeAll()
      assertEqual(harness.routes.size, 0, 'route unregistered on disposal')
    }
  })

  await check('wait: turn/end(completed) + lazy wait makes exactly one call', async () => {
    const harness = createHarness({ config: { ...DEFAULTS, timeoutMs: 2000 } })
    try {
      const { session, events } = createSession('session-lazy')
      harness.addSession(session)
      seedCompletedTurn(harness, session, events, 1)
      await flush()
      assertEqual(harness.calls.length, 0, 'prefetch off: no model call on turn/end')
      const eventCountBefore = events.length

      const first = valueOf(await wait(harness, { sessionId: 'session-lazy', turn: 1, waitMs: 1000 }))
      assertEqual(first.suggestion, DEFAULT_SUGGESTION, 'first wait returns the suggestion')
      assertEqual(first.turn, 1, 'first wait reports the turn')
      assertEqual(first.reason, undefined, 'a suggestion carries no reason')
      assertEqual(harness.calls.length, 1, 'exactly one model call')
      assertEqual(events.length, eventCountBefore, 'prediction appends no session events')

      const request = harness.calls[0]
      assertEqual(request.provider, 'fake-provider', 'inherited provider')
      assertEqual(request.model, 'fake-model', 'inherited model')
      assertEqual(request.temperature, 0.3, 'inherited sampling control')
      assertEqual(request.maxTokens, DEFAULTS.maxTokens, 'prediction output cap applied')
      assertEqual(request.sessionId, 'session-lazy', 'session attribution')
      assert(Array.isArray(request.tools) && request.tools[0]?.name === 'fs_read', 'tool declarations inherited')
      assert(request.toolHistory !== undefined, 'tool history inherited')
      assert(request.signal instanceof AbortSignal, 'cancellation signal passed')
      const last = request.messages.at(-1)
      assertEqual(last.role, 'user', 'tail instruction is a user message')
      assertEqual(last.content[0].text, FOLLOWUP_INSTRUCTION, 'tail instruction is the built-in prompt')
      assertEqual(request.messages[0].role, 'system', 'inherited system head preserved')
      assertEqual(request.messages.length, 4, 'full history + one instruction (no trimming)')

      const second = valueOf(await wait(harness, { sessionId: 'session-lazy', turn: 1, waitMs: 1000 }))
      assertEqual(second.suggestion, DEFAULT_SUGGESTION, 'cached wait returns the suggestion')
      assertEqual(second.turn, 1, 'cached wait reports the turn')
      assertEqual(harness.calls.length, 1, 'cached wait makes no second model call')
    } finally {
      await harness.disposeAll()
    }
  })

  await check('request: adapter-materialized defaults are deleted then policy-applied', async () => {
    const harness = createHarness({
      config: { ...DEFAULTS, reasoningEffort: 'low', maxTokens: 96 },
    })
    try {
      const { session, events } = createSession('session-adapter', {
        requestConfig: {
          provider: 'fake-provider',
          model: 'fake-model',
          reasoningEffort: 'high',
          maxTokens: 4096,
          temperature: 0.1,
        },
        adapterDefaults: { reasoningEffort: true, maxTokens: true },
      })
      harness.addSession(session)
      seedCompletedTurn(harness, session, events, 1)
      const value = valueOf(await wait(harness, { sessionId: 'session-adapter', turn: 1, waitMs: 1000 }))
      assertEqual(value.suggestion, DEFAULT_SUGGESTION, 'suggestion produced')
      const request = harness.calls[0]
      assertEqual(request.reasoningEffort, 'low', 'configured reasoning effort overrides the deleted adapter default')
      assertEqual(request.maxTokens, 96, 'configured output cap overrides the deleted adapter default')
      assertEqual(request.temperature, 0.1, 'unflagged controls survive')
    } finally {
      await harness.disposeAll()
    }
  })

  // ── Cache, dismiss, TTL, sampling, disabled ──────────────────────────────
  await check('dismiss: the turn is no longer served (stale), idempotently', async () => {
    const harness = createHarness()
    try {
      const { session, events } = createSession('session-dismiss')
      harness.addSession(session)
      seedCompletedTurn(harness, session, events, 2)
      valueOf(await wait(harness, { sessionId: 'session-dismiss', turn: 2, waitMs: 1000 }))
      assertEqual(harness.calls.length, 1, 'initial generation')

      const dismissed = valueOf(await dismiss(harness, { sessionId: 'session-dismiss', turn: 2 }))
      assertDeepEqual(dismissed, { ok: true }, 'dismiss result')
      valueOf(await dismiss(harness, { sessionId: 'session-dismiss', turn: 2 }))
      valueOf(await dismiss(harness, { sessionId: 'unknown-session' }))

      const after = valueOf(await wait(harness, { sessionId: 'session-dismiss', turn: 2, waitMs: 1000 }))
      assertEqual(after.suggestion, null, 'dismissed suggestion hidden')
      assertEqual(after.turn, 2, 'dismissed wait reports the turn')
      assertEqual(after.reason, 'stale', 'dismissed wait reason')
      assertEqual(harness.calls.length, 1, 'dismissed turn is not regenerated')
    } finally {
      await harness.disposeAll()
    }
  })

  await check('cache: invalidate on turn/start and disposal', async () => {
    const harness = createHarness()
    try {
      const { session, events } = createSession('session-invalidate')
      harness.addSession(session)
      seedCompletedTurn(harness, session, events, 1)
      valueOf(await wait(harness, { sessionId: 'session-invalidate', turn: 1, waitMs: 1000 }))
      appendEvent(harness, session, events, { type: 'turn/start', data: { turn: 2 } })
      const afterStart = valueOf(await wait(harness, { sessionId: 'session-invalidate', turn: 1, waitMs: 200 }))
      assertEqual(afterStart.suggestion, null, 'entry dropped on turn/start')
      assertEqual(afterStart.reason, 'no-completed-turn', 'open turn resolves as no completed turn')
      harness.sessions.delete(session.id)
      harness.emitDisposed(session)
      const afterDispose = valueOf(await wait(harness, { sessionId: 'session-invalidate', turn: 1, waitMs: 200 }))
      assertEqual(afterDispose.reason, 'unknown-session', 'disposed session state removed')
    } finally {
      await harness.disposeAll()
    }
  })

  await check('cache: deterministic sampling answers sampled-out without a model call', async () => {
    const harness = createHarness({ config: { ...DEFAULTS, sampleRate: 0 } })
    try {
      const { session, events } = createSession('session-sampled')
      harness.addSession(session)
      seedCompletedTurn(harness, session, events, 1)
      const value = valueOf(await wait(harness, { sessionId: 'session-sampled', turn: 1, waitMs: 500 }))
      assertEqual(value.suggestion, null, 'sampled-out has no suggestion')
      assertEqual(value.reason, 'sampled-out', 'sampled-out reason')
      assertEqual(harness.calls.length, 0, 'sampled-out makes no model call')
    } finally {
      await harness.disposeAll()
    }
  })

  await check('cache: disabled switch answers without touching the model', async () => {
    const harness = createHarness({ config: { ...DEFAULTS, enabled: false } })
    try {
      const { session, events } = createSession('session-disabled')
      harness.addSession(session)
      seedCompletedTurn(harness, session, events, 1)
      const value = valueOf(await wait(harness, { sessionId: 'session-disabled', turn: 1, waitMs: 200 }))
      assertEqual(value.suggestion, null, 'disabled has no suggestion')
      assertEqual(value.reason, 'disabled', 'disabled reason')
      assertEqual(harness.calls.length, 0, 'disabled makes no model call')
    } finally {
      await harness.disposeAll()
    }
  })

  await check('cache: TTL sweep expires entries (and aborts running work)', async () => {
    const harness = createHarness({ config: { ...DEFAULTS, cacheTtlMs: 1000 } })
    try {
      const { session, events } = createSession('session-ttl')
      harness.addSession(session)
      seedCompletedTurn(harness, session, events, 1)
      valueOf(await wait(harness, { sessionId: 'session-ttl', turn: 1, waitMs: 1000 }))
      assertEqual(harness.calls.length, 1, 'entry populated')
      // A second wait at a TTL-expired clock still serves the cached value...
      const before = valueOf(await wait(harness, { sessionId: 'session-ttl', turn: 1, waitMs: 200 }))
      assertEqual(before.suggestion, DEFAULT_SUGGESTION, 'cache hit before TTL')
      // ...but a fresh wait after expiry regenerates instead of serving the old result.
      await delay(1100)
      valueOf(await wait(harness, { sessionId: 'session-ttl', turn: 1, waitMs: 1000 }))
      assertEqual(harness.calls.length, 2, 'expired entry regenerated')
    } finally {
      await harness.disposeAll()
    }
  })

  // ── Wire-boundary failures ───────────────────────────────────────────────
  await check('wire: bad payloads return bad-request and never throw', async () => {
    const harness = createHarness()
    try {
      const badWaits = [
        null,
        undefined,
        'session',
        [],
        {},
        { sessionId: '' },
        { sessionId: '   ' },
        { sessionId: 42 },
        { sessionId: 'session-x', turn: -1 },
        { sessionId: 'session-x', turn: 1.5 },
        { sessionId: 'session-x', turn: '1' },
        { sessionId: 'session-x', waitMs: -1 },
        { sessionId: 'session-x', waitMs: 1.5 },
        { sessionId: 'session-x', waitMs: 'soon' },
      ]
      for (const payload of badWaits) {
        assertFailure(await wait(harness, payload), 'followup-prompt/bad-request', `wait ${JSON.stringify(payload)}`)
      }
      for (const payload of [null, [], {}, { sessionId: '' }, { sessionId: 'session-x', turn: -2 }]) {
        assertFailure(await dismiss(harness, payload), 'followup-prompt/bad-request', `dismiss ${JSON.stringify(payload)}`)
      }
      for (const raw of ['{not json', '[]', 'null', '"text"', '']) {
        const result = await post(harness, raw)
        assertFailure(result, ERROR_BAD_REQUEST, `raw body ${JSON.stringify(raw)}`)
      }
      for (const body of [{}, { endpoint: 42 }, { endpoint: '' }, { endpoint: null }]) {
        const result = await post(harness, body)
        assertFailure(result, ERROR_BAD_REQUEST, `body ${JSON.stringify(body)}`)
      }
      assertEqual(harness.calls.length, 0, 'invalid payloads never reach the model')
    } finally {
      await harness.disposeAll()
    }
  })

  await check('wire: unknown endpoint returns the bad-endpoint envelope', async () => {
    const harness = createHarness()
    try {
      const result = await callEndpoint(harness, 'suggestions/get', { sessionId: 'session-x' })
      assertFailure(result, ERROR_BAD_ENDPOINT, 'unknown endpoint')
      assert(result.error.message.includes('suggestions/get'), 'failure names the endpoint')
      const other = await callEndpoint(harness, 'foo/bar', {})
      assertFailure(other, ERROR_BAD_ENDPOINT, 'unknown endpoint name')
      assertEqual(harness.calls.length, 0, 'unknown endpoints never reach the model')
    } finally {
      await harness.disposeAll()
    }
  })

  await check('wire: unknown session, open turn, and stale turn resolve without a model call', async () => {
    const harness = createHarness()
    try {
      const unknown = valueOf(await wait(harness, { sessionId: 'missing-session', waitMs: 200 }))
      assertEqual(unknown.suggestion, null, 'unknown session has no suggestion')
      assertEqual(unknown.turn, null, 'unknown session has no turn')
      assertEqual(unknown.reason, 'unknown-session', 'unknown session reason')

      const open = createSession('session-open')
      harness.addSession(open.session)
      appendEvent(harness, open.session, open.events, { type: 'turn/start', data: { turn: 4 } })
      const noTurn = valueOf(await wait(harness, { sessionId: 'session-open', waitMs: 200 }))
      assertEqual(noTurn.suggestion, null, 'open turn has no suggestion')
      assertEqual(noTurn.turn, null, 'open turn has no completed turn')
      assertEqual(noTurn.reason, 'no-completed-turn', 'open turn reason')

      const stale = createSession('session-stale')
      harness.addSession(stale.session)
      seedCompletedTurn(harness, stale.session, stale.events, 1)
      seedCompletedTurn(harness, stale.session, stale.events, 2)
      const mismatch = valueOf(await wait(harness, { sessionId: 'session-stale', turn: 1, waitMs: 200 }))
      assertEqual(mismatch.suggestion, null, 'stale turn has no suggestion')
      assertEqual(mismatch.turn, 2, 'stale turn reports the authoritative turn')
      assertEqual(mismatch.reason, 'stale', 'stale turn reason')

      const recovered = valueOf(await wait(harness, { sessionId: 'session-stale', turn: 2, waitMs: 1000 }))
      assertEqual(recovered.suggestion, DEFAULT_SUGGESTION, 'retry with the authoritative turn succeeds')
      assertEqual(harness.calls.length, 1, 'only the matching turn billed a model call')
    } finally {
      await harness.disposeAll()
    }
  })

  await check('context: no request header yet answers no-route and can retry', async () => {
    const harness = createHarness()
    try {
      const events = []
      let header
      const session = {
        id: 'session-no-route',
        header: { version: 4, id: 'session-no-route', createdAt: 0, isSeeded: false },
        deriveMessages: () => [
          { id: 'r-0', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'sys' }] },
          { id: 'r-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] },
        ],
        requestHeader: () => header,
        toolHistory: () => ({ tools: [], updates: [] }),
        snapshotEvents: () => [...events],
      }
      harness.addSession(session)
      seedCompletedTurn(harness, session, events, 1)
      const first = valueOf(await wait(harness, { sessionId: 'session-no-route', turn: 1, waitMs: 500 }))
      assertEqual(first.suggestion, null, 'missing header: no suggestion')
      assertEqual(first.reason, PREDICTION_REASONS.noRoute, 'missing header reason')
      assertEqual(harness.calls.length, 0, 'missing header makes no model call')
      // A later request header (e.g. the session finished restoring) makes the
      // same turn retryable: no-route is not a cached terminal result.
      header = { config: { provider: 'fake-provider', model: 'fake-model' } }
      const retried = valueOf(await wait(harness, { sessionId: 'session-no-route', turn: 1, waitMs: 1000 }))
      assertEqual(retried.suggestion, DEFAULT_SUGGESTION, 'no-route is retried once a route exists')
      assertEqual(harness.calls.length, 1, 'retry bills exactly one call')
    } finally {
      await harness.disposeAll()
    }
  })

  await check('policy: subagent sessions are not predicted for', async () => {
    const harness = createHarness()
    try {
      const { session, events } = createSession('session-subagent', {
        header: { origin: 'subagent', delegationDepth: 1 },
      })
      harness.addSession(session)
      seedCompletedTurn(harness, session, events, 1)
      const value = valueOf(await wait(harness, { sessionId: 'session-subagent', turn: 1, waitMs: 200 }))
      assertEqual(value.suggestion, null, 'subagent session has no suggestion')
      assertEqual(value.reason, 'unknown-session', 'subagent session is invisible')
      assertEqual(harness.calls.length, 0, 'subagent session makes no model call')
    } finally {
      await harness.disposeAll()
    }
  })

  // ── Tool-call rejection loop ─────────────────────────────────────────────
  await check('tool-calls: rejected, pairing-valid, retried once, then suggestion', async () => {
    const customRejection = 'No tools are available in this context.'
    const harness = createHarness({
      config: { ...DEFAULTS, maxToolRejectRounds: 1, toolRejectionText: customRejection },
      streams: (request, index) => index === 0
        ? toolCallChunks([
          { id: 'call-1', name: 'fs_read', arguments: '{"path":"a.js"}' },
          { id: 'call-2', name: 'fs_read', arguments: '{"path":"b.js"}' },
        ])
        : textChunks('Run the tests'),
    })
    try {
      const { session, events } = createSession('session-tools')
      harness.addSession(session)
      seedCompletedTurn(harness, session, events, 5)
      const eventCountBefore = events.length
      const value = valueOf(await wait(harness, { sessionId: 'session-tools', turn: 5, waitMs: 2000 }))
      assertEqual(value.suggestion, 'Run the tests', 'second round text accepted')
      assertEqual(value.turn, 5, 'turn preserved')
      assertEqual(harness.calls.length, 2, 'exactly maxToolRejectRounds + 1 model calls')
      assertEqual(events.length, eventCountBefore, 'no tool side effects on the session log')

      const firstMessages = harness.calls[0].messages
      const retryMessages = harness.calls[1].messages
      assertEqual(harness.calls[1].tools?.[0]?.name, 'fs_read', 'tools restated on the retry round')
      assertEqual(
        retryMessages.length,
        firstMessages.length + 3,
        'assistant(tool-call) + one tool result per call appended',
      )
      const syntheticAssistant = retryMessages.at(-3)
      assertEqual(syntheticAssistant.role, 'assistant', 'synthetic assistant message appended')
      assertDeepEqual(
        syntheticAssistant.content.map((block) => block.type),
        ['tool-call', 'tool-call'],
        'synthetic assistant carries only tool-call blocks (no reasoning)',
      )
      assertEqual(syntheticAssistant.source.provider, 'fake-provider', 'synthetic assistant provider')
      const results = retryMessages.slice(-2)
      for (const result of results) {
        assertEqual(result.role, 'tool', 'synthetic tool result role')
        assertEqual(result.isError, true, 'synthetic tool result is an error')
        assertEqual(result.content[0].text, customRejection, 'configured unified rejection text')
        assertEqual(result.toolCallId, result.source.callId, 'tool result pairs with the call id')
      }
      assertDeepEqual(
        results.map((result) => result.toolCallId),
        ['call-1', 'call-2'],
        'one result per call in order',
      )
    } finally {
      await harness.disposeAll()
    }
  })

  await check('tool-calls: persistent calling abandons gracefully after the round cap', async () => {
    const harness = createHarness({
      config: { ...DEFAULTS, maxToolRejectRounds: 1 },
      streams: () => toolCallChunks([{ id: 'call-x', name: 'fs_read', arguments: '{}' }]),
    })
    try {
      const { session, events } = createSession('session-tools-persist')
      harness.addSession(session)
      seedCompletedTurn(harness, session, events, 1)
      const value = valueOf(await wait(harness, { sessionId: 'session-tools-persist', turn: 1, waitMs: 2000 }))
      assertEqual(value.suggestion, null, 'no suggestion after the cap')
      assertEqual(value.reason, PREDICTION_REASONS.toolRejected, 'tool-rejected reason')
      assertEqual(harness.calls.length, 2, 'never more than maxToolRejectRounds + 1 calls')
      // The abandonment is a cached terminal result: polling again does not re-bill.
      const again = valueOf(await wait(harness, { sessionId: 'session-tools-persist', turn: 1, waitMs: 500 }))
      assertEqual(again.suggestion, null, 'cached null after abandonment')
      assertEqual(again.reason, PREDICTION_REASONS.toolRejected, 'cached reason')
      assertEqual(harness.calls.length, 2, 'no repeated billing for an abandoned turn')
    } finally {
      await harness.disposeAll()
    }
  })

  await check('tool-calls: maxToolRejectRounds 0 abandons on the first call', async () => {
    const harness = createHarness({
      config: { ...DEFAULTS, maxToolRejectRounds: 0 },
      streams: () => toolCallChunks([{ id: 'call-y', name: 'fs_read', arguments: '{}' }]),
    })
    try {
      const { session, events } = createSession('session-tools-zero')
      harness.addSession(session)
      seedCompletedTurn(harness, session, events, 1)
      const value = valueOf(await wait(harness, { sessionId: 'session-tools-zero', turn: 1, waitMs: 2000 }))
      assertEqual(value.suggestion, null, 'no suggestion with rounds=0')
      assertEqual(value.reason, PREDICTION_REASONS.toolRejected, 'tool-rejected reason')
      assertEqual(harness.calls.length, 1, 'single model call')
    } finally {
      await harness.disposeAll()
    }
  })

  await check('tool-calls: duplicate call ids abandon without a retry', async () => {
    const harness = createHarness({
      config: { ...DEFAULTS, maxToolRejectRounds: 1 },
      streams: () => toolCallChunks([
        { id: 'call-dup', name: 'fs_read', arguments: '{}' },
        { id: 'call-dup', name: 'fs_read', arguments: '{}' },
      ]),
    })
    try {
      const { session, events } = createSession('session-tools-dup')
      harness.addSession(session)
      seedCompletedTurn(harness, session, events, 1)
      const value = valueOf(await wait(harness, { sessionId: 'session-tools-dup', turn: 1, waitMs: 2000 }))
      assertEqual(value.suggestion, null, 'duplicate ids abandon')
      assertEqual(value.reason, PREDICTION_REASONS.toolRejected, 'tool-rejected reason')
      assertEqual(harness.calls.length, 1, 'invalid pairing is not retried')
    } finally {
      await harness.disposeAll()
    }
  })

  await check('tool-calls: reusing a rejected call id in a later round abandons', async () => {
    const harness = createHarness({
      config: { ...DEFAULTS, maxToolRejectRounds: 2 },
      streams: () => toolCallChunks([
        { id: 'call-reused', name: 'fs_read', arguments: '{}' },
      ]),
    })
    try {
      const { session, events } = createSession('session-tools-reuse')
      harness.addSession(session)
      seedCompletedTurn(harness, session, events, 1)
      const value = valueOf(await wait(harness, {
        sessionId: 'session-tools-reuse', turn: 1, waitMs: 2000,
      }))
      assertEqual(value.suggestion, null, 'reused id abandons')
      assertEqual(value.reason, PREDICTION_REASONS.toolRejected, 'tool-rejected reason')
      assertEqual(harness.calls.length, 2, 'the reused id is not sent a third time')
    } finally {
      await harness.disposeAll()
    }
  })

  await check('timeout: a slow generation survives waitMs and serves a later poll', async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const harness = createHarness({
      streams: () => (async function* stream() {
        await gate
        yield* textChunks('Slow suggestion')
      })(),
    })
    try {
      const { session, events } = createSession('session-slow')
      harness.addSession(session)
      seedCompletedTurn(harness, session, events, 1)
      const timedOut = valueOf(await wait(harness, { sessionId: 'session-slow', turn: 1, waitMs: 50 }))
      assertEqual(timedOut.reason, 'timeout', 'the poll times out')
      assertEqual(harness.calls.length, 1, 'one generation started')
      release()
      await flush()
      await delay(20)
      const later = valueOf(await wait(harness, {
        sessionId: 'session-slow', turn: 1, waitMs: 2000,
      }))
      assertEqual(later.suggestion, 'Slow suggestion', 'a later poll observes the cached result')
      assertEqual(harness.calls.length, 1, 'no second model call')
    } finally {
      await harness.disposeAll()
    }
  })

  // ── Concurrency, abort, prefetch ─────────────────────────────────────────
  await check('concurrency: concurrent waiters share one generation', async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const harness = createHarness({
      streams: () => (async function* stream() {
        await gate
        yield* textChunks('Shared suggestion')
      })(),
    })
    try {
      const { session, events } = createSession('session-shared')
      harness.addSession(session)
      seedCompletedTurn(harness, session, events, 1)
      const first = wait(harness, { sessionId: 'session-shared', turn: 1, waitMs: 2000 })
      await flush()
      const second = wait(harness, { sessionId: 'session-shared', turn: 1, waitMs: 2000 })
      await flush()
      assertEqual(harness.calls.length, 1, 'one in-flight generation for two waiters')
      release()
      const [a, b] = await Promise.all([first, second])
      assertEqual(valueOf(a).suggestion, 'Shared suggestion', 'first waiter suggestion')
      assertEqual(valueOf(b).suggestion, 'Shared suggestion', 'second waiter suggestion')
      assertEqual(harness.calls.length, 1, 'shared generation billed once')
    } finally {
      await harness.disposeAll()
    }
  })

  await check('concurrency: maxConcurrent answers busy instead of queueing', async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const harness = createHarness({
      config: { ...DEFAULTS, maxConcurrent: 1 },
      streams: (request, index) => index === 0
        ? (async function* stream() {
          await gate
          yield* textChunks('First session')
        })()
        : textChunks('Second session'),
    })
    try {
      const first = createSession('session-busy-1')
      harness.addSession(first.session)
      seedCompletedTurn(harness, first.session, first.events, 1)
      const second = createSession('session-busy-2')
      harness.addSession(second.session)
      seedCompletedTurn(harness, second.session, second.events, 1)

      const running = wait(harness, { sessionId: 'session-busy-1', turn: 1, waitMs: 2000 })
      await flush()
      const busy = valueOf(await wait(harness, { sessionId: 'session-busy-2', turn: 1, waitMs: 200 }))
      assertEqual(busy.suggestion, null, 'busy has no suggestion')
      assertEqual(busy.reason, 'busy', 'busy reason')
      assertEqual(harness.calls.length, 1, 'busy session never dispatched')
      release()
      assertEqual(valueOf(await running).suggestion, 'First session', 'first session completes')
      const retried = valueOf(await wait(harness, { sessionId: 'session-busy-2', turn: 1, waitMs: 1000 }))
      assertEqual(retried.suggestion, 'Second session', 'busy is not a cached terminal result')
      assertEqual(harness.calls.length, 2, 'the busy session retried once a slot was free')
    } finally {
      await harness.disposeAll()
    }
  })

  await check('abort: a cancelled waiter stops the unobserved generation', async () => {
    const harness = createHarness({
      streams: (request, index) => index === 0
        ? (async function* stream() {
          await new Promise((resolve, reject) => {
            if (request.signal?.aborted) {
              reject(new Error('aborted'))
              return
            }
            request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
        : textChunks('Recovered'),
    })
    try {
      const { session, events } = createSession('session-abort')
      harness.addSession(session)
      seedCompletedTurn(harness, session, events, 1)

      const controller = new AbortController()
      const pending = wait(harness, { sessionId: 'session-abort', turn: 1, waitMs: 5000 }, controller.signal)
      await flush()
      assertEqual(harness.calls.length, 1, 'generation started')
      controller.abort()
      const aborted = valueOf(await pending)
      assertEqual(aborted.suggestion, null, 'aborted wait has no suggestion')
      assertEqual(aborted.reason, 'aborted', 'aborted reason')
      await flush()
      await delay(20)
      const retried = valueOf(await wait(harness, { sessionId: 'session-abort', turn: 1, waitMs: 1000 }))
      assertEqual(retried.suggestion, 'Recovered', 'a later wait can regenerate the turn')
      assertEqual(harness.calls.length, 2, 'cancelled generation was not cached')
    } finally {
      await harness.disposeAll()
    }
  })

  await check('prefetch: turn/end(completed) pre-generates exactly once', async () => {
    const harness = createHarness({
      config: { ...DEFAULTS, prefetchOnTurnEnd: true },
      streams: () => textChunks('Prefetched suggestion'),
    })
    try {
      const { session, events } = createSession('session-prefetch')
      harness.addSession(session)
      seedCompletedTurn(harness, session, events, 1)
      await flush()
      await flush()
      assertEqual(harness.calls.length, 1, 'exactly one prefetch generation')
      const value = valueOf(await wait(harness, { sessionId: 'session-prefetch', turn: 1, waitMs: 1000 }))
      assertEqual(value.suggestion, 'Prefetched suggestion', 'prefetched suggestion served')
      assertEqual(harness.calls.length, 1, 'wait reuses the prefetched result')

      appendEvent(harness, session, events, { type: 'turn/start', data: { turn: 2 } })
      await flush()
      const openTurn = valueOf(await wait(harness, { sessionId: 'session-prefetch', turn: 1, waitMs: 200 }))
      assertEqual(openTurn.reason, 'no-completed-turn', 'a new turn obsoletes the old suggestion')
    } finally {
      await harness.disposeAll()
    }
  })

  await check('prefetch: non-completed turn endings never generate', async () => {
    const harness = createHarness({
      config: { ...DEFAULTS, prefetchOnTurnEnd: true },
      streams: () => textChunks('Should not appear'),
    })
    try {
      const { session, events } = createSession('session-prefetch-aborted')
      harness.addSession(session)
      appendEvent(harness, session, events, { type: 'turn/start', data: { turn: 1 } })
      appendEvent(harness, session, events, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
      await flush()
      await flush()
      assertEqual(harness.calls.length, 0, 'aborted turn is not predicted for')
    } finally {
      await harness.disposeAll()
    }
  })

  await check('lifecycle: disposal aborts in-flight work and unregisters the route', async () => {
    let streamAborted = false
    const harness = createHarness({
      config: { ...DEFAULTS, prefetchOnTurnEnd: true },
      streams: (request) => (async function* stream() {
        await new Promise((resolve) => {
          const onAbort = () => {
            streamAborted = true
            resolve()
          }
          if (request.signal?.aborted) onAbort()
          else request.signal?.addEventListener('abort', onAbort, { once: true })
        })
        yield { type: 'finish', reason: { kind: 'aborted' } }
      })(),
    })
    const { session, events } = createSession('session-dispose')
    harness.addSession(session)
    seedCompletedTurn(harness, session, events, 1)
    await flush()
    assertEqual(harness.calls.length, 1, 'prefetch generation started')
    await harness.disposeAll()
    await delay(20)
    assertEqual(streamAborted, true, 'plugin disposal aborted the in-flight generation')
    assertEqual(harness.routes.size, 0, 'route unregistered on disposal')
  })

  // ── Summary ──────────────────────────────────────────────────────────────
  let failures = 0
  for (const result of results) {
    if (result.ok) {
      console.log(`  \u2713 ${result.label}`)
    } else {
      failures += 1
      console.log(`  \u2717 ${result.label}`)
      const message = String(result.error?.stack ?? result.error)
      for (const line of message.split('\n').slice(0, 6)) console.log(`      ${line}`)
    }
  }
  console.log('')
  if (failures === 0) {
    console.log(`Host smoke PASSED: ${results.length} checks.`)
    console.log('Offline contract check only — live Harness behavior is not covered.')
    process.exit(0)
  }
  console.log(`Host smoke FAILED: ${failures} of ${results.length} checks failed.`)
  process.exit(1)
}

main().catch((error) => {
  console.error('Host smoke crashed before reporting:', error)
  process.exit(2)
})
