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

/** Walk the fake element tree; function components are not invoked, their props are inspected instead. */
function findElements(node, predicate) {
  const found = []
  function visit(value) {
    if (value === null || value === undefined) return
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
      return
    }
    if (typeof value !== 'object' || value.__element !== true) return
    if (predicate(value)) found.push(value)
    visit(value.props === undefined ? undefined : value.props.children)
  }
  visit(node)
  return found
}

function elementById(element, id) {
  return findElements(element, (node) => node.props !== undefined && node.props.id === id)[0]
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

// The real page renders the baseline settings frame and controls; these stubs
// keep the fake React runtime from needing the full primitives implementation.
const primitivesStub = {
  SettingsForm: function SettingsForm() {},
  Tag: function Tag() {},
  Button: function Button() {},
}

let requireCalls = []
const plugin = loaded.factory(function fakeRequire(specifier) {
  requireCalls.push(specifier)
  if (specifier === 'react') return reactRuntime.runtime
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error(`unexpected client module require: ${String(specifier)}`)
})

// ── Fake Client Context ──────────────────────────────────────────────────────
const localeRegistrations = []
const slotInjections = []
const registrations = []
const effects = []
const clientInjections = []
let modelCatalogHandler = async () => ({
  ok: true,
  value: { groups: [], failures: [], default: { provider: 'deepseek-account', model: 'deepseek-flash' }, routableProviders: [] },
})

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
  inject(deps, callback) {
    clientInjections.push([...deps])
    const child = {
      effect(factory, label) {
        const cleanup = factory()
        effects.push({ label, cleanup })
        return async () => {
          if (typeof cleanup === 'function') await cleanup()
        }
      },
      remote: {
        session: {
          modelCatalog: (...args) => modelCatalogHandler(...args),
        },
      },
    }
    callback(child)
    return { dispose() {} }
  },
}

// ── module registration and plugin face ──
test('ModuleLoader registration under the package id, reading React and the baseline primitives', () => {
  assert.equal(loaded?.id, 'dsh-followup-prompt')
  assert.deepEqual(requireCalls, ['react', '@deepseek-ai/dsh-client-ui-primitives'])
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
  assert.equal(typeof dictionaries.zh['prediction.statusAria'], 'string')
})

test('config page copy covers every field in both languages', () => {
  const [{ dictionaries }] = localeRegistrations
  const fields = ['reasoningEffort', 'maxTokens', 'timeoutMs', 'prompt']
  for (const language of ['en', 'zh']) {
    const dict = dictionaries[language]
    for (const field of fields) {
      assert.equal(typeof dict[`config.${field}.label`], 'string', `${language}: config.${field}.label`)
      assert.equal(typeof dict[`config.${field}.hint`], 'string', `${language}: config.${field}.hint`)
    }
    for (const key of ['config.summary', 'config.loading', 'config.unavailable', 'config.intro', 'config.overridden', 'config.reset', 'config.save', 'config.saving', 'config.saveFailed', 'config.readOnly', 'config.invalidNumber', 'config.modelRoute.label', 'config.modelRoute.hint', 'config.modelRoute.sessionDefault', 'config.modelRoute.currentGroup', 'config.modelRoute.loading', 'config.modelRoute.error', 'config.modelRoute.retry']) {
      assert.equal(typeof dict[key], 'string', `${language}: ${key}`)
    }
  }
})

test('the composer input overlay slot is injected, then registered', () => {
  assert.deepEqual(slotInjections, ['conversation.input.overlay', 'plugins.row.config'])
  assert.equal(registrations.length, 2)
  const { options } = registrations[0]
  assert.equal(options.name, 'conversation.input.overlay')
  assert.equal(options.id, 'followup-prompt')
  assert.equal(options.locale, 'followup-prompt')
  assert.equal(typeof options.order, 'number')
  assert.ok(options.order >= 10)
  assert.equal(typeof options.inject, 'function')
  assert.equal(typeof registrations[0].component, 'function')
})

test('the plugin settings page registers under the bundle row key', () => {
  const { options, component } = registrations[1]
  assert.equal(options.name, 'plugins.row.config')
  assert.equal(options.key, 'dsh-followup-prompt#followup-prompt')
  assert.equal(options.locale, 'followup-prompt')
  assert.equal(typeof component, 'function')
})

test('apply side effects ride ctx.effect lifetimes', () => {
  assert.deepEqual(clientInjections, [['remote', 'remote.session']], 'model catalog rides an optional Remote injection')
  assert.ok(effects.length >= 4)
  assert.ok(effects.some(entry => typeof entry.label === 'string' && entry.label.includes(': dictionaries')))
  assert.ok(effects.some(entry => typeof entry.label === 'string' && entry.label.includes(': plugin settings page')))
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
  // The overlay renders exactly the style tag plus the inline ghost.
  assert.equal(element.props.children.length, 2)
  const [styleElement, ghostElement] = element.props.children
  assert.equal(styleElement.type, 'style')
  assert.equal(ghostElement.type, 'span')
  assert.equal(ghostElement.props.children, 'hello there')
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

// ── Plugin settings page (Plugins → Installed → row Configure) ───────────────
const CONFIG_PAGE = registrations[1].component
const CONFIG_DEFAULTS = Object.freeze({
  provider: '',
  model: '',
  reasoningEffort: 'low',
  maxTokens: 8192,
  timeoutMs: 30000,
  prompt: '',
})

function makeConfigPageProps(options = {}) {
  const calls = []
  const form = {
    state: {
      status: options.status ?? 'ready',
      value: { ...CONFIG_DEFAULTS, ...options.value },
      base: { ...CONFIG_DEFAULTS, ...options.base },
      user: options.user ?? {},
      revision: options.revision ?? 7,
      writable: options.writable !== false,
    },
    mutate(ops, revision) {
      calls.push({ ops, revision })
      return options.mutate === undefined ? Promise.resolve(true) : options.mutate(ops, revision)
    },
  }
  return {
    props: {
      view: 'page',
      form,
      t: (key) => `t:${key}`,
      loadModelCatalog: options.loadModelCatalog === undefined ? async () => ({ groups: [] }) : options.loadModelCatalog,
    },
    calls,
    form,
  }
}

async function renderConfigPage(props) {
  const harness = reactRuntime.createInstance()
  const element = await settle(harness, CONFIG_PAGE, props)
  return { harness, element }
}

function settingsFormOf(element) {
  const [frame] = findElements(element, (node) => node.type === primitivesStub.SettingsForm)
  assert.ok(frame !== undefined, 'settings form frame rendered')
  return frame
}

/** The real control element a row renders (the row component itself is not invoked by the fake runtime). */
function controlById(element, id) {
  const control = findElements(element, (node) => node.props !== undefined
    && node.props.id === id
    && (node.type === 'input' || node.type === 'select' || node.type === 'textarea'))[0]
  assert.ok(control !== undefined, `control ${id} rendered`)
  return control
}

/** One field row's props, including the staged override and error the frame would render. */
function configRowOf(element, id) {
  const row = findElements(element, (node) => node.props !== undefined
    && node.props.id === id
    && typeof node.props.onReset === 'function')[0]
  assert.ok(row !== undefined, `row ${id} rendered`)
  return row
}

test('config page: summary and unavailable views stay text-only', async () => {
  const summary = await renderConfigPage({ view: 'summary', t: (key) => `t:${key}` })
  assert.equal(summary.element, 't:config.summary')
  const unavailable = await renderConfigPage({ view: 'page', form: undefined, t: (key) => `t:${key}` })
  assert.ok(textOf(unavailable.element).includes('t:config.unavailable'))
})

test('config page: the frame receives the Host values and a clean staged state', async () => {
  const { props } = makeConfigPageProps({ value: { timeoutMs: 5000 }, user: { timeoutMs: 5000 } })
  const { element } = await renderConfigPage(props)
  const frame = settingsFormOf(element)
  assert.equal(frame.props.state.available, true)
  assert.equal(frame.props.state.writable, true)
  assert.equal(frame.props.state.dirty, false)
  assert.equal(frame.props.state.invalid, false)
  assert.equal(frame.props.state.saving, false)
  assert.equal(frame.props.state.failed, false)
  assert.equal(frame.props.labels.save, 't:config.save')
  assert.equal(frame.props.labels.unavailable, 't:config.unavailable')
  // Only timeoutMs carries a profile override, so exactly that row shows the badge.
  assert.equal(configRowOf(element, 'followup-config-timeoutMs').props.overridden, true)
  assert.equal(configRowOf(element, 'followup-config-timeoutMs').props.overriddenLabel, 't:config.overridden')
  assert.equal(configRowOf(element, 'followup-config-model').props.overridden, false)
})

test('config page: text and enum edits save their staged values', async () => {
  const { props, calls } = makeConfigPageProps()
  const { harness, element } = await renderConfigPage(props)
  const textarea = findElements(element, (node) => node.type === 'textarea')[0]
  textarea.props.onChange({ target: { value: 'Predict tersely.' } })
  controlById(element, 'followup-config-reasoningEffort').props.onChange({ target: { value: 'high' } })
  const next = await settle(harness, CONFIG_PAGE, props)
  settingsFormOf(next).props.onSave()
  await delay(0)
  assert.deepEqual(calls, [{
    ops: [
      { op: 'set', path: ['reasoningEffort'], value: 'high' },
      { op: 'set', path: ['prompt'], value: 'Predict tersely.' },
    ],
    revision: 7,
  }])
})

const MODEL_CATALOG = {
  groups: [
    {
      id: 'deepseek-account',
      name: 'DeepSeek Account',
      models: [{
        id: 'deepseek-flash',
        name: 'DeepSeek Flash',
        reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
      }],
    },
    { id: 'acme', name: 'Acme', models: [{ id: 'acme-pro', name: 'Acme Pro' }] },
  ],
  failures: [],
}

function modelSelectOf(element) {
  return controlById(element, 'followup-config-model')
}

function optionValuesOf(element) {
  return findElements(modelSelectOf(element), (node) => node.type === 'option').map((node) => node.props.value)
}

test('config page: the model selector lists the DSH catalog grouped by provider', async () => {
  const { props } = makeConfigPageProps({
    value: { provider: 'deepseek-account', model: 'deepseek-flash' },
    loadModelCatalog: async () => MODEL_CATALOG,
  })
  const { element } = await renderConfigPage(props)
  const select = modelSelectOf(element)
  assert.equal(select.type, 'select')
  assert.equal(select.props.value, '["deepseek-account","deepseek-flash"]')
  const values = optionValuesOf(element)
  assert.ok(values.includes(''), 'session default stays selectable')
  assert.ok(values.includes('["deepseek-account","deepseek-flash"]'))
  assert.ok(values.includes('["acme","acme-pro"]'))
  const groups = findElements(select, (node) => node.type === 'optgroup')
  assert.deepEqual(groups.map((group) => group.props.label), ['DeepSeek Account', 'Acme'])
})

test('config page: selecting a catalog model stages the provider/model pair atomically', async () => {
  const { props, calls } = makeConfigPageProps({ loadModelCatalog: async () => MODEL_CATALOG })
  const { harness, element } = await renderConfigPage(props)
  modelSelectOf(element).props.onChange({ target: { value: '["deepseek-account","deepseek-flash"]' } })
  const next = await settle(harness, CONFIG_PAGE, props)
  settingsFormOf(next).props.onSave()
  await delay(0)
  assert.deepEqual(calls, [{
    ops: [
      { op: 'set', path: ['provider'], value: 'deepseek-account' },
      { op: 'set', path: ['model'], value: 'deepseek-flash' },
    ],
    revision: 7,
  }])
})

test('config page: a model without the current reasoning effort falls back to the model default', async () => {
  const { props, calls } = makeConfigPageProps({ loadModelCatalog: async () => MODEL_CATALOG })
  const { harness, element } = await renderConfigPage(props)
  modelSelectOf(element).props.onChange({ target: { value: '["acme","acme-pro"]' } })
  const next = await settle(harness, CONFIG_PAGE, props)
  settingsFormOf(next).props.onSave()
  await delay(0)
  assert.deepEqual(calls, [{
    ops: [
      { op: 'set', path: ['provider'], value: 'acme' },
      { op: 'set', path: ['model'], value: 'acme-pro' },
      { op: 'set', path: ['reasoningEffort'], value: '' },
    ],
    revision: 7,
  }])
})

test('config page: the session-default option clears the route pair', async () => {
  const { props, calls } = makeConfigPageProps({
    value: { provider: 'acme', model: 'acme-pro', reasoningEffort: '' },
    loadModelCatalog: async () => MODEL_CATALOG,
  })
  const { harness, element } = await renderConfigPage(props)
  modelSelectOf(element).props.onChange({ target: { value: '' } })
  const next = await settle(harness, CONFIG_PAGE, props)
  settingsFormOf(next).props.onSave()
  await delay(0)
  assert.deepEqual(calls, [{
    ops: [
      { op: 'set', path: ['provider'], value: '' },
      { op: 'set', path: ['model'], value: '' },
    ],
    revision: 7,
  }])
})

test('config page: a configured route outside the catalog stays selectable', async () => {
  const { props } = makeConfigPageProps({
    value: { provider: 'custom', model: 'custom-1' },
    loadModelCatalog: async () => MODEL_CATALOG,
  })
  const { element } = await renderConfigPage(props)
  assert.equal(modelSelectOf(element).props.value, '["custom","custom-1"]')
  assert.ok(optionValuesOf(element).includes('["custom","custom-1"]'))
  const groups = findElements(modelSelectOf(element), (node) => node.type === 'optgroup')
  assert.ok(groups.some((group) => group.props.label === 't:config.modelRoute.currentGroup'))
})

test('config page: a failed catalog read offers a retry', async () => {
  let reads = 0
  const loadModelCatalog = async () => {
    reads += 1
    if (reads === 1) throw new Error('offline')
    return MODEL_CATALOG
  }
  const { props } = makeConfigPageProps({ loadModelCatalog })
  const { harness, element } = await renderConfigPage(props)
  const rowOf = (node) => findElements(node, (candidate) => candidate.props !== undefined
    && candidate.props.id === 'followup-config-model' && typeof candidate.props.onReset === 'function')[0]
  const row = rowOf(element)
  assert.equal(row.props.hint, 't:config.modelRoute.error')
  const retry = row.props.action
  assert.equal(retry?.type, primitivesStub.Button, 'retry control rendered beside the row')
  assert.equal(textOf(retry), 't:config.modelRoute.retry')
  retry.props.onClick()
  const next = await settle(harness, CONFIG_PAGE, props)
  assert.equal(reads, 2)
  assert.equal(rowOf(next).props.hint, 't:config.modelRoute.hint')
})

test('config page: a stored half-filled route does not block unrelated saves', async () => {
  const { props, calls } = makeConfigPageProps({ value: { provider: 'acme', model: '' } })
  const { harness, element } = await renderConfigPage(props)
  controlById(element, 'followup-config-timeoutMs').props.onChange({ target: { value: '4000' } })
  const next = await settle(harness, CONFIG_PAGE, props)
  assert.equal(settingsFormOf(next).props.state.invalid, false)
  settingsFormOf(next).props.onSave()
  await delay(0)
  assert.deepEqual(calls, [{ ops: [{ op: 'set', path: ['timeoutMs'], value: 4000 }], revision: 7 }])
})

test('config page: an out-of-range number blocks the save until fixed', async () => {
  const { props, calls } = makeConfigPageProps()
  const { harness, element } = await renderConfigPage(props)
  controlById(element, 'followup-config-maxTokens').props.onChange({ target: { value: '0' } })
  let next = await settle(harness, CONFIG_PAGE, props)
  assert.equal(settingsFormOf(next).props.state.invalid, true)
  settingsFormOf(next).props.onSave()
  await delay(0)
  assert.deepEqual(calls, [])
  const rows = findElements(next, (node) => node.props !== undefined
    && node.props.id === 'followup-config-maxTokens' && node.props.error !== undefined)
  assert.equal(rows[0].props.error, 't:config.invalidNumber')
  controlById(next, 'followup-config-maxTokens').props.onChange({ target: { value: '4096' } })
  next = await settle(harness, CONFIG_PAGE, props)
  assert.equal(settingsFormOf(next).props.state.invalid, false)
  settingsFormOf(next).props.onSave()
  await delay(0)
  assert.deepEqual(calls, [{ ops: [{ op: 'set', path: ['maxTokens'], value: 4096 }], revision: 7 }])
})

test('config page: reset unsets the stored override', async () => {
  const { props, calls } = makeConfigPageProps({ value: { timeoutMs: 5000 }, user: { timeoutMs: 5000 } })
  const { harness, element } = await renderConfigPage(props)
  const reset = configRowOf(element, 'followup-config-timeoutMs')
  assert.equal(reset.props.overridden, true)
  reset.props.onReset()
  const next = await settle(harness, CONFIG_PAGE, props)
  assert.equal(settingsFormOf(next).props.state.dirty, true)
  settingsFormOf(next).props.onSave()
  await delay(0)
  assert.deepEqual(calls, [{ ops: [{ op: 'unset', path: ['timeoutMs'] }], revision: 7 }])
})

test('config page: a read-only profile disables every control', async () => {
  const { props } = makeConfigPageProps({ writable: false })
  const { element } = await renderConfigPage(props)
  assert.equal(settingsFormOf(element).props.state.writable, false)
  assert.ok(findElements(element, (node) => node.type === 'textarea').every((node) => node.props.disabled === true))
  assert.equal(controlById(element, 'followup-config-reasoningEffort').props.disabled, true)
  assert.equal(modelSelectOf(element).props.disabled, true)
})

test('config page: a refused save keeps the draft and reports failure', async () => {
  const { props } = makeConfigPageProps({ mutate: () => Promise.resolve(false) })
  const { harness, element } = await renderConfigPage(props)
  controlById(element, 'followup-config-timeoutMs').props.onChange({ target: { value: '4000' } })
  let next = await settle(harness, CONFIG_PAGE, props)
  settingsFormOf(next).props.onSave()
  await delay(0)
  next = await settle(harness, CONFIG_PAGE, props)
  assert.equal(settingsFormOf(next).props.state.failed, true)
  assert.equal(settingsFormOf(next).props.state.dirty, true, 'the draft survives a refusal')
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
    '--dsw-alias-bg-layer-3',
    '--dsw-alias-bg-overlay',
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-alias-border-l4',
    '--dsw-alias-brand-primary',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-label-tertiary',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-idle-primary',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-warn-primary',
    '--dsw-specific-sidebar-fill',
  ])
  const used = new Set([...source.matchAll(/--dsw-[a-z0-9-]+/gi)].map(match => match[0]))
  const unknown = [...used].filter(token => !allowed.has(token) && !token.startsWith('--dsw-radius-'))
  assert.deepEqual(unknown, [])
  assert.ok(used.has('--dsw-alias-label-secondary'))
})
