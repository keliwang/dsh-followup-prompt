// Stub-driven Host tests: drives the real Host modules with a fake ctx, session store,
// Fetch-route registry and `ctx.llm.stream`. Live Harness behavior is not covered.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, Config, name, inject } from '../host/index.js'
import { CONFIG_KEYS, DEFAULTS, FIELDS, resolveConfig } from '../host/config.js'
import { isSampledOut } from '../host/cache.js'
import { isSubagentSession, latestCompletedTurn } from '../host/session.js'
import {
  buildPredictionPairs,
  buildRequestMessages,
  FOLLOWUP_INSTRUCTION,
  PREDICTION_CUE,
  PREDICTION_REASONS,
  normalizeSuggestion,
} from '../host/prediction.js'
import {
  DEFAULT_WAIT_MS,
  ERROR_BAD_ENDPOINT,
  ERROR_BAD_REQUEST,
  MAX_WAIT_MS,
  ROUTE,
} from '../host/channel.js'

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

async function* textChunks(text, usage) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  if (usage !== undefined) yield { type: 'usage', usage }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function* toolCallChunks(calls, usage) {
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments }
    yield { type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments } }
  }
  if (usage !== undefined) yield { type: 'usage', usage }
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
  const userDefaults = Object.fromEntries(CONFIG_KEYS.map((key) => [key, DEFAULTS[key]]))
  const validated = standard.validate(userDefaults)
  assert(validated.issues === undefined, `Config rejected the documented defaults: ${JSON.stringify(validated.issues)}`)
})

test('config: schema exposes only user fields; resolver covers every field', () => {
  assert.deepEqual(CONFIG_KEYS, Object.keys(FIELDS).filter((key) => !FIELDS[key].internal), 'user-facing keys')
  assert.equal(CONFIG_KEYS.length, 9, 'user-facing field count')
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
    enabled: volatile(false),
    provider: volatile('  cheap-provider  '),
    model: volatile('cheap-model'),
    reasoningEffort: volatile('turbo'),
    maxTokens: volatile(0),
    timeoutMs: volatile(99999),
    maxTurns: volatile(-4),
    maxSuggestionChars: volatile(1.9),
    sampleRate: volatile(5),
    maxConcurrent: volatile(0),
    cacheTtlMs: volatile(1),
    prompt: volatile('  Predict it.  '),
  })
  assert.equal(live.enabled, false, 'volatile enabled')
  assert.equal(live.provider, 'cheap-provider', 'volatile provider trimmed')
  assert.equal(live.model, 'cheap-model', 'volatile model')
  assert.equal(live.reasoningEffort, DEFAULTS.reasoningEffort, 'invalid reasoning effort falls back')
  assert.equal(live.maxTokens, FIELDS.maxTokens.range[0], 'maxTokens clamped up')
  assert.equal(live.timeoutMs, FIELDS.timeoutMs.range[1], 'timeoutMs capped at 30s')
  assert.equal(live.maxTurns, 0, 'maxTurns clamped')
  assert.equal(live.maxSuggestionChars, 1, 'maxSuggestionChars truncated')
  assert.equal(live.sampleRate, 1, 'sampleRate capped')
  assert.equal(live.maxConcurrent, FIELDS.maxConcurrent.range[0], 'maxConcurrent clamped up')
  assert.equal(live.cacheTtlMs, FIELDS.cacheTtlMs.range[0], 'cacheTtlMs clamped up')
  assert.equal(live.prompt, 'Predict it.', 'prompt trimmed')

  const halfRoute = resolveConfig({ provider: 'only-provider' })
  assert.equal(halfRoute.provider, '', 'half-configured route: provider cleared')
  assert.equal(halfRoute.model, '', 'half-configured route: model cleared')
  assert.equal(resolveConfig({ timeoutMs: 1000 }).timeoutMs, 2000, 'timeout floor is 2s')
  assert.equal(resolveConfig({ reasoningEffort: 'low' }).reasoningEffort, 'low', 'valid reasoning effort kept')
})

test('prediction helpers: suggestion normalization and safety filters', () => {
  const config = resolveConfig({})
  assert.equal(normalizeSuggestion('```\nRun the tests\n```', config), 'Run the tests', 'markdown fence stripped')
  assert.equal(normalizeSuggestion('"thanks"', config), 'thanks', 'double quotes stripped')
  assert.equal(normalizeSuggestion('`continue`', config), 'continue', 'backticks stripped')
  assert.equal(normalizeSuggestion('NO_PREDICTION', config), null, 'sentinel dropped')
  assert.equal(normalizeSuggestion('   ', config), null, 'empty dropped')
  assert.equal(normalizeSuggestion('bad\u0007bell', config), null, 'control character dropped')
  assert.equal(normalizeSuggestion('key sk-abcdefghijklmnopqrst', config), null, 'secret-shaped token dropped')
  const truncated = normalizeSuggestion('x'.repeat(500), config)
  assert.equal(truncated.length, config.maxSuggestionChars, 'suggestion truncated to maxSuggestionChars')
  assert(FOLLOWUP_INSTRUCTION.includes('NO_PREDICTION'), 'instruction sentinel present')
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
  const pairs = buildPredictionPairs(session, resolveConfig({}))
  assert.deepEqual(pairs.map((pair) => pair.user), ['Fix the bug in a.js', 'Run the tests'], 'one pair per human turn')
  assert.deepEqual(
    pairs.map((pair) => pair.assistant),
    ['I fixed the guard. The tests pass now.', 'Done.'],
    'assistant side keeps the full visible reply text',
  )
  assert.equal(JSON.stringify(pairs).includes('secret thinking'), false, 'thinking blocks are dropped')
  const request = buildRequestMessages(session, resolveConfig({}), 'p', 'm')
  assert(request !== null, 'condensed request built')
  assert.deepEqual(
    request.messages.map((message) => message.role),
    ['user', 'assistant', 'user', 'assistant', 'user'],
    'pairs then the closing cue',
  )
  assert.equal(request.messages[3].content[0].text, 'Done.', 'assistant side carries the reply text')
  assert.equal(request.messages.at(-1).content[0].text, PREDICTION_CUE, 'cue closes the transcript')
})

test('prediction: one more turn appends one pair to the same prefix', () => {
  const pair = (index) => [
    { id: `q-u${index}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `question ${index}` }] },
    { id: `q-a${index}`, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: `answer ${index}.` }] },
  ]
  const shape = (session) => buildRequestMessages(session, resolveConfig({}), 'p', 'm').messages
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
  const pairs = buildPredictionPairs(session, resolveConfig({}))
  assert.equal(pairs.length, 1, 'injected user context is not a turn boundary')
  assert.equal(pairs[0].assistant, 'hi there.\n\nsecond answer.', 'assistant text accumulates across the turn')
})

test('prediction: maxTurns caps the condensed transcript', () => {
  const messages = []
  for (let index = 1; index <= 3; index += 1) {
    messages.push({ id: `c-u${index}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `question ${index}` }] })
    messages.push({ id: `c-a${index}`, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: `answer ${index}.` }] })
  }
  const { session } = createSession('cap', { messages })
  const pairs = buildPredictionPairs(session, resolveConfig({ maxTurns: 2 }))
  assert.deepEqual(pairs.map((pair) => pair.user), ['question 2', 'question 3'], 'only the most recent pairs are kept')
})

test('prediction: a session without a complete pair answers no-route', () => {
  const { session } = createSession('pairs-empty', {
    messages: [
      { id: 'e-s', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'sys' }] },
      { id: 'e-u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] },
    ],
  })
  assert.equal(buildRequestMessages(session, resolveConfig({})), null, 'no assistant text means no pair')
})

test('request: the configured prompt is sent as the system prompt', async () => {
  const harness = createHarness({ config: { ...DEFAULTS, prompt: '  Predict the next message.  ' } })
  try {
    const { session, events } = createSession('session-system-prompt')
    harness.addSession(session)
    seedCompletedTurn(harness, session, events, 1)
    valueOf(await wait(harness, { sessionId: 'session-system-prompt', waitMs: 2000 }))
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
    const value = valueOf(await wait(harness, { sessionId: 'session-long-agentic', waitMs: 2000 }))
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
  const harness = createHarness({ config: { ...DEFAULTS, enabled: false } })
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
  assert.equal(isSampledOut('same-session', 3, 1), false, 'sampleRate 1 never samples out')
  assert.equal(isSampledOut('same-session', 3, 0), true, 'sampleRate 0 always samples out')
  assert.equal(
    isSampledOut('same-session', 3, 0.5),
    isSampledOut('same-session', 3, 0.5),
    'sampling is deterministic per (session, turn)',
  )
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
    assert.equal(DEFAULT_WAIT_MS, 12000, 'default wait budget')
    assert.equal(MAX_WAIT_MS, 15000, 'maximum wait budget')
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
    assert.equal(harness.calls.length, 0, 'prefetch off: no model call on turn/end')
    const eventCountBefore = events.length

    const first = valueOf(await wait(harness, { sessionId: 'session-lazy', waitMs: 1000 }))
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

    const second = valueOf(await wait(harness, { sessionId: 'session-lazy', waitMs: 1000 }))
    assert.equal(second.suggestion, DEFAULT_SUGGESTION, 'cached wait returns the suggestion')
    assert.equal(second.turn, 1, 'cached wait reports the turn')
    assert.equal(harness.calls.length, 1, 'cached wait makes no second model call')
  } finally {
    await harness.disposeAll()
  }
})

test('request: adapter-materialized defaults are deleted then policy-applied', async () => {
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
    const value = valueOf(await wait(harness, { sessionId: 'session-adapter', waitMs: 1000 }))
    assert.equal(value.suggestion, DEFAULT_SUGGESTION, 'suggestion produced')
    const request = harness.calls[0]
    assert.equal(request.reasoningEffort, 'low', 'configured reasoning effort overrides the deleted adapter default')
    assert.equal(request.maxTokens, 96, 'configured output cap overrides the deleted adapter default')
    assert.equal(request.temperature, 0.1, 'unflagged controls survive')
  } finally {
    await harness.disposeAll()
  }
})

// ── Cache, dismiss, TTL, sampling, disabled ──────────────────────────────
test('dismiss: the turn is no longer served (stale), idempotently', async () => {
  const harness = createHarness()
  try {
    const { session, events } = createSession('session-dismiss')
    harness.addSession(session)
    seedCompletedTurn(harness, session, events, 2)
    valueOf(await wait(harness, { sessionId: 'session-dismiss', waitMs: 1000 }))
    assert.equal(harness.calls.length, 1, 'initial generation')

    const dismissed = valueOf(await dismiss(harness, { sessionId: 'session-dismiss', turn: 2 }))
    assert.deepEqual(dismissed, { ok: true }, 'dismiss result')
    valueOf(await dismiss(harness, { sessionId: 'session-dismiss', turn: 2 }))
    valueOf(await dismiss(harness, { sessionId: 'unknown-session' }))

    const after = valueOf(await wait(harness, { sessionId: 'session-dismiss', waitMs: 1000 }))
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
    valueOf(await wait(harness, { sessionId: 'session-invalidate', waitMs: 1000 }))
    appendEvent(harness, session, events, { type: 'turn/start', data: { turn: 2 } })
    const afterStart = valueOf(await wait(harness, { sessionId: 'session-invalidate', waitMs: 200 }))
    assert.equal(afterStart.suggestion, null, 'entry dropped on turn/start')
    assert.equal(afterStart.reason, 'no-completed-turn', 'open turn resolves as no completed turn')
    harness.sessions.delete(session.id)
    harness.emitDisposed(session)
    const afterDispose = valueOf(await wait(harness, { sessionId: 'session-invalidate', waitMs: 200 }))
    assert.equal(afterDispose.reason, 'unknown-session', 'disposed session state removed')
  } finally {
    await harness.disposeAll()
  }
})

test('cache: deterministic sampling answers sampled-out without a model call', async () => {
  const harness = createHarness({ config: { ...DEFAULTS, sampleRate: 0 } })
  try {
    const { session, events } = createSession('session-sampled')
    harness.addSession(session)
    seedCompletedTurn(harness, session, events, 1)
    const value = valueOf(await wait(harness, { sessionId: 'session-sampled', waitMs: 500 }))
    assert.equal(value.suggestion, null, 'sampled-out has no suggestion')
    assert.equal(value.reason, 'sampled-out', 'sampled-out reason')
    assert.equal(harness.calls.length, 0, 'sampled-out makes no model call')
  } finally {
    await harness.disposeAll()
  }
})

test('cache: disabled switch answers without touching the model', async () => {
  const harness = createHarness({ config: { ...DEFAULTS, enabled: false } })
  try {
    const { session, events } = createSession('session-disabled')
    harness.addSession(session)
    seedCompletedTurn(harness, session, events, 1)
    const value = valueOf(await wait(harness, { sessionId: 'session-disabled', waitMs: 200 }))
    assert.equal(value.suggestion, null, 'disabled has no suggestion')
    assert.equal(value.reason, 'disabled', 'disabled reason')
    assert.equal(harness.calls.length, 0, 'disabled makes no model call')
  } finally {
    await harness.disposeAll()
  }
})

test('cache: TTL sweep expires entries (and aborts running work)', async () => {
  const harness = createHarness({ config: { ...DEFAULTS, cacheTtlMs: 1000 } })
  try {
    const { session, events } = createSession('session-ttl')
    harness.addSession(session)
    seedCompletedTurn(harness, session, events, 1)
    valueOf(await wait(harness, { sessionId: 'session-ttl', waitMs: 1000 }))
    assert.equal(harness.calls.length, 1, 'entry populated')
    // A second wait at a TTL-expired clock still serves the cached value...
    const before = valueOf(await wait(harness, { sessionId: 'session-ttl', waitMs: 200 }))
    assert.equal(before.suggestion, DEFAULT_SUGGESTION, 'cache hit before TTL')
    // ...but a fresh wait after expiry regenerates instead of serving the old result.
    await delay(1100)
    valueOf(await wait(harness, { sessionId: 'session-ttl', waitMs: 1000 }))
    assert.equal(harness.calls.length, 2, 'expired entry regenerated')
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
    const unknown = valueOf(await wait(harness, { sessionId: 'missing-session', waitMs: 200 }))
    assert.equal(unknown.suggestion, null, 'unknown session has no suggestion')
    assert.equal(unknown.turn, null, 'unknown session has no turn')
    assert.equal(unknown.reason, 'unknown-session', 'unknown session reason')

    const open = createSession('session-open')
    harness.addSession(open.session)
    appendEvent(harness, open.session, open.events, { type: 'turn/start', data: { turn: 4 } })
    const noTurn = valueOf(await wait(harness, { sessionId: 'session-open', waitMs: 200 }))
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
      toolHistory: () => ({ tools: [], updates: [] }),
      snapshotEvents: () => [...events],
    }
    harness.addSession(session)
    seedCompletedTurn(harness, session, events, 1)
    const first = valueOf(await wait(harness, { sessionId: 'session-no-route', waitMs: 500 }))
    assert.equal(first.suggestion, null, 'missing header: no suggestion')
    assert.equal(first.reason, PREDICTION_REASONS.noRoute, 'missing header reason')
    assert.equal(harness.calls.length, 0, 'missing header makes no model call')
    // A later request header (e.g. the session finished restoring) makes the
    // same turn retryable: no-route is not a cached terminal result.
    header = { config: { provider: 'fake-provider', model: 'fake-model' } }
    const retried = valueOf(await wait(harness, { sessionId: 'session-no-route', waitMs: 1000 }))
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
    const value = valueOf(await wait(harness, { sessionId: 'session-subagent', waitMs: 200 }))
    assert.equal(value.suggestion, null, 'subagent session has no suggestion')
    assert.equal(value.reason, 'unknown-session', 'subagent session is invisible')
    assert.equal(harness.calls.length, 0, 'subagent session makes no model call')
  } finally {
    await harness.disposeAll()
  }
})

test('timeout: a slow generation survives waitMs and serves a later poll', async () => {
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
    const timedOut = valueOf(await wait(harness, { sessionId: 'session-slow', waitMs: 50 }))
    assert.equal(timedOut.reason, 'timeout', 'the poll times out')
    assert.equal(harness.calls.length, 1, 'one generation started')
    release()
    await flush()
    await delay(20)
    const later = valueOf(await wait(harness, {
      sessionId: 'session-slow', waitMs: 2000,
    }))
    assert.equal(later.suggestion, 'Slow suggestion', 'a later poll observes the cached result')
    assert.equal(harness.calls.length, 1, 'no second model call')
  } finally {
    await harness.disposeAll()
  }
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
    const value = valueOf(await wait(harness, { sessionId: 'session-deadline', waitMs: 5000 }))
    assert.equal(value.suggestion, null, 'no suggestion after the deadline')
    assert.equal(value.reason, PREDICTION_REASONS.timeout, 'deadline reported as timeout, not aborted')
  } finally {
    await harness.disposeAll()
  }
})

// ── Concurrency, abort, prefetch ─────────────────────────────────────────
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
    const first = wait(harness, { sessionId: 'session-shared', waitMs: 2000 })
    await flush()
    const second = wait(harness, { sessionId: 'session-shared', waitMs: 2000 })
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

test('concurrency: maxConcurrent answers busy instead of queueing', async () => {
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

    const running = wait(harness, { sessionId: 'session-busy-1', waitMs: 2000 })
    await flush()
    const busy = valueOf(await wait(harness, { sessionId: 'session-busy-2', waitMs: 200 }))
    assert.equal(busy.suggestion, null, 'busy has no suggestion')
    assert.equal(busy.reason, 'busy', 'busy reason')
    assert.equal(harness.calls.length, 1, 'busy session never dispatched')
    release()
    assert.equal(valueOf(await running).suggestion, 'First session', 'first session completes')
    const retried = valueOf(await wait(harness, { sessionId: 'session-busy-2', waitMs: 1000 }))
    assert.equal(retried.suggestion, 'Second session', 'busy is not a cached terminal result')
    assert.equal(harness.calls.length, 2, 'the busy session retried once a slot was free')
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
    const pending = wait(harness, { sessionId: 'session-abort', waitMs: 5000 }, controller.signal)
    await flush()
    assert.equal(harness.calls.length, 1, 'generation started')
    controller.abort()
    const aborted = valueOf(await pending)
    assert.equal(aborted.suggestion, null, 'aborted wait has no suggestion')
    assert.equal(aborted.reason, 'aborted', 'aborted reason')
    await flush()
    await delay(20)
    const retried = valueOf(await wait(harness, { sessionId: 'session-abort', waitMs: 1000 }))
    assert.equal(retried.suggestion, 'Recovered', 'a later wait can regenerate the turn')
    assert.equal(harness.calls.length, 2, 'cancelled generation was not cached')
  } finally {
    await harness.disposeAll()
  }
})

test('prefetch: turn/end(completed) pre-generates exactly once', async () => {
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
    assert.equal(harness.calls.length, 1, 'exactly one prefetch generation')
    const value = valueOf(await wait(harness, { sessionId: 'session-prefetch', waitMs: 1000 }))
    assert.equal(value.suggestion, 'Prefetched suggestion', 'prefetched suggestion served')
    assert.equal(harness.calls.length, 1, 'wait reuses the prefetched result')

    appendEvent(harness, session, events, { type: 'turn/start', data: { turn: 2 } })
    await flush()
    const openTurn = valueOf(await wait(harness, { sessionId: 'session-prefetch', waitMs: 200 }))
    assert.equal(openTurn.reason, 'no-completed-turn', 'a new turn obsoletes the old suggestion')
  } finally {
    await harness.disposeAll()
  }
})

test('prefetch: non-completed turn endings never generate', async () => {
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
    assert.equal(harness.calls.length, 0, 'aborted turn is not predicted for')
  } finally {
    await harness.disposeAll()
  }
})

test('lifecycle: disposal aborts in-flight work and unregisters the route', async () => {
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
  assert.equal(harness.calls.length, 1, 'prefetch generation started')
  await harness.disposeAll()
  await delay(20)
  assert.equal(streamAborted, true, 'plugin disposal aborted the in-flight generation')
  assert.equal(harness.routes.size, 0, 'route unregistered on disposal')
})
