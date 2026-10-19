#!/usr/bin/env node
/**
 * Offline stub-driven smoke test for the Followup Prompt Client half.
 *
 * The browser artifact is a side-effect classic script: it registers a lazy
 * factory into `window.__ModuleLoader__`. This test provides that global, then
 * imports `../client.js` (the package is `"type": "module"`, so the import
 * executes the file as an ESM module whose only top-level effect is the
 * registration), materializes the factory against a minimal React shim, and
 * drives the plugin through a fake Client Context:
 *
 *   - module id / inject array / apply face;
 *   - locale dictionary registration (en + zh, meta.title present);
 *   - `conversation.input.dock` registration options and component;
 *   - the injected transport face (same-origin fetch to the exact Fetch route,
 *     envelope unwrap, silent failures, dismiss);
 *   - a tiny hook runtime that actually renders the component: idle edge →
 *     `suggestions/wait` → bar mounted; Tab accept through the apply-owned
 *     capture listener writes the draft (never submits) and dismisses; draft /
 *     running / blank / IME states render nothing; cached re-show avoids a
 *     second request.
 *
 * This is an assembly/contract check, not live Harness behavior (see plan §7).
 * No network, no installed profile, no writes outside this script.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let passed = 0
const failures = []

function record(name, detail) {
  passed += 1
  console.log(`  \u2713 ${name}${detail === undefined ? '' : ` \u2014 ${detail}`}`)
}

function fail(name, error) {
  failures.push({ name, detail: error instanceof Error ? error.message : String(error) })
  console.log(`  \u2717 ${name} \u2014 ${failures[failures.length - 1].detail}`)
}

function check(name, fn) {
  try {
    const detail = fn()
    record(name, detail)
  } catch (error) {
    fail(name, error)
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn()
    record(name, detail)
  } catch (error) {
    fail(name, error)
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// ── Minimal DOM shim (document listeners + the composer-input attribute gate) ──
function createDomShim() {
  /** @type {Map<string, Array<{fn: Function, capture: boolean}>>} */
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

/** Render + flush effects/promises until the hook runtime settles. */
async function settle(harness, Component, props, rounds = 12) {
  let element = harness.render(Component, props)
  for (let index = 0; index < rounds; index += 1) {
    await delay(0)
    if (!harness.needsRender()) break
    element = harness.render(Component, props)
  }
  return element
}

/** Depth-first text content of a rendered element tree. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node.__element === true) {
    return textOf(node.props === undefined ? undefined : node.props.children)
  }
  return ''
}

/** First element in the tree satisfying a predicate. */
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
const bindingById = new Map()
const scopeById = new Map()
const fakeServices = new Map()

// ── Stubbed same-origin fetch (the only client transport) ───────────────────
const fetchCalls = []

/** Minimal Response shim: `ok`, `status`, and a JSON body reader. */
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

/** Decode one recorded request body. */
function sentBody(call) {
  try {
    return JSON.parse(call.init.body)
  } catch (error) {
    return null
  }
}

/** Number of recorded `suggestions/wait` POSTs. */
function waitCallCount() {
  return fetchCalls.filter((call) => {
    const body = sentBody(call)
    return body !== null && body.endpoint === 'suggestions/wait'
  }).length
}

/** Per-test transport behavior; replaced by each check. */
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
  sessions: {
    binding(id) {
      return bindingById.get(id)
    },
    scope(id) {
      return scopeById.get(id)
    },
  },
  get(name) {
    return fakeServices.get(name)
  },
}

let conversationFocusCalls = 0
function makeConversationService() {
  return {
    input: {
      for() {
        return { focus() { conversationFocusCalls += 1 } }
      },
    },
  }
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[1/5] module registration and plugin face')
check('ModuleLoader registration captured', () => {
  assert.notEqual(loaded, null)
  return loaded.id
})
check('module id is the package name', () => {
  assert.equal(loaded.id, 'dsh-followup-prompt')
  return loaded.id
})
check('factory is a function', () => {
  assert.equal(typeof loaded.factory, 'function')
})
check('browser React is the only module-table read', () => {
  assert.deepEqual(requireCalls, ['react'])
  return requireCalls.join(',')
})
check('plugin face exports inject + apply', () => {
  assert.ok(plugin !== null && typeof plugin === 'object')
  assert.deepEqual(plugin.inject, ['slots', 'sessions', 'locale'])
  assert.equal(typeof plugin.apply, 'function')
  return `inject: ${plugin.inject.join(',')}`
})

console.log('\n[2/5] apply(): locale and slot registration')
check('apply runs without throwing', () => {
  assert.equal(typeof plugin.apply, 'function')
  return 'apply(fakeCtx)'
})
try {
  plugin.apply(fakeCtx)
  record('apply(fakeCtx) executed')
} catch (error) {
  fail('apply(fakeCtx) executed', error)
}
check('locale dictionaries registered under the plugin namespace', () => {
  assert.equal(localeRegistrations.length, 1)
  const [{ namespace, dictionaries }] = localeRegistrations
  assert.equal(namespace, 'followup-prompt')
  assert.ok(dictionaries.en !== undefined && dictionaries.zh !== undefined)
  assert.equal(typeof dictionaries.en['meta.title'], 'string')
  assert.equal(typeof dictionaries.zh['meta.title'], 'string')
  assert.equal(typeof dictionaries.en['prediction.prefix'], 'string')
  assert.equal(typeof dictionaries.zh['prediction.acceptHint'], 'string')
  return 'en + zh (meta.title/prediction.*)'
})
check('the composer input overlay slot is injected, then registered', () => {
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
  return `id=${options.id}, order=${options.order}, locale=${options.locale}`
})
check('apply side effects ride ctx.effect lifetimes', () => {
  assert.ok(effects.length >= 2)
  assert.ok(effects.some(entry => typeof entry.label === 'string' && entry.label.includes(': dictionaries')))
  return `${effects.length} effects`
})
check('keyboard capture listener installed on document', () => {
  assert.ok(dom.count('keydown') >= 1)
  return `${dom.count('keydown')} keydown listener(s)`
})

// ── Injected transport face ─────────────────────────────────────────────────
const injectedFace = registrations[0].options.inject('session-1')

console.log('\n[3/5] injected transport face (same-origin fetch, envelope unwrap, silent failure)')

await checkAsync('waitForSuggestion POSTs the exact Fetch route and unwraps the envelope value', async () => {
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
  return 'POST api/followup-prompt/rpc, credentials=same-origin, body={endpoint,payload}'
})

await checkAsync('waitForSuggestion forwards the AbortSignal only when supplied', async () => {
  fetchCalls.length = 0
  fetchHandler = async () => jsonResponse({ ok: true, value: { suggestion: 'x', turn: 1 } })
  const controller = new AbortController()
  await injectedFace.waitForSuggestion({ sessionId: 'session-1' }, controller.signal)
  assert.equal(fetchCalls[0].init.signal, controller.signal)
  await injectedFace.waitForSuggestion({ sessionId: 'session-1' })
  assert.equal(fetchCalls[1].init.signal, undefined)
  return 'signal passed through only when supplied'
})

await checkAsync('non-OK HTTP is silent idle (null)', async () => {
  fetchHandler = async () => jsonResponse({ error: 'unavailable' }, 503)
  assert.equal(await injectedFace.waitForSuggestion({ sessionId: 'session-1' }), null)
  return 'null on HTTP 503'
})

await checkAsync('thrown fetch / abort is silent idle (null)', async () => {
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
  return 'null on network error and AbortError'
})

await checkAsync('malformed JSON is silent idle (null)', async () => {
  fetchHandler = async () => ({
    ok: true,
    status: 200,
    async json() {
      throw new SyntaxError('unexpected end of JSON input')
    },
  })
  assert.equal(await injectedFace.waitForSuggestion({ sessionId: 'session-1' }), null)
  return 'null'
})

await checkAsync('{ok:false} envelope is silent idle (null)', async () => {
  fetchHandler = async () => jsonResponse({ ok: false, error: { code: 'busy', message: 'busy', details: {} } })
  assert.equal(await injectedFace.waitForSuggestion({ sessionId: 'session-1' }), null)
  return 'null'
})

await checkAsync('missing global fetch is silent idle (null)', async () => {
  delete globalThis.fetch
  assert.equal(await injectedFace.waitForSuggestion({ sessionId: 'session-1' }), null)
  globalThis.fetch = stubFetchImplementation
  return 'null without fetch'
})

await checkAsync('null/empty suggestion and reason-only values are silent idle', async () => {
  fetchHandler = async () => jsonResponse({ ok: true, value: { suggestion: null, turn: null, reason: 'no-completed-turn' } })
  assert.equal(await injectedFace.waitForSuggestion({ sessionId: 'session-1' }), null)
  fetchHandler = async () => jsonResponse({ ok: true, value: { suggestion: '   ', turn: 3 } })
  assert.equal(await injectedFace.waitForSuggestion({ sessionId: 'session-1' }), null)
  return 'null'
})

await checkAsync('dismissSuggestion POSTs suggestions/dismiss fire-and-forget', async () => {
  fetchCalls.length = 0
  fetchHandler = async () => jsonResponse({ ok: true, value: { ok: true } })
  const returned = injectedFace.dismissSuggestion({ sessionId: 'session-1', turn: 7 })
  assert.equal(fetchCalls.length, 1)
  const [{ url, init }] = fetchCalls
  assert.equal(url, 'api/followup-prompt/rpc')
  assert.equal(init.method, 'POST')
  assert.deepEqual(JSON.parse(init.body), { endpoint: 'suggestions/dismiss', payload: { sessionId: 'session-1', turn: 7 } })
  if (returned !== undefined && typeof returned.then === 'function') await returned
  return 'endpoint=suggestions/dismiss on the same route'
})

await checkAsync('dismiss transport failure is swallowed', async () => {
  fetchHandler = async () => {
    throw new Error('network error')
  }
  const returned = injectedFace.dismissSuggestion({ sessionId: 'session-1' })
  if (returned !== undefined && typeof returned.then === 'function') await returned
  return 'no rejection'
})

check('focusComposer uses the session conversation service', () => {
  conversationFocusCalls = 0
  const actx = {
    get(name) {
      return name === 'conversation' ? makeConversationService() : undefined
    },
  }
  bindingById.set('session-1', { ctx: actx })
  scopeById.set('session-1', actx)
  injectedFace.focusComposer()
  assert.equal(conversationFocusCalls, 1)
  bindingById.delete('session-1')
  scopeById.delete('session-1')
  injectedFace.focusComposer() // absent session: best-effort no-op, never throws
  return 'focus() called once, absent session ignored'
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
    focusComposer: face.focusComposer,
  })
  return { componentHarness, props }
}

/** Dispatch Tab at the given target through the apply-owned capture listener. */
function dispatchTab(target, key) {
  const event = createKeyDownEvent(target)
  event.key = key === undefined ? 'Tab' : key
  dom.dispatch('keydown', event)
  return event
}

const defaultRpc = {
  waitForSuggestion: injectedFace.waitForSuggestion,
  dismissSuggestion: injectedFace.dismissSuggestion,
  focusComposer: injectedFace.focusComposer,
}

console.log('\n[4/5] component state machine and Tab accept (fake hook runtime)')

await checkAsync('idle edge requests once and mounts the inline ghost', async () => {
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
  return 'role=status, one suggestions/wait, suggestion rendered'
})

await checkAsync('Tab inside the composer accepts into the draft and never sends', async () => {
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
  let focusCalls = 0
  face.focusComposer = () => { focusCalls += 1 }
  const { componentHarness, props } = makeComponentProps(state, face, actions)
  let element = await settle(componentHarness, registrations[0].component, props)
  assert.notEqual(element, null)
  const focusedEditor = new dom.FakeElement(true)
  dom.document.activeElement = focusedEditor
  const event = dispatchTab(new dom.FakeElement(true))
  assert.equal(event.defaultPrevented, true)
  assert.equal(event.propagationStopped, true)
  assert.equal(actions.calls.captureInsertion, 1)
  assert.deepEqual(actions.calls.insertText, [{ text: 'hello there', span: { start: 0, end: 0, draftRev: 4 } }])
  assert.deepEqual(actions.calls.setDraft, [])
  assert.equal(actions.calls.submit, 0)
  assert.equal(focusCalls, 0, 'Tab accept must not re-focus an already focused editor')
  assert.deepEqual(face.dismissPayload, { sessionId: 'session-1', turn: 7 })
  dom.document.activeElement = null
  // The ghost clears after accepting.
  element = await settle(componentHarness, registrations[0].component, props)
  assert.equal(element, null)
  componentHarness.unmount()
  return 'insertText only; dismiss sent; submit never called'
})

await checkAsync('Tab outside the composer input is let through', async () => {
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
  return 'no preventDefault outside [data-composer-input]'
})

await checkAsync('non-empty draft: no request, nothing rendered, Tab passes', async () => {
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
  return 'null, zero RPC, Tab untouched'
})

await checkAsync('blank / awaiting-first-turn sessions never request', async () => {
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
  return 'blank / awaitingFirstTurn / running: no requests'
})

await checkAsync('failed suggestion request stays silent', async () => {
  fetchCalls.length = 0
  fetchHandler = async () => {
    throw new Error('network error')
  }
  const state = makeComponentState()
  const actions = makeInputActions()
  const { componentHarness, props } = makeComponentProps(state, defaultRpc, actions)
  assert.equal(await settle(componentHarness, registrations[0].component, props), null)
  componentHarness.unmount()
  return 'null'
})

await checkAsync('insertText returning false: Tab is not consumed and nothing is dismissed', async () => {
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
    focusComposer: injectedFace.focusComposer,
  }, actions)
  const element = await settle(componentHarness, registrations[0].component, props)
  assert.notEqual(element, null)
  const event = dispatchTab(new dom.FakeElement(true))
  assert.equal(event.defaultPrevented, false)
  assert.equal(dismissCalls.length, 0)
  assert.deepEqual(actions.calls.setDraft, [])
  componentHarness.unmount()
  return 'no preventDefault, no dismiss, no destructive setDraft'
})

await checkAsync('setDraft fallback is used only when the insertion pair is absent', async () => {
  fetchCalls.length = 0
  fetchHandler = async () => jsonResponse({ ok: true, value: { suggestion: 'hello there', turn: 7 } })
  const state = makeComponentState()
  const actions = makeInputActions()
  const legacyActions = { setDraft: actions.actions.setDraft }
  const dismissCalls = []
  const { componentHarness, props } = makeComponentProps(state, {
    waitForSuggestion: injectedFace.waitForSuggestion,
    dismissSuggestion: payload => {
      dismissCalls.push(payload)
      return Promise.resolve()
    },
    focusComposer: injectedFace.focusComposer,
  }, { actions: legacyActions, calls: actions.calls })
  assert.notEqual(await settle(componentHarness, registrations[0].component, props), null)
  const event = dispatchTab(new dom.FakeElement(true))
  assert.equal(event.defaultPrevented, true)
  assert.deepEqual(actions.calls.setDraft, ['hello there'])
  assert.equal(dismissCalls.length, 1)
  assert.equal(actions.calls.submit, 0)
  componentHarness.unmount()
  return 'setDraft fallback applied'
})

await checkAsync('running true hides and a later idle edge asks again', async () => {
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
  return 'hidden on running, one new request on the next idle edge'
})

await checkAsync('draft typing hides; clearing the draft re-shows from cache without a new RPC', async () => {
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
  return 'same-turn cached re-show, no second request'
})

await checkAsync('IME composition hides the bar and shows it again after the grace period', async () => {
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
  return 'hidden during composition, restored 10ms after compositionend'
})

await checkAsync('close button dismisses and clears the bar', async () => {
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
    focusComposer: injectedFace.focusComposer,
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
  return 'dismissed + cleared'
})

await checkAsync('Escape closes the bar through the capture listener', async () => {
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
  return 'Escape consumed only while the bar is visible'
})

await checkAsync('an open command menu keeps Tab for itself', async () => {
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
  return 'visible listbox/menu lets Tab pass; hidden menu does not'
})

console.log('\n[5/5] client source contract guards')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'client.js'), 'utf8')
check('never calls a submission entry point', () => {
  assert.ok(!/\.submit\s*\(/.test(source))
  assert.ok(!/\bsubmit\s*\(/.test(source))
  return 'no submit call'
})
check('does not mutate the editor DOM', () => {
  assert.ok(!/['"]contentEditable['"]\s*:/.test(source))
  assert.ok(!/insertAdjacentHTML|innerHTML\s*=/.test(source))
  assert.ok(!/\.setAttribute\s*\(/.test(source))
  return 'no DOM mutation'
})
check('client transport is the same-origin exact Fetch route (no connection service)', () => {
  assert.ok(source.includes("'api/followup-prompt/rpc'"))
  assert.ok(source.includes("credentials: 'same-origin'"))
  assert.ok(/method:\s*'POST'/.test(source))
  assert.ok(/fetch\(\s*'api\/followup-prompt\/rpc'\s*,\s*init\s*\)/.test(source))
  assert.ok(!/ctx\.connection\.rpc\.call/.test(source))
  assert.ok(!/inject:\s*\[[^\]]*'connection'/.test(source))
  return 'POST api/followup-prompt/rpc; no connection service'
})
check('only shipped theme alias tokens are referenced', () => {
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
  return `${used.size} token(s), all shipped`
})

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('\n──────────────────────────────────────────────')
if (failures.length === 0) {
  console.log(`CLIENT SMOKE PASSED: ${passed} checks.`)
  console.log('Stub-driven contract check only; live Harness behavior is covered by plan \u00a77.2.')
  process.exit(0)
}
console.log(`CLIENT SMOKE FAILED: ${failures.length} failure(s), ${passed} passed.`)
for (const failure of failures) console.log(`  - ${failure.name}: ${failure.detail}`)
process.exit(1)
