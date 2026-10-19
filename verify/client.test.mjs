// Stub-driven Client tests: loads client.js against a fake module loader, slots, fetch,
// DOM and hook runtime. Live Harness behavior: see docs/design.md §7.3.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// ── Minimal DOM shim (document listeners + the composer-input attribute gate) ──
function createDomShim() {
  const listeners = new Map()
  class FakeElement {
    constructor(insideComposer) {
      this.insideComposer = insideComposer === true
    }

    closest(selector) {
      return selector === '[data-composer-input]' && this.insideComposer ? this : null
    }
  }
  const popups = []
  const documentShim = {
    addEventListener(type, fn, capture) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push({ fn, capture: capture === true })
    },
    removeEventListener(type, fn, capture) {
      const list = listeners.get(type)
      if (list === undefined) return
      const index = list.findIndex(entry => entry.fn === fn && entry.capture === (capture === true))
      if (index >= 0) list.splice(index, 1)
    },
    querySelector() {
      return null
    },
    querySelectorAll() {
      return popups
    },
  }
  function dispatch(type, event) {
    const list = listeners.get(type) ?? []
    for (const entry of [...list]) entry.fn(event)
  }
  function count(type) {
    return (listeners.get(type) ?? []).length
  }
  function setVisiblePopups(nodes) {
    popups.length = 0
    for (const node of nodes) popups.push(node)
  }
  return { document: documentShim, FakeElement, dispatch, count, listeners, setVisiblePopups }
}

function createKeyDownEvent(target) {
  return {
    key: 'Tab',
    code: 'Tab',
    keyCode: 9,
    isComposing: false,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    target,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true
    },
    stopPropagation() {
      this.propagationStopped = true
    },
  }
}

// ── Minimal React hook runtime (fixed-slot hook cells + dependency-aware effects) ──
// One shared "React module" object; each mounted component owns its own hook
// instance (the module routes hook calls to the instance currently rendering).
function createReactRuntime() {
  let active = null

  const runtime = {
    createElement(type, props, ...children) {
      const nextProps = {}
      if (props !== null && props !== undefined && typeof props === 'object') {
        for (const key of Object.keys(props)) nextProps[key] = props[key]
      }
      if (children.length > 0) nextProps.children = children.length === 1 ? children[0] : children
      return { type, props: nextProps, __element: true }
    },
    useRef(initial) {
      return active.useRef(initial)
    },
    useState(initial) {
      return active.useState(initial)
    },
    useEffect(effect, deps) {
      active.useEffect(effect, deps)
    },
    useLayoutEffect(effect, deps) {
      active.useEffect(effect, deps)
    },
  }

  function createInstance() {
    let cells = []
    let cursor = 0
    let effectQueue = []
    let dirty = false
    let lastElement = null

    function nextCell() {
      const index = cursor
      cursor += 1
      if (cells[index] === undefined) cells[index] = {}
      return cells[index]
    }

    const hookInstance = {
      useRef(initial) {
        const cell = nextCell()
        if (!Object.hasOwn(cell, 'ref')) cell.ref = { current: initial }
        return cell.ref
      },
      useState(initial) {
        const cell = nextCell()
        if (!Object.hasOwn(cell, 'state')) {
          cell.state = typeof initial === 'function' ? initial() : initial
        }
        const setState = (next) => {
          const value = typeof next === 'function' ? next(cell.state) : next
          if (Object.is(value, cell.state)) return
          cell.state = value
          dirty = true
        }
        return [cell.state, setState]
      },
      useEffect(effect, deps) {
        const index = cursor
        cursor += 1
        if (cells[index] === undefined) cells[index] = {}
        effectQueue.push({ index, effect, deps })
      },
    }

    function render(Component, props) {
      cursor = 0
      effectQueue = []
      dirty = false
      const previous = active
      active = hookInstance
      try {
        lastElement = Component(props)
      } finally {
        active = previous
      }
      for (const queued of effectQueue) {
        const cell = cells[queued.index]
        const sameDeps = queued.deps !== undefined && cell.deps !== undefined
          && queued.deps.length === cell.deps.length
          && queued.deps.every((value, index) => Object.is(value, cell.deps[index]))
        if (sameDeps) continue
        if (typeof cell.cleanup === 'function') {
          const cleanup = cell.cleanup
          cell.cleanup = undefined
          cleanup()
        }
        cell.deps = queued.deps
        const cleanup = queued.effect()
        cell.cleanup = typeof cleanup === 'function' ? cleanup : undefined
      }
      return lastElement
    }

    function unmount() {
      for (const cell of cells) {
        if (typeof cell.cleanup === 'function') {
          const cleanup = cell.cleanup
          cell.cleanup = undefined
          cleanup()
        }
      }
      cells = []
      cursor = 0
      lastElement = null
    }

    return {
      render,
      unmount,
      needsRender: () => dirty,
      element: () => lastElement,
    }
  }

  return { runtime, createInstance }
}

async function settle(harness, Component, props, rounds = 12) {
  let element = harness.render(Component, props)
  for (let index = 0; index < rounds; index += 1) {
    await delay(0)
    if (!harness.needsRender()) break
    element = harness.render(Component, props)
  }
  return element
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node.__element === true) {
    return textOf(node.props === undefined ? undefined : node.props.children)
  }
}

function findElement(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate)
      if (found !== null) return found
    }
    return null
  }
  if (node.__element === true && predicate(node)) return node
  return findElement(node.props === undefined ? undefined : node.props.children, predicate)
}

// ── Boot: window.__ModuleLoader__ + client.js import ─────────────────────────
const dom = createDomShim()
globalThis.document = dom.document
globalThis.Element = dom.FakeElement

let loaded = null
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: {
    load(registration) {
      if (loaded !== null) throw new Error('client.js registered the module twice')
      loaded = registration
    },
  },
}

await import('../client.js')

const reactRuntime = createReactRuntime()
let requireCalls = []
const plugin = loaded.factory(function fakeRequire(specifier) {
  requireCalls.push(specifier)
  if (specifier === 'react') return reactRuntime.runtime
  throw new Error(`unexpected client module require: ${String(specifier)}`)
})

// ── Fake Client Context ──────────────────────────────────────────────────────
const localeRegistrations = []
const slotInjections = []
const registrations = []
const effects = []

// ── Stubbed same-origin fetch (the only client transport) ───────────────────
const fetchCalls = []

function jsonResponse(body, status) {
  const code = status === undefined ? 200 : status
  return {
    ok: code >= 200 && code < 300,
    status: code,
    async json() {
      return body
    },
  }
}

function sentBody(call) {
  try {
    return JSON.parse(call.init.body)
  } catch (error) {
    return null
  }
}

function waitCallCount() {
  return fetchCalls.filter((call) => {
    const body = sentBody(call)
    return body !== null && body.endpoint === 'suggestions/wait'
  }).length
}

let fetchHandler = async () => jsonResponse({ ok: true, value: { suggestion: null, turn: null } })

async function stubFetchImplementation(url, init) {
  fetchCalls.push({ url, init })
  return fetchHandler(url, init)
}
globalThis.fetch = stubFetchImplementation

const fakeCtx = {
  effect(callback, label) {
    const disposer = callback()
    effects.push({ label, disposer })
    return { dispose() { if (typeof disposer === 'function') disposer() } }
  },
  locale: {
    register(namespace, dictionaries) {
      localeRegistrations.push({ namespace, dictionaries })
      return () => {}
    },
  },
  slots: {
    inject(name, callback) {
      slotInjections.push(name)
      return callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

// ── module registration and plugin face ──
test('ModuleLoader registration under the package id, reading only React', () => {
  assert.equal(loaded?.id, 'dsh-followup-prompt')
  assert.deepEqual(requireCalls, ['react'])
})
test('plugin face exports inject + apply', () => {
  assert.ok(plugin !== null && typeof plugin === 'object')
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  assert.equal(typeof plugin.apply, 'function')
})

// ── apply(): locale and slot registration ──
plugin.apply(fakeCtx)

test('locale dictionaries registered under the plugin namespace', () => {
  assert.equal(localeRegistrations.length, 1)
  const [{ namespace, dictionaries }] = localeRegistrations
  assert.equal(namespace, 'followup-prompt')
  assert.ok(dictionaries.en !== undefined && dictionaries.zh !== undefined)
  assert.equal(typeof dictionaries.en['meta.title'], 'string')
  assert.equal(typeof dictionaries.zh['meta.title'], 'string')
  assert.equal(typeof dictionaries.en['prediction.statusAria'], 'string')
  assert.equal(typeof dictionaries.zh['prediction.acceptHint'], 'string')
})
test('the composer input overlay slot is injected, then registered', () => {
  assert.deepEqual(slotInjections, ['conversation.input.overlay'])
  assert.equal(registrations.length, 1)
  const { options } = registrations[0]
  assert.equal(options.name, 'conversation.input.overlay')
  assert.equal(options.id, 'followup-prompt')
  assert.equal(options.locale, 'followup-prompt')
  assert.equal(typeof options.order, 'number')
  assert.ok(options.order >= 10)
  assert.equal(typeof options.inject, 'function')
  assert.equal(typeof registrations[0].component, 'function')
})
test('apply side effects ride ctx.effect lifetimes', () => {
  assert.ok(effects.length >= 2)
  assert.ok(effects.some(entry => typeof entry.label === 'string' && entry.label.includes(': dictionaries')))
})
test('keyboard capture listener installed on document', () => {
  assert.ok(dom.count('keydown') >= 1)
})

// ── Injected transport face ─────────────────────────────────────────────────
const injectedFace = registrations[0].options.inject('session-1')

// ── injected transport face (same-origin fetch, envelope unwrap, silent failure) ──

test('waitForSuggestion POSTs the exact Fetch route and unwraps the envelope value', async () => {
  fetchCalls.length = 0
  fetchHandler = async () => jsonResponse({ ok: true, value: { suggestion: '  hello world  ', turn: 7 } })
  const result = await injectedFace.waitForSuggestion({ sessionId: 'session-1' })
  assert.deepEqual(result, { suggestion: 'hello world', turn: 7 })
  assert.equal(fetchCalls.length, 1)
  const [{ url, init }] = fetchCalls
  assert.equal(url, 'api/followup-prompt/rpc')
  assert.equal(init.method, 'POST')
  assert.equal(init.credentials, 'same-origin')
  assert.deepEqual(init.headers, { 'content-type': 'application/json' })
  assert.deepEqual(JSON.parse(init.body), { endpoint: 'suggestions/wait', payload: { sessionId: 'session-1' } })
})

test('waitForSuggestion forwards the AbortSignal only when supplied', async () => {
  fetchCalls.length = 0
  fetchHandler = async () => jsonResponse({ ok: true, value: { suggestion: 'x', turn: 1 } })
  const controller = new AbortController()
  await injectedFace.waitForSuggestion({ sessionId: 'session-1' }, controller.signal)
  assert.equal(fetchCalls[0].init.signal, controller.signal)
  await injectedFace.waitForSuggestion({ sessionId: 'session-1' })
  assert.equal(fetchCalls[1].init.signal, undefined)
})

test('non-OK HTTP is silent idle (null)', async () => {
  fetchHandler = async () => jsonResponse({ error: 'unavailable' }, 503)
  assert.equal(await injectedFace.waitForSuggestion({ sessionId: 'session-1' }), null)
})

test('thrown fetch / abort is silent idle (null)', async () => {
  fetchHandler = async () => {
    throw new Error('network error')
  }
  assert.equal(await injectedFace.waitForSuggestion({ sessionId: 'session-1' }), null)
  fetchHandler = async () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    throw abort
  }
  assert.equal(await injectedFace.waitForSuggestion({ sessionId: 'session-1' }), null)
})

test('malformed JSON is silent idle (null)', async () => {
  fetchHandler = async () => ({
    ok: true,
    status: 200,
    async json() {
      throw new SyntaxError('unexpected end of JSON input')
    },
  })
  assert.equal(await injectedFace.waitForSuggestion({ sessionId: 'session-1' }), null)
})

test('{ok:false} envelope is silent idle (null)', async () => {
  fetchHandler = async () => jsonResponse({ ok: false, error: { code: 'busy', message: 'busy', details: {} } })
  assert.equal(await injectedFace.waitForSuggestion({ sessionId: 'session-1' }), null)
})

test('missing global fetch is silent idle (null)', async () => {
  delete globalThis.fetch
  assert.equal(await injectedFace.waitForSuggestion({ sessionId: 'session-1' }), null)
  globalThis.fetch = stubFetchImplementation
})

test('null/empty suggestion and reason-only values are silent idle', async () => {
  fetchHandler = async () => jsonResponse({ ok: true, value: { suggestion: null, turn: null, reason: 'no-completed-turn' } })
  assert.equal(await injectedFace.waitForSuggestion({ sessionId: 'session-1' }), null)
  fetchHandler = async () => jsonResponse({ ok: true, value: { suggestion: '   ', turn: 3 } })
  assert.equal(await injectedFace.waitForSuggestion({ sessionId: 'session-1' }), null)
})

test('dismissSuggestion POSTs suggestions/dismiss fire-and-forget', async () => {
  fetchCalls.length = 0
  fetchHandler = async () => jsonResponse({ ok: true, value: { ok: true } })
  const returned = injectedFace.dismissSuggestion({ sessionId: 'session-1', turn: 7 })
  assert.equal(fetchCalls.length, 1)
  const [{ url, init }] = fetchCalls
  assert.equal(url, 'api/followup-prompt/rpc')
  assert.equal(init.method, 'POST')
  assert.deepEqual(JSON.parse(init.body), { endpoint: 'suggestions/dismiss', payload: { sessionId: 'session-1', turn: 7 } })
  if (returned !== undefined && typeof returned.then === 'function') await returned
})

test('dismiss transport failure is swallowed', async () => {
  fetchHandler = async () => {
    throw new Error('network error')
  }
  const returned = injectedFace.dismissSuggestion({ sessionId: 'session-1' })
  if (returned !== undefined && typeof returned.then === 'function') await returned
})

// ── Component rendering + keyboard path ─────────────────────────────────────
function makeComponentState(overrides) {
  return {
    session: Object.assign({
      running: false,
      blank: false,
      awaitingFirstTurn: false,
      promptAttempted: true,
    }, overrides === undefined ? {} : overrides.session),
    input: Object.assign({
      draft: '',
      phase: 'plain',
      attachmentIds: [],
    }, overrides === undefined ? {} : overrides.input),
  }
}

function makeInputActions(options) {
  const config = options === undefined ? {} : options
  const calls = {
    captureInsertion: 0,
    insertText: [],
    setDraft: [],
    submit: 0,
  }
  return {
    calls,
    actions: {
      captureInsertion() {
        calls.captureInsertion += 1
        return { start: 0, end: 0, draftRev: 4 }
      },
      insertText(text, span) {
        calls.insertText.push({ text, span })
        return config.insertTextResult !== false
      },
      setDraft(text) {
        calls.setDraft.push(text)
      },
      submit() {
        calls.submit += 1
      },
    },
  }
}

function makeComponentProps(state, face, actions, translate) {
  const componentHarness = reactRuntime.createInstance()
  const props = Object.assign({}, injectedFace, {
    sessionId: 'session-1',
    useSession: selector => selector(state.session),
    useInput: selector => selector(state.input),
    inputActions: actions.actions,
    t: translate === undefined ? key => `t:${key}` : translate,
    waitForSuggestion: face.waitForSuggestion,
    dismissSuggestion: face.dismissSuggestion,
  })
  return { componentHarness, props }
}

function dispatchTab(target, key) {
  const event = createKeyDownEvent(target)
  event.key = key === undefined ? 'Tab' : key
  dom.dispatch('keydown', event)
  return event
}

const defaultRpc = {
  waitForSuggestion: injectedFace.waitForSuggestion,
  dismissSuggestion: injectedFace.dismissSuggestion,
}

// ── component state machine and Tab accept (fake hook runtime) ──

test('idle edge requests once and mounts the inline ghost', async () => {
  fetchCalls.length = 0
  fetchHandler = async () => jsonResponse({ ok: true, value: { suggestion: 'hello there', turn: 7 } })
  const state = makeComponentState()
  const actions = makeInputActions()
  const { componentHarness, props } = makeComponentProps(state, defaultRpc, actions)
  const element = await settle(componentHarness, registrations[0].component, props)
  assert.notEqual(element, null)
  assert.equal(element.type, 'div')
  assert.equal(element.props.role, 'status')
  assert.equal(element.props['aria-live'], 'polite')
  assert.equal(element.props['data-followup-prompt'], '')
  assert.equal(element.props.style.position, 'absolute')
  assert.equal(element.props.style.pointerEvents, 'none')
  assert.ok(Number(element.props.style.zIndex) >= 1)
  assert.ok(textOf(element).includes('hello there'))
  assert.ok(textOf(element).includes('Tab'))
  assert.ok(textOf(element).includes('t:prediction.acceptHint'))
  assert.equal(waitCallCount(), 1)
  assert.equal(actions.calls.captureInsertion, 0)
  assert.equal(actions.calls.submit, 0)
  componentHarness.unmount()
})

test('Tab inside the composer accepts into the draft and never sends', async () => {
  fetchCalls.length = 0
  fetchHandler = async () => jsonResponse({ ok: true, value: { suggestion: 'hello there', turn: 7 } })
  const state = makeComponentState()
  const actions = makeInputActions()
  const face = {
    waitForSuggestion: injectedFace.waitForSuggestion,
    dismissSuggestion: injectedFace.dismissSuggestion,
  }
  face.dismissSuggestion = payload => {
    face.dismissPayload = payload
    return Promise.resolve()
  }
  const { componentHarness, props } = makeComponentProps(state, face, actions)
  let element = await settle(componentHarness, registrations[0].component, props)
  assert.notEqual(element, null)
  const event = dispatchTab(new dom.FakeElement(true))
  assert.equal(event.defaultPrevented, true)
  assert.equal(event.propagationStopped, true)
  assert.equal(actions.calls.captureInsertion, 1)
  assert.deepEqual(actions.calls.insertText, [{ text: 'hello there', span: { start: 0, end: 0, draftRev: 4 } }])
  assert.deepEqual(actions.calls.setDraft, [])
  assert.equal(actions.calls.submit, 0)
  assert.deepEqual(face.dismissPayload, { sessionId: 'session-1', turn: 7 })
  // The ghost clears after accepting.
  element = await settle(componentHarness, registrations[0].component, props)
  assert.equal(element, null)
  componentHarness.unmount()
})

test('Tab outside the composer input is let through', async () => {
  fetchCalls.length = 0
  fetchHandler = async () => jsonResponse({ ok: true, value: { suggestion: 'hello there', turn: 7 } })
  const state = makeComponentState()
  const actions = makeInputActions()
  const { componentHarness, props } = makeComponentProps(state, defaultRpc, actions)
  assert.notEqual(await settle(componentHarness, registrations[0].component, props), null)
  const event = dispatchTab(new dom.FakeElement(false))
  assert.equal(event.defaultPrevented, false)
  assert.equal(actions.calls.insertText.length, 0)
  componentHarness.unmount()
})

test('non-empty draft: no request, nothing rendered, Tab passes', async () => {
  fetchCalls.length = 0
  fetchHandler = async () => jsonResponse({ ok: true, value: { suggestion: 'hello there', turn: 7 } })
  const state = makeComponentState({ input: { draft: 'typed by the user' } })
  const actions = makeInputActions()
  const { componentHarness, props } = makeComponentProps(state, defaultRpc, actions)
  assert.equal(await settle(componentHarness, registrations[0].component, props), null)
  assert.equal(waitCallCount(), 0)
  const event = dispatchTab(new dom.FakeElement(true))
  assert.equal(event.defaultPrevented, false)
  assert.equal(actions.calls.insertText.length, 0)
  componentHarness.unmount()
})

test('blank / awaiting-first-turn sessions never request', async () => {
  fetchCalls.length = 0
  fetchHandler = async () => jsonResponse({ ok: true, value: { suggestion: 'hello there', turn: 7 } })
  for (const flags of [{ blank: true }, { awaitingFirstTurn: true }, { running: true }]) {
    const state = makeComponentState({ session: flags })
    const actions = makeInputActions()
    const { componentHarness, props } = makeComponentProps(state, defaultRpc, actions)
    assert.equal(await settle(componentHarness, registrations[0].component, props), null)
    componentHarness.unmount()
  }
  assert.equal(waitCallCount(), 0)
})

test('failed suggestion request stays silent', async () => {
  fetchCalls.length = 0
  fetchHandler = async () => {
    throw new Error('network error')
  }
  const state = makeComponentState()
  const actions = makeInputActions()
  const { componentHarness, props } = makeComponentProps(state, defaultRpc, actions)
  assert.equal(await settle(componentHarness, registrations[0].component, props), null)
  componentHarness.unmount()
})

test('insertText returning false: Tab is not consumed and nothing is dismissed', async () => {
  fetchCalls.length = 0
  fetchHandler = async () => jsonResponse({ ok: true, value: { suggestion: 'hello there', turn: 7 } })
  const state = makeComponentState()
  const actions = makeInputActions({ insertTextResult: false })
  const dismissCalls = []
  const { componentHarness, props } = makeComponentProps(state, {
    waitForSuggestion: injectedFace.waitForSuggestion,
    dismissSuggestion: payload => {
      dismissCalls.push(payload)
      return Promise.resolve()
    },
  }, actions)
  const element = await settle(componentHarness, registrations[0].component, props)
  assert.notEqual(element, null)
  const event = dispatchTab(new dom.FakeElement(true))
  assert.equal(event.defaultPrevented, false)
  assert.equal(dismissCalls.length, 0)
  assert.deepEqual(actions.calls.setDraft, [])
  componentHarness.unmount()
})

test('running true hides and a later idle edge asks again', async () => {
  fetchCalls.length = 0
  fetchHandler = async () => jsonResponse({ ok: true, value: { suggestion: 'hello there', turn: 7 } })
  const state = makeComponentState()
  const actions = makeInputActions()
  const { componentHarness, props } = makeComponentProps(state, defaultRpc, actions)
  let element = await settle(componentHarness, registrations[0].component, props)
  assert.notEqual(element, null)
  state.session.running = true
  element = await settle(componentHarness, registrations[0].component, props)
  assert.equal(element, null)
  const before = waitCallCount()
  state.session.running = false
  element = await settle(componentHarness, registrations[0].component, props)
  assert.notEqual(element, null)
  const after = waitCallCount()
  assert.equal(after, before + 1)
  componentHarness.unmount()
})

test('switching sessions drops the old ghost and asks for the new session', async () => {
  fetchCalls.length = 0
  fetchHandler = async (url, init) => {
    const { payload } = JSON.parse(init.body)
    return jsonResponse({ ok: true, value: { suggestion: `for ${payload.sessionId}`, turn: 1 } })
  }
  const state = makeComponentState()
  const actions = makeInputActions()
  const { componentHarness, props } = makeComponentProps(state, defaultRpc, actions)
  assert.ok(textOf(await settle(componentHarness, registrations[0].component, props)).includes('for session-1'))
  props.sessionId = 'session-2'
  const element = await settle(componentHarness, registrations[0].component, props)
  assert.ok(textOf(element).includes('for session-2'))
  assert.equal(waitCallCount(), 2)
  componentHarness.unmount()
})

test('draft typing hides; clearing the draft re-shows from cache without a new RPC', async () => {
  fetchCalls.length = 0
  fetchHandler = async () => jsonResponse({ ok: true, value: { suggestion: 'hello there', turn: 7 } })
  const state = makeComponentState()
  const actions = makeInputActions()
  const { componentHarness, props } = makeComponentProps(state, defaultRpc, actions)
  assert.notEqual(await settle(componentHarness, registrations[0].component, props), null)
  const requestsAfterMount = waitCallCount()
  state.input.draft = 'typing…'
  assert.equal(await settle(componentHarness, registrations[0].component, props), null)
  state.input.draft = ''
  assert.notEqual(await settle(componentHarness, registrations[0].component, props), null)
  const requestsAfterRestore = waitCallCount()
  assert.equal(requestsAfterRestore, requestsAfterMount)
  componentHarness.unmount()
})

test('IME composition hides the bar and shows it again after the grace period', async () => {
  fetchCalls.length = 0
  fetchHandler = async () => jsonResponse({ ok: true, value: { suggestion: 'hello there', turn: 7 } })
  const state = makeComponentState()
  const actions = makeInputActions()
  const { componentHarness, props } = makeComponentProps(state, defaultRpc, actions)
  assert.notEqual(await settle(componentHarness, registrations[0].component, props), null)
  const composerTarget = new dom.FakeElement(true)
  dom.dispatch('compositionstart', { target: composerTarget })
  assert.equal(await settle(componentHarness, registrations[0].component, props), null)
  dom.dispatch('compositionend', { target: composerTarget })
  await delay(25)
  assert.notEqual(await settle(componentHarness, registrations[0].component, props), null)
  componentHarness.unmount()
})

test('close button dismisses and clears the bar', async () => {
  fetchCalls.length = 0
  fetchHandler = async () => jsonResponse({ ok: true, value: { suggestion: 'hello there', turn: 7 } })
  const state = makeComponentState()
  const actions = makeInputActions()
  const dismissCalls = []
  const { componentHarness, props } = makeComponentProps(state, {
    waitForSuggestion: injectedFace.waitForSuggestion,
    dismissSuggestion: payload => {
      dismissCalls.push(payload)
      return Promise.resolve()
    },
  }, actions)
  let element = await settle(componentHarness, registrations[0].component, props)
  assert.notEqual(element, null)
  const closeButton = findElement(element, node => node.type === 'button' && node.props.className === 'fup-close')
  assert.notEqual(closeButton, null)
  const clickEvent = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
  closeButton.props.onClick(clickEvent)
  assert.equal(clickEvent.defaultPrevented, true)
  assert.deepEqual(dismissCalls, [{ sessionId: 'session-1', turn: 7 }])
  assert.equal(actions.calls.submit, 0)
  element = await settle(componentHarness, registrations[0].component, props)
  assert.equal(element, null)
  componentHarness.unmount()
})

test('Escape closes the bar through the capture listener', async () => {
  fetchCalls.length = 0
  fetchHandler = async () => jsonResponse({ ok: true, value: { suggestion: 'hello there', turn: 7 } })
  const state = makeComponentState()
  const actions = makeInputActions()
  const { componentHarness, props } = makeComponentProps(state, defaultRpc, actions)
  assert.notEqual(await settle(componentHarness, registrations[0].component, props), null)
  const event = dispatchTab(new dom.FakeElement(true), 'Escape')
  assert.equal(event.defaultPrevented, true)
  const element = await settle(componentHarness, registrations[0].component, props)
  assert.equal(element, null)
  componentHarness.unmount()
})

test('an open command menu keeps Tab for itself', async () => {
  fetchCalls.length = 0
  fetchHandler = async () => jsonResponse({ ok: true, value: { suggestion: 'hello there', turn: 7 } })
  const state = makeComponentState()
  const actions = makeInputActions()
  const { componentHarness, props } = makeComponentProps(state, defaultRpc, actions)
  assert.notEqual(await settle(componentHarness, registrations[0].component, props), null)
  dom.setVisiblePopups([{ getClientRects: () => [{ width: 1 }] }])
  const event = dispatchTab(new dom.FakeElement(true))
  assert.equal(event.defaultPrevented, false)
  assert.equal(actions.calls.insertText.length, 0)
  // A hidden (mounted, no client rects) menu does not gate the gesture.
  dom.setVisiblePopups([{ getClientRects: () => [] }])
  const accepted = dispatchTab(new dom.FakeElement(true))
  assert.equal(accepted.defaultPrevented, true)
  assert.equal(actions.calls.insertText.length, 1)
  dom.setVisiblePopups([])
  componentHarness.unmount()
})

// ── client source contract guards ──
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
test('never calls a submission entry point', () => {
  assert.ok(!/\.submit\s*\(/.test(source))
  assert.ok(!/\bsubmit\s*\(/.test(source))
})
test('does not mutate the editor DOM', () => {
  assert.ok(!/['"]contentEditable['"]\s*:/.test(source))
  assert.ok(!/insertAdjacentHTML|innerHTML\s*=/.test(source))
  assert.ok(!/\.setAttribute\s*\(/.test(source))
})
test('only shipped theme alias tokens are referenced', () => {
  const allowed = new Set([
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-overlay',
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-alias-brand-primary',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-idle-primary',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-warn-primary',
    '--dsw-specific-sidebar-fill',
  ])
  const used = new Set([...source.matchAll(/--dsw-[a-z0-9-]+/gi)].map(match => match[0]))
  const unknown = [...used].filter(token => !allowed.has(token) && !token.startsWith('--dsw-radius-'))
  assert.deepEqual(unknown, [])
  assert.ok(used.has('--dsw-alias-bg-layer-1'))
  assert.ok(used.has('--dsw-alias-border-l1'))
})
