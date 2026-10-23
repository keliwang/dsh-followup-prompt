// Stub-driven Host tests: drives the real Host modules with a fake ctx, session store,
// Fetch-route registry and `ctx.llm.stream`. Live Harness behavior is not covered.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, Config, name, inject } from '../host/index.js'
import { DEFAULTS, FIELDS, resolveConfig } from '../host/config.js'
import { MAX_CONCURRENT, PredictionCache } from '../host/cache.js'
import { isSubagentSession, latestCompletedTurn } from '../host/session.js'
import {
  buildPredictionPairs,
  buildRequestMessages,
  FOLLOWUP_INSTRUCTION,
  MAX_SUGGESTION_CHARS,
  PREDICTION_CUE,
  normalizeSuggestion,
} from '../host/prediction.js'
import { ERROR_BAD_ENDPOINT, ERROR_BAD_REQUEST, ROUTE } from '../host/channel.js'

const DEFAULT_SUGGESTION = 'Add a unit test for the guard'

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
      tools: [{ name: 'fs_read', description: 'Read a file', parameters: { type: 'object' } }],
    }),
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

async function* textChunks(text, usage) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  if (usage !== undefined) yield { type: 'usage', usage }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function createHarness(options = {}) {
  const listeners = new Map()
  const effects = []
  const routes = new Map()
  const sessions = new Map()
  const calls = []
  const injections = []
  const pagePolicies = []
  const config = options.config ?? { ...DEFAULTS }
  const streams = options.streams ?? (() => textChunks(DEFAULT_SUGGESTION))
  const fiber = { uid: 'followup-prompt' }
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fiber,
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
    inject(deps, callback) {
      injections.push([...deps])
      const child = {
        effect(factory, label) {
          const cleanup = factory()
          effects.push({ label, cleanup })
          return async () => {
            if (typeof cleanup === 'function') await cleanup()
          }
        },
        settings: {
          configure(presentation, owner) {
            pagePolicies.push({ presentation, owner })
            return () => { pagePolicies.push({ released: true }) }
          },
        },
      }
      callback(child)
      return child
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
    injections,
    pagePolicies,
    fiber,
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
  assert.equal(result.ok, false, `${label}: ok flag`)
  assert.equal(result.error?.code, code, `${label}: error code`)
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
  assert.equal(response.status, 200, 'route answers HTTP 200 for protocol results')
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

// ── Tests ───────────────────────────────────────────────────────────────────

// ── Entry contract ───────────────────────────────────────────────────────
test('entry contract: name / inject / Config / apply', () => {
  assert.equal(name, 'followup-prompt', 'plugin name')
  assert.deepEqual(inject, ['connection', 'llm', 'sessions'], 'inject list')
  assert(!inject.includes('webServer'), 'the /api Fetch route needs no webServer injection')
  assert.equal(typeof apply, 'function', 'apply export')
  assert.equal(typeof Config, 'function', 'Config export (schemastery schema)')
  const standard = Config['~standard']
  assert(standard !== undefined && typeof standard.validate === 'function', 'Config is a standard-schema')
  const validated = standard.validate({ ...DEFAULTS })
  assert(validated.issues === undefined, `Config rejected the documented defaults: ${JSON.stringify(validated.issues)}`)
})

test('settings: the row page opts out of the automatic settings page', () => {
  const harness = createHarness()
  assert.deepEqual(harness.injections, [['settings']], 'settings is an optional child dependency only')
  assert.equal(harness.pagePolicies.length, 1, 'one page policy registered')
  assert.deepEqual(harness.pagePolicies[0].presentation, { auto: false })
  assert.equal(harness.pagePolicies[0].owner, harness.fiber, 'the policy belongs to the plugin fiber')
  assert.deepEqual(inject, ['connection', 'llm', 'sessions'], 'the required inject face stays unchanged')
})

test('config: the resolver covers every schema field', () => {
  const resolved = resolveConfig({})
  assert.deepEqual(Object.keys(resolved), Object.keys(FIELDS), 'resolved key set')
  assert.deepEqual({ ...resolved }, { ...DEFAULTS }, 'resolved defaults')
  // Thinking stays on by default: `off` drops historical thinking blocks from the
  // inherited prefix, which makes the provider prefix cache miss entirely.
  assert.equal(DEFAULTS.reasoningEffort, 'low', 'default reasoning effort keeps the prefix cacheable')
  // The Loader validates the row config through the schema; volatile fields
  // arrive as live `{ get() }` refs, which resolveConfig must unwind.
  assert.deepEqual({ ...resolveConfig(Config({})) }, { ...DEFAULTS }, 'empty row materializes every default')
  assert.throws(() => Config({ maxTokens: 99999 }), 'out-of-range row is rejected, not half-applied')
})

test('config: resolves volatile references and clamps bounds', () => {
  const volatile = (value) => ({ get: () => value })
  const live = resolveConfig({
    provider: volatile('  cheap-provider  '),
    model: volatile('cheap-model'),
    reasoningEffort: volatile('turbo'),
    maxTokens: volatile(0),
    timeoutMs: volatile(99999),
    prompt: volatile('  Predict it.  '),
  })
  assert.equal(live.provider, 'cheap-provider', 'volatile provider trimmed')
  assert.equal(live.model, 'cheap-model', 'volatile model')
  assert.equal(live.reasoningEffort, DEFAULTS.reasoningEffort, 'invalid reasoning effort falls back')
  assert.equal(live.maxTokens, FIELDS.maxTokens.range[0], 'maxTokens clamped up')
  assert.equal(live.timeoutMs, FIELDS.timeoutMs.range[1], 'timeoutMs capped at 30s')
  assert.equal(live.prompt, 'Predict it.', 'prompt trimmed')

  const halfRoute = resolveConfig({ provider: 'only-provider' })
  assert.equal(halfRoute.provider, '', 'half-configured route: provider cleared')
  assert.equal(halfRoute.model, '', 'half-configured route: model cleared')
  assert.equal(resolveConfig({ timeoutMs: 1000 }).timeoutMs, 2000, 'timeout floor is 2s')
  assert.equal(resolveConfig({ reasoningEffort: 'low' }).reasoningEffort, 'low', 'valid reasoning effort kept')
})

test('prediction helpers: suggestion normalization and safety filters', () => {
  assert.equal(normalizeSuggestion('```\nRun the tests\n```'), 'Run the tests', 'markdown fence stripped')
  assert.equal(normalizeSuggestion('"thanks"'), 'thanks', 'double quotes stripped')
  assert.equal(normalizeSuggestion('`continue`'), 'continue', 'backticks stripped')
  assert.equal(normalizeSuggestion('NO_PREDICTION'), null, 'sentinel dropped')
  assert.equal(normalizeSuggestion('   '), null, 'empty dropped')
  assert.equal(normalizeSuggestion('bad\u0007bell'), null, 'control character dropped')
  assert.equal(normalizeSuggestion('key sk-abcdefghijklmnopqrst'), null, 'secret-shaped token dropped')
  const truncated = normalizeSuggestion('x'.repeat(500))
  assert.equal(truncated.length, MAX_SUGGESTION_CHARS, 'suggestion truncated')
})

test('prediction: the request is a condensed transcript of one pair per turn', () => {
  const messages = [
    { id: 'p-s', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'sys' }] },
    { id: 'p-u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Fix the bug in a.js' }] },
    { id: 'p-a1a', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'tool-call', id: 'c1', name: 'fs', arguments: '{}' }] },
    { id: 'p-t1', role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1', content: [{ type: 'text', text: 'tool output' }] },
    { id: 'p-a1b', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'reasoning', text: 'secret thinking' }, { type: 'text', text: 'I fixed the guard. The tests pass now.' }] },
    { id: 'p-u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Run the tests' }] },
    { id: 'p-a2', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'Done.' }] },
  ]
  const { session } = createSession('pairs', { messages })
  const pairs = buildPredictionPairs(session)
  assert.deepEqual(pairs.map((pair) => pair.user), ['Fix the bug in a.js', 'Run the tests'], 'one pair per human turn')
  assert.deepEqual(
    pairs.map((pair) => pair.assistant),
    ['I fixed the guard. The tests pass now.', 'Done.'],
    'assistant side keeps the full visible reply text',
  )
  assert.equal(JSON.stringify(pairs).includes('secret thinking'), false, 'thinking blocks are dropped')
  const request = buildRequestMessages(session, 'p', 'm')
  assert(request !== null, 'condensed request built')
  assert.deepEqual(
    request.map((message) => message.role),
    ['user', 'assistant', 'user', 'assistant', 'user'],
    'pairs then the closing cue',
  )
  assert.equal(request[3].content[0].text, 'Done.', 'assistant side carries the reply text')
  assert.equal(request.at(-1).content[0].text, PREDICTION_CUE, 'cue closes the transcript')
})

test('prediction: one more turn appends one pair to the same prefix', () => {
  const pair = (index) => [
    { id: `q-u${index}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `question ${index}` }] },
    { id: `q-a${index}`, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: `answer ${index}.` }] },
  ]
  const shape = (session) => buildRequestMessages(session, 'p', 'm')
    .map((message) => ({ role: message.role, text: message.content[0].text }))
  const two = shape(createSession('prefix-two', { messages: [...pair(1), ...pair(2)] }).session)
  const three = shape(createSession('prefix-three', { messages: [...pair(1), ...pair(2), ...pair(3)] }).session)
  assert.deepEqual(
    three.slice(0, two.length - 1),
    two.slice(0, two.length - 1),
    'the previous prompt (minus its cue) is a prefix of the next prompt',
  )
})

test('prediction: injected user context does not start a new pair', () => {
  const messages = [
    { id: 'i-u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] },
    { id: 'i-a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'hi there.' }] },
    { id: 'i-u2', role: 'user', source: { kind: 'system-reminder' }, content: [{ type: 'text', text: 'injected context' }] },
    { id: 'i-a2', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'second answer.' }] },
  ]
  const { session } = createSession('injected', { messages })
  const pairs = buildPredictionPairs(session)
  assert.equal(pairs.length, 1, 'injected user context is not a turn boundary')
  assert.equal(pairs[0].assistant, 'hi there.\n\nsecond answer.', 'assistant text accumulates across the turn')
})

test('prediction: a session without a complete pair answers no-route', () => {
  const { session } = createSession('pairs-empty', {
    messages: [
      { id: 'e-s', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'sys' }] },
      { id: 'e-u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] },
    ],
  })
  assert.equal(buildRequestMessages(session, 'p', 'm'), null, 'no assistant text means no pair')
})

test('request: the configured prompt is sent as the system prompt', async () => {
  const harness = createHarness({ config: { ...DEFAULTS, prompt: '  Predict the next message.  ' } })
  try {
    const { session, events } = createSession('session-system-prompt')
    harness.addSession(session)
    seedCompletedTurn(harness, session, events, 1)
    valueOf(await wait(harness, { sessionId: 'session-system-prompt' }))
    const request = harness.calls[0]
    assert.equal(request.system, 'Predict the next message.', 'configured prompt becomes the system prompt')
    assert.equal(request.messages.at(-1).content[0].text, PREDICTION_CUE, 'a short cue is the final user turn')
  } finally {
    await harness.disposeAll()
  }
})

test('prediction: long tool output never reaches the prediction request', async () => {
  const filler = 'y'.repeat(30_000)
  const messages = [
    { id: 'l-s', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'System prompt' }] },
    { id: 'l-u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Do the thing' }] },
    { id: 'l-a1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'tool-call', id: 'c9', name: 'bash', arguments: '{"cmd":"x"}' }] },
    { id: 'l-t1', role: 'tool', source: { kind: 'tool', callId: 'c9' }, toolCallId: 'c9', content: [{ type: 'text', text: filler }] },
    { id: 'l-a2', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'All done.' }] },
  ]
  const harness = createHarness()
  try {
    const { session, events } = createSession('session-long-agentic', { messages })
    harness.addSession(session)
    seedCompletedTurn(harness, session, events, 1)
    const value = valueOf(await wait(harness, { sessionId: 'session-long-agentic' }))
    assert.equal(value.suggestion, DEFAULT_SUGGESTION, 'the prediction runs')
    const request = harness.calls[0]
    assert.equal(request.messages.length, 3, 'one pair plus the closing cue')
    assert.equal(request.messages[0].content[0].text, 'Do the thing', 'human message kept')
    assert.equal(request.messages[1].content[0].text, 'All done.', 'assistant side is the last sentence only')
    assert.equal(JSON.stringify(request.messages).includes(filler.slice(0, 100)), false, 'tool output is not carried')
    assert.equal(request.system, FOLLOWUP_INSTRUCTION, 'prediction instruction is the system prompt')
    assert.equal(request.tools, undefined, 'no tools are sent')
    assert.equal(request.toolHistory, undefined, 'no tool history is sent')
  } finally {
    await harness.disposeAll()
  }
})

test('turn resolution: latest completed turn walk', async () => {
  const harness = createHarness()
  try {
    const { session, events } = createSession('turn-walk')
    const push = (event) => appendEvent(harness, session, events, event)
    assert.equal(latestCompletedTurn(session), null, 'empty log')
    push({ type: 'turn/start', data: { turn: 0 } })
    assert.equal(latestCompletedTurn(session), null, 'open turn')
    push({ type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } })
    assert.equal(latestCompletedTurn(session), 0, 'completed turn 0')
    push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
    assert.equal(latestCompletedTurn(session), null, 'non-completed latest turn')
  } finally {
    await harness.disposeAll()
  }
  assert.equal(
    isSubagentSession({ header: { origin: 'subagent' } }),
    true,
    'subagent origin detected',
  )
  assert.equal(
    isSubagentSession({ header: { parentSession: 'parent' } }),
    false,
    'a user fork is not a subagent',
  )
})

// ── Channel registration and the lazy wait path ─────────────────────────
test('route: exact POST /api/followup-prompt/rpc registered once', async () => {
  const harness = createHarness()
  try {
    assert.equal(harness.routes.size, 1, 'one Fetch route registered')
    assert(harness.routes.has(ROUTE), `route ${ROUTE} registered`)
    assert.equal(harness.route.path, ROUTE, 'route path')
    // Mirrors Connection's `assertFetchRoute`/`endpointFromPath('/api', …)` shape check.
    assert(/^\/api\/[A-Za-z0-9_$.-]+(\/[A-Za-z0-9_$.-]+)*$/.test(ROUTE), 'route path is a valid /api endpoint path')
    assert.deepEqual(harness.route.methods, ['POST'], 'route methods')
    assert.equal(harness.route.requestBody, 'buffered', 'route body mode')
    assert.equal(typeof harness.route.fetch, 'function', 'route fetch handler')
    const methodResponse = await harness.route.fetch(new Request(`http://127.0.0.1:57434${ROUTE}`, { method: 'GET' }))
    assert.equal(methodResponse.status, 405, 'non-POST method is rejected outside the envelope')
  } finally {
    await harness.disposeAll()
    assert.equal(harness.routes.size, 0, 'route unregistered on disposal')
  }
})

test('wait: turn/end(completed) + lazy wait makes exactly one call', async () => {
  const harness = createHarness({ config: { ...DEFAULTS, timeoutMs: 2000 } })
  try {
    const { session, events } = createSession('session-lazy')
    harness.addSession(session)
    seedCompletedTurn(harness, session, events, 1)
    await flush()
    assert.equal(harness.calls.length, 0, 'turn/end alone makes no model call')
    const eventCountBefore = events.length

    const first = valueOf(await wait(harness, { sessionId: 'session-lazy' }))
    assert.equal(first.suggestion, DEFAULT_SUGGESTION, 'first wait returns the suggestion')
    assert.equal(first.turn, 1, 'first wait reports the turn')
    assert.equal(first.reason, undefined, 'a suggestion carries no reason')
    assert.equal(harness.calls.length, 1, 'exactly one model call')
    assert.equal(events.length, eventCountBefore, 'prediction appends no session events')

    const request = harness.calls[0]
    assert.equal(request.provider, 'fake-provider', 'inherited provider')
    assert.equal(request.model, 'fake-model', 'inherited model')
    assert.equal(request.temperature, 0.3, 'inherited sampling control')
    assert.equal(request.reasoningEffort, 'low', 'thinking defaults to low')
    assert.equal(request.maxTokens, DEFAULTS.maxTokens, 'prediction output cap applied')
    assert.equal(request.sessionId, 'session-lazy', 'session attribution')
    assert.equal(request.tools, undefined, 'no tool declarations are sent')
    assert.equal(request.toolHistory, undefined, 'no tool history is sent')
    assert(request.signal instanceof AbortSignal, 'cancellation signal passed')
    const last = request.messages.at(-1)
    assert.equal(last.role, 'user', 'the final user turn is the cue')
    assert.equal(last.content[0].text, PREDICTION_CUE, 'the final user turn is the cue')
    assert.equal(request.system, FOLLOWUP_INSTRUCTION, 'prediction instruction is the system prompt')
    assert.equal(request.messages[0].role, 'user', 'the transcript starts with the human message')
    assert.equal(request.messages.length, 3, 'one condensed pair plus the closing cue')

    const second = valueOf(await wait(harness, { sessionId: 'session-lazy' }))
    assert.equal(second.suggestion, DEFAULT_SUGGESTION, 'cached wait returns the suggestion')
    assert.equal(second.turn, 1, 'cached wait reports the turn')
    assert.equal(harness.calls.length, 1, 'cached wait makes no second model call')
  } finally {
    await harness.disposeAll()
  }
})

test('request: the prediction policy replaces the inherited effort and output cap', async () => {
  const requestConfig = {
    provider: 'fake-provider',
    model: 'fake-model',
    reasoningEffort: 'max',
    maxTokens: 4096,
    temperature: 0.1,
  }
  for (const [reasoningEffort, expected] of [['low', 'low'], ['', undefined]]) {
    const harness = createHarness({ config: { ...DEFAULTS, reasoningEffort, maxTokens: 96 } })
    try {
      const { session, events } = createSession('session-policy', { requestConfig })
      harness.addSession(session)
      seedCompletedTurn(harness, session, events, 1)
      valueOf(await wait(harness, { sessionId: 'session-policy' }))
      const request = harness.calls[0]
      assert.equal(request.reasoningEffort, expected, `reasoningEffort ${JSON.stringify(reasoningEffort)} is never inherited`)
      assert.equal(request.maxTokens, 96, 'configured output cap applied')
      assert.equal(request.temperature, 0.1, 'other inherited controls survive')
    } finally {
      await harness.disposeAll()
    }
  }
})

// ── Cache, dismiss, disabled ──────────────────────────────
test('dismiss: the turn is no longer served (stale), idempotently', async () => {
  const harness = createHarness()
  try {
    const { session, events } = createSession('session-dismiss')
    harness.addSession(session)
    seedCompletedTurn(harness, session, events, 2)
    valueOf(await wait(harness, { sessionId: 'session-dismiss' }))
    assert.equal(harness.calls.length, 1, 'initial generation')

    const dismissed = valueOf(await dismiss(harness, { sessionId: 'session-dismiss', turn: 2 }))
    assert.deepEqual(dismissed, { ok: true }, 'dismiss result')
    valueOf(await dismiss(harness, { sessionId: 'session-dismiss', turn: 2 }))
    valueOf(await dismiss(harness, { sessionId: 'unknown-session' }))

    const after = valueOf(await wait(harness, { sessionId: 'session-dismiss' }))
    assert.equal(after.suggestion, null, 'dismissed suggestion hidden')
    assert.equal(after.turn, 2, 'dismissed wait reports the turn')
    assert.equal(after.reason, 'stale', 'dismissed wait reason')
    assert.equal(harness.calls.length, 1, 'dismissed turn is not regenerated')
  } finally {
    await harness.disposeAll()
  }
})

test('cache: invalidate on turn/start and disposal', async () => {
  const harness = createHarness()
  try {
    const { session, events } = createSession('session-invalidate')
    harness.addSession(session)
    seedCompletedTurn(harness, session, events, 1)
    valueOf(await wait(harness, { sessionId: 'session-invalidate' }))
    appendEvent(harness, session, events, { type: 'turn/start', data: { turn: 2 } })
    const afterStart = valueOf(await wait(harness, { sessionId: 'session-invalidate' }))
    assert.equal(afterStart.suggestion, null, 'entry dropped on turn/start')
    assert.equal(afterStart.reason, 'no-completed-turn', 'open turn resolves as no completed turn')
    harness.sessions.delete(session.id)
    harness.emitDisposed(session)
    const afterDispose = valueOf(await wait(harness, { sessionId: 'session-invalidate' }))
    assert.equal(afterDispose.reason, 'unknown-session', 'disposed session state removed')
  } finally {
    await harness.disposeAll()
  }
})

// ── Wire-boundary failures ───────────────────────────────────────────────
test('wire: bad payloads return bad-request and never throw', async () => {
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
    assert.equal(harness.calls.length, 0, 'invalid payloads never reach the model')
  } finally {
    await harness.disposeAll()
  }
})

test('wire: unknown endpoint returns the bad-endpoint envelope', async () => {
  const harness = createHarness()
  try {
    const result = await callEndpoint(harness, 'suggestions/get', { sessionId: 'session-x' })
    assertFailure(result, ERROR_BAD_ENDPOINT, 'unknown endpoint')
    assert(result.error.message.includes('suggestions/get'), 'failure names the endpoint')
    const other = await callEndpoint(harness, 'foo/bar', {})
    assertFailure(other, ERROR_BAD_ENDPOINT, 'unknown endpoint name')
    assert.equal(harness.calls.length, 0, 'unknown endpoints never reach the model')
  } finally {
    await harness.disposeAll()
  }
})

test('wire: unknown session and open turn resolve without a model call', async () => {
  const harness = createHarness()
  try {
    const unknown = valueOf(await wait(harness, { sessionId: 'missing-session' }))
    assert.equal(unknown.suggestion, null, 'unknown session has no suggestion')
    assert.equal(unknown.turn, null, 'unknown session has no turn')
    assert.equal(unknown.reason, 'unknown-session', 'unknown session reason')

    const open = createSession('session-open')
    harness.addSession(open.session)
    appendEvent(harness, open.session, open.events, { type: 'turn/start', data: { turn: 4 } })
    const noTurn = valueOf(await wait(harness, { sessionId: 'session-open' }))
    assert.equal(noTurn.suggestion, null, 'open turn has no suggestion')
    assert.equal(noTurn.turn, null, 'open turn has no completed turn')
    assert.equal(noTurn.reason, 'no-completed-turn', 'open turn reason')

    assert.equal(harness.calls.length, 0, 'no model call')
  } finally {
    await harness.disposeAll()
  }
})

test('context: no request header yet answers no-route and can retry', async () => {
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
        { id: 'r-2', role: 'assistant', source: { kind: 'model', provider: 'fake-provider', model: 'fake-model' }, content: [{ type: 'text', text: 'Hi! How can I help?' }] },
      ],
      requestHeader: () => header,
      snapshotEvents: () => [...events],
    }
    harness.addSession(session)
    seedCompletedTurn(harness, session, events, 1)
    const first = valueOf(await wait(harness, { sessionId: 'session-no-route' }))
    assert.equal(first.suggestion, null, 'missing header: no suggestion')
    assert.equal(first.reason, 'no-route', 'missing header reason')
    assert.equal(harness.calls.length, 0, 'missing header makes no model call')
    // A later request header (e.g. the session finished restoring) makes the
    // same turn retryable: no-route is not a cached terminal result.
    header = { config: { provider: 'fake-provider', model: 'fake-model' } }
    const retried = valueOf(await wait(harness, { sessionId: 'session-no-route' }))
    assert.equal(retried.suggestion, DEFAULT_SUGGESTION, 'no-route is retried once a route exists')
    assert.equal(harness.calls.length, 1, 'retry bills exactly one call')
  } finally {
    await harness.disposeAll()
  }
})

test('policy: subagent sessions are not predicted for', async () => {
  const harness = createHarness()
  try {
    const { session, events } = createSession('session-subagent', {
      header: { origin: 'subagent', delegationDepth: 1 },
    })
    harness.addSession(session)
    seedCompletedTurn(harness, session, events, 1)
    const value = valueOf(await wait(harness, { sessionId: 'session-subagent' }))
    assert.equal(value.suggestion, null, 'subagent session has no suggestion')
    assert.equal(value.reason, 'unknown-session', 'subagent session is invisible')
    assert.equal(harness.calls.length, 0, 'subagent session makes no model call')
  } finally {
    await harness.disposeAll()
  }
})

test('wait: the long poll lasts until a slow generation settles', async () => {
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
    const pending = wait(harness, { sessionId: 'session-slow' })
    await delay(50)
    release()
    const value = valueOf(await pending)
    assert.equal(value.suggestion, 'Slow suggestion', 'the poll waits for the generation')
    assert.equal(harness.calls.length, 1, 'one model call')
  } finally {
    await harness.disposeAll()
  }
})

test('wait: a generation ignoring its deadline is cut off by the wait guard', async () => {
  let signal
  const cache = new PredictionCache({
    generate: (session, turn, generationSignal) => {
      signal = generationSignal
      return new Promise(() => {})
    },
  })
  const value = await cache.wait({ session: { id: 'hung' }, turn: 1, waitMs: 20 })
  assert.deepEqual(value, { suggestion: null, turn: 1, reason: 'timeout' }, 'the guard answers timeout')
  assert.equal(signal.aborted, true, 'the unobserved generation is aborted')
  const others = Array.from({ length: MAX_CONCURRENT }, (_, index) => (
    cache.wait({ session: { id: `other-${index}` }, turn: 1, waitMs: 20 })
  ))
  for (const other of await Promise.all(others)) {
    assert.notEqual(other.reason, 'busy', 'the hung generation no longer holds a concurrency slot')
  }
  cache.dispose()
})

test('timeout: timeoutMs aborts a hung model call as timeout', async () => {
  const harness = createHarness({
    config: { ...DEFAULTS, timeoutMs: FIELDS.timeoutMs.range[0] },
    streams: (request) => (async function* stream() {
      await new Promise((resolve) => request.signal.addEventListener('abort', resolve, { once: true }))
      yield { type: 'finish', reason: { kind: 'aborted' } }
    })(),
  })
  try {
    const { session, events } = createSession('session-deadline')
    harness.addSession(session)
    seedCompletedTurn(harness, session, events, 1)
    const value = valueOf(await wait(harness, { sessionId: 'session-deadline' }))
    assert.equal(value.suggestion, null, 'no suggestion after the deadline')
    assert.equal(value.reason, 'timeout', 'deadline reported as timeout, not aborted')
  } finally {
    await harness.disposeAll()
  }
})

// ── Concurrency, abort ───────────────────────────────────────────────────
test('concurrency: concurrent waiters share one generation', async () => {
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
    const first = wait(harness, { sessionId: 'session-shared' })
    await flush()
    const second = wait(harness, { sessionId: 'session-shared' })
    await flush()
    assert.equal(harness.calls.length, 1, 'one in-flight generation for two waiters')
    release()
    const [a, b] = await Promise.all([first, second])
    assert.equal(valueOf(a).suggestion, 'Shared suggestion', 'first waiter suggestion')
    assert.equal(valueOf(b).suggestion, 'Shared suggestion', 'second waiter suggestion')
    assert.equal(harness.calls.length, 1, 'shared generation billed once')
  } finally {
    await harness.disposeAll()
  }
})

test('concurrency: MAX_CONCURRENT running generations answer busy instead of queueing', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const harness = createHarness({
    streams: (request, index) => index < MAX_CONCURRENT
      ? (async function* stream() {
        await gate
        yield* textChunks('Gated session')
      })()
      : textChunks('Late session'),
  })
  try {
    const ids = Array.from({ length: MAX_CONCURRENT + 1 }, (_, index) => `session-busy-${index}`)
    for (const id of ids) {
      const { session, events } = createSession(id)
      harness.addSession(session)
      seedCompletedTurn(harness, session, events, 1)
    }
    const running = ids.slice(0, -1).map((sessionId) => wait(harness, { sessionId }))
    await flush()
    const busy = valueOf(await wait(harness, { sessionId: ids.at(-1) }))
    assert.equal(busy.suggestion, null, 'busy has no suggestion')
    assert.equal(busy.reason, 'busy', 'busy reason')
    assert.equal(harness.calls.length, MAX_CONCURRENT, 'busy session never dispatched')
    release()
    for (const pending of running) assert.equal(valueOf(await pending).suggestion, 'Gated session', 'running sessions complete')
    const retried = valueOf(await wait(harness, { sessionId: ids.at(-1) }))
    assert.equal(retried.suggestion, 'Late session', 'busy is not a cached terminal result')
    assert.equal(harness.calls.length, MAX_CONCURRENT + 1, 'the busy session retried once a slot was free')
  } finally {
    await harness.disposeAll()
  }
})

test('abort: a cancelled waiter stops the unobserved generation', async () => {
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
    const pending = wait(harness, { sessionId: 'session-abort' }, controller.signal)
    await flush()
    assert.equal(harness.calls.length, 1, 'generation started')
    controller.abort()
    const aborted = valueOf(await pending)
    assert.equal(aborted.suggestion, null, 'aborted wait has no suggestion')
    assert.equal(aborted.reason, 'aborted', 'aborted reason')
    await flush()
    await delay(20)
    const retried = valueOf(await wait(harness, { sessionId: 'session-abort' }))
    assert.equal(retried.suggestion, 'Recovered', 'a later wait can regenerate the turn')
    assert.equal(harness.calls.length, 2, 'cancelled generation was not cached')
  } finally {
    await harness.disposeAll()
  }
})

test('lifecycle: disposal aborts in-flight work and unregisters the route', async () => {
  let streamAborted = false
  const harness = createHarness({
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
  const pending = wait(harness, { sessionId: 'session-dispose' })
  await flush()
  assert.equal(harness.calls.length, 1, 'the long poll started the generation')
  await harness.disposeAll()
  await delay(20)
  assert.equal(streamAborted, true, 'plugin disposal aborted the in-flight generation')
  assert.equal(harness.routes.size, 0, 'route unregistered on disposal')
  const settled = valueOf(await pending)
  assert.equal(settled.suggestion, null, 'the poll resolves after disposal')
  assert.equal(settled.reason, 'aborted', 'disposal reports aborted')
})
