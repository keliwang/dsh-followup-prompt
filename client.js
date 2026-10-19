/**
 * Followup Prompt — Client (browser) half of the `dsh-followup-prompt` bundle.
 *
 * Lazy-CJS plugin loaded through `window.__ModuleLoader__` (no bundler, no JSX):
 * the browser module table hands us React, and we contribute one ambient
 * suggestion bar to the `conversation.composer.dock` slot. The bar shows the
 * next-user-message prediction the Host generated for the latest completed
 * turn; Tab (or a click) accepts it into the composer as an editable draft.
 * It never sends, and every failure/state change degrades to "render nothing".
 *
 * Contract sources verified against DSH 0.2.1-rc.2:
 * - module registration: packages/client/modules/src/client/manifest.ts
 * - slots: packages/client/ui-slots/src/index.ts + ui-renderer/src/client/registry.ts
 *   (`conversation.composer.dock` is a session-scope list slot declared by
 *   ui-conversation; third-party entries register via ctx.slots.inject/register)
 * - standard props: ui-conversation contract/slots.ts (SessionStandardProps),
 *   ui-session client/index.ts (sessionId/useSession), contract/input.ts
 *   (`InputActions.captureInsertion/insertText/setDraft`, `InputState`)
 * - transport: same-origin `POST api/followup-prompt/rpc` exactly like ds-bot's
 *   `POST api/bot` (installed ds-bot client.js + src/host/channel.js). The Host
 *   registers the exact Fetch route via `ctx.connection.fetch.register`
 *   (`path: '/api/followup-prompt/rpc'`) on the shared `/api` channel, so the
 *   browser cookie authenticates it; the body is `{endpoint, payload}` and the
 *   response is a JSON `{ok:true,value}` / `{ok:false,error}` envelope. The
 *   reference RPC-channel route (`ctx.connection.rpc.handle`) is not used:
 *   profile bundles cannot inject the `webServer` service it requires.
 * - locale: packages/client/locale/src/client/index.ts (`ctx.locale.register`)
 * - editor DOM gate: the composer editor host component sets `data-composer-input`;
 *   keymap.ts sets `data-composer-composing`.
 *
 * Never calls `inputActions` submission; only captureInsertion/insertText/setDraft.
 */
window.__ModuleLoader__.load({
  id: 'dsh-followup-prompt',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace / loader row identity / slot identity. */
    const NS = 'followup-prompt'
    const SLOT = 'conversation.composer.dock'
    const SLOT_ID = 'followup-prompt'
    /** After ui-chat's activity (0) and usage (1) pills; additive list order. */
    const SLOT_ORDER = 100
    /** Client-side safety net; the Host bounds its own long poll well below this. */
    const REQUEST_TIMEOUT_MS = 20000
    /** Safari can emit the closing keydown after compositionend; keep the gate briefly. */
    const COMPOSITION_GRACE_MS = 10
    /** The composer editor host's published DOM attribute (the accept gate). */
    const COMPOSER_INPUT_SELECTOR = '[data-composer-input]'

    // ── Dictionaries ────────────────────────────────────────────────────────
    // Flat `{ key: text }` maps; the locale plugin resolves them per active
    // locale with English fallback. `meta.*` mirrors locale/*.json so the
    // runtime seat also carries display copy.
    const EN = {
      'meta.title': 'Followup Prompt',
      'meta.description': 'Predicts your next message after each reply and offers it below the composer as an editable draft. Press Tab to accept; it never sends by itself.',
      'prediction.prefix': 'Prediction',
      'prediction.statusAria': 'Predicted next message',
      'prediction.acceptAria': 'Insert the prediction into the composer draft',
      'prediction.acceptHint': 'to accept',
      'prediction.dismissAria': 'Dismiss the prediction',
    }
    const ZH = {
      'meta.title': '后续提示',
      'meta.description': '每轮回复结束后预测你的下一条消息，并在输入框下方提供可编辑草稿。按 Tab 接受，绝不自动发送。',
      'prediction.prefix': '预测',
      'prediction.statusAria': '预测的下一条消息',
      'prediction.acceptAria': '将预测内容填入输入框草稿',
      'prediction.acceptHint': '接受',
      'prediction.dismissAria': '关闭预测',
    }

    // ── Presentation ────────────────────────────────────────────────────────
    // Only tokens that exist in the shipped theme alias layer (verified against
    // ui-theme's token catalog) plus layout-neutral fallbacks; light and dark
    // both resolve through the theme, so no palette color is hard-coded.
    const styles = {
      bar: {
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flex: '1 1 auto',
        minWidth: 0,
        width: '100%',
        maxWidth: 'var(--dsh-composer-card-max-width, 952px)',
        margin: '0 auto',
        padding: '5px 6px 5px 10px',
        borderRadius: 'var(--dsw-radius-md, 10px)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28))',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.10))',
        color: 'var(--dsw-alias-label-secondary, currentColor)',
        fontFamily: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
      },
      glyph: {
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        color: 'var(--dsw-alias-brand-primary, currentColor)',
        fontSize: '13px',
        lineHeight: '18px',
      },
      prefix: {
        flex: 'none',
        fontWeight: '500',
        color: 'var(--dsw-alias-label-secondary, currentColor)',
      },
      accept: {
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        margin: 0,
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, currentColor)',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      },
      hint: {
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        color: 'var(--dsw-alias-label-secondary, currentColor)',
      },
      kbd: {
        fontFamily: 'inherit',
        fontSize: '11px',
        lineHeight: '16px',
        padding: '0 5px',
        borderRadius: '5px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28))',
        background: 'var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.08))',
        color: 'var(--dsw-alias-label-secondary, currentColor)',
      },
      close: {
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '22px',
        height: '22px',
        padding: 0,
        border: 'none',
        borderRadius: '999px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, currentColor)',
        font: 'inherit',
        fontSize: '15px',
        lineHeight: '1',
        cursor: 'pointer',
      },
    }

    const CSS_TEXT = [
      '[data-followup-prompt] button { font-family: inherit; }',
      '[data-followup-prompt] .fup-accept:hover { color: var(--dsw-alias-brand-primary, currentColor); }',
      '[data-followup-prompt] .fup-close:hover {',
      '  color: var(--dsw-alias-label-primary, currentColor);',
      '  background: var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.10));',
      '}',
      '[data-followup-prompt] .fup-accept:focus-visible,',
      '[data-followup-prompt] .fup-close:focus-visible { outline-offset: 1px; }',
      '@keyframes fup-fade-in { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }',
      '@media (prefers-reduced-motion: no-preference) {',
      '  [data-followup-prompt] { animation: fup-fade-in 140ms ease-out; }',
      '}',
    ].join('\n')

    // ── Small defensive helpers ─────────────────────────────────────────────
    /** Identity selector: the published snapshots are stable references. */
    function selectSnapshot(snapshot) {
      return snapshot
    }

    /** Hook seat used when a composition omits a standard hook (never expected). */
    function useAbsentSnapshot() {
      return undefined
    }

    /** Translate fallback: a missing locale seat must not break rendering. */
    function identityTranslate(key) {
      return key
    }

    /** Keep the composer focused when a bar control is pressed. */
    function preventFocusLoss(event) {
      try {
        event.preventDefault()
      } catch (error) {
        /* ignore */
      }
    }

    /** Whether the event target is (inside) the composer's editable host. */
    function isInsideComposer(target) {
      if (target === null || target === undefined || typeof target !== 'object') return false
      if (typeof Element !== 'undefined' && !(target instanceof Element)) return false
      if (typeof target.closest !== 'function') return false
      try {
        return target.closest(COMPOSER_INPUT_SELECTOR) !== null
      } catch (error) {
        return false
      }
    }

    /**
     * Cheap open-popup probe: a visible slash/command menu owns the keyboard
     * gesture, so the bar must let Tab/Escape through while one is open.
     * Hidden-but-mounted menus (getClientRects() empty) do not count.
     */
    function hasOpenPopup() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return false
      try {
        const nodes = document.querySelectorAll('[role="listbox"], [role="menu"]')
        for (const node of nodes) {
          if (node === null || node === undefined) continue
          try {
            if (typeof node.getClientRects === 'function' && node.getClientRects().length > 0) return true
          } catch (error) {
            return true
          }
        }
        return false
      } catch (error) {
        return false
      }
    }

    /** Whether a keyboard event is an IME composition event (legacy keyCode included). */
    function isComposingEvent(event) {
      if (event === null || event === undefined) return false
      if (event.isComposing === true) return true
      // Legacy engines signal composition with keyCode 229 while isComposing stays false.
      return event.keyCode === 229 || event.which === 229
    }

    // ── Template class (re-created per render; hook order is fixed) ─────────
    /**
     * Suggested next message bar, mounted as one list entry inside
     * `conversation.composer.dock` for the current Session.
     *
     * Standard props consumed: sessionId, useSession, useInput, inputActions, t.
     * Injected props consumed: waitForSuggestion, dismissSuggestion,
     * focusComposer, activateBar (the apply-owned keyboard bridge).
     */
    function FollowupSuggestionBar(props) {
      const {
        sessionId,
        inputActions,
        t,
        waitForSuggestion,
        dismissSuggestion,
        focusComposer,
        activateBar,
      } = props

      // Hooks stay in fixed positions regardless of optional prop presence.
      const useSessionHook = typeof props.useSession === 'function' ? props.useSession : useAbsentSnapshot
      const useInputHook = typeof props.useInput === 'function' ? props.useInput : useAbsentSnapshot
      const session = useSessionHook(selectSnapshot)
      const input = useInputHook(selectSnapshot)

      const [suggestion, setSuggestion] = React.useState(null)
      const [turn, setTurn] = React.useState(null)
      const [composing, setComposing] = React.useState(false)

      /** Generation token: bumped on abort, so stale responses are dropped. */
      const generationRef = React.useRef(0)
      /** In-flight request cancellation. */
      const abortRef = React.useRef(null)
      /** One request per idle epoch; reset when a new turn starts. */
      const requestedRef = React.useRef(false)
      /** Last accepted {sessionId, turn, suggestion} answer (per session+turn). */
      const cacheRef = React.useRef(null)
      /** Explicit dismissal (close) suppresses a cached re-show. */
      const dismissedRef = React.useRef(false)
      /** Latest eligibility, read when a response arrives. */
      const eligibleRef = React.useRef(false)
      /** Session identity this component instance was last reconciled for. */
      const lastSessionIdRef = React.useRef(sessionId)

      // ── Derived state ────────────────────────────────────────────────────
      const sessionKnown = session !== null && session !== undefined
      const inputKnown = input !== null && input !== undefined
      const running = sessionKnown && session.running === true
      const idle = sessionKnown && session.running === false
      const blank = sessionKnown && session.blank === true
      const awaitingFirstTurn = sessionKnown && session.awaitingFirstTurn === true
      const draft = inputKnown && typeof input.draft === 'string' ? input.draft : null
      const phase = inputKnown ? input.phase : null
      const attachmentCount = inputKnown && Array.isArray(input.attachmentIds)
        ? input.attachmentIds.length
        : -1
      const eligible = idle
        && blank === false
        && awaitingFirstTurn === false
        && draft === ''
        && phase === 'plain'
        && attachmentCount === 0
      const visible = suggestion !== null && eligible && composing === false
      eligibleRef.current = eligible

      // ── Request machinery ───────────────────────────────────────────────
      function cancelInFlight() {
        generationRef.current += 1
        const controller = abortRef.current
        abortRef.current = null
        if (controller !== null && controller !== undefined) {
          try {
            controller.abort()
          } catch (error) {
            /* ignore */
          }
        }
      }

      function startRequest() {
        if (typeof waitForSuggestion !== 'function') return
        const generation = generationRef.current + 1
        generationRef.current = generation
        let controller = null
        try {
          controller = typeof AbortController === 'function' ? new AbortController() : null
        } catch (error) {
          controller = null
        }
        abortRef.current = controller
        let timer = null
        try {
          timer = setTimeout(function onRequestTimeout() {
            try {
              if (controller !== null) controller.abort()
            } catch (error) {
              /* ignore */
            }
          }, REQUEST_TIMEOUT_MS)
          if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
        } catch (error) {
          timer = null
        }
        const signal = controller === null ? undefined : controller.signal
        Promise.resolve()
          .then(function requestSuggestion() {
            return waitForSuggestion({ sessionId: sessionId }, signal)
          })
          .then(function adoptSuggestion(value) {
            if (generation !== generationRef.current) return
            if (value === null || value === undefined) return
            const text = typeof value.suggestion === 'string' ? value.suggestion.trim() : ''
            if (text === '') return
            const nextTurn = typeof value.turn === 'number' ? value.turn : null
            cacheRef.current = { sessionId: sessionId, turn: nextTurn, suggestion: text }
            if (!eligibleRef.current || dismissedRef.current) return
            setSuggestion(text)
            setTurn(nextTurn)
          })
          .catch(function ignoreSuggestionFailure() {
            /* transport / business failure: stay silent */
          })
          .then(function releaseRequest() {
            if (timer !== null) {
              try {
                clearTimeout(timer)
              } catch (error) {
                /* ignore */
              }
              timer = null
            }
            if (abortRef.current === controller) abortRef.current = null
          })
      }

      // ── Accept / dismiss ─────────────────────────────────────────────────
      /**
       * Write the suggestion into the composer as an editable draft.
       * Uses the version-guarded insertion pair when available, and only
       * falls back to a whole-draft replacement when they are absent.
       */
      function writeDraft(text) {
        const actions = inputActions
        if (actions === null || actions === undefined) return false
        try {
          if (typeof actions.captureInsertion === 'function' && typeof actions.insertText === 'function') {
            const span = actions.captureInsertion()
            return actions.insertText(text, span) === true
          }
          if (typeof actions.setDraft === 'function') {
            actions.setDraft(text)
            return true
          }
        } catch (error) {
          return false
        }
        return false
      }

      function dismissCurrent() {
        if (typeof dismissSuggestion !== 'function') return
        const payload = { sessionId: sessionId }
        if (typeof turn === 'number') payload.turn = turn
        try {
          const pending = dismissSuggestion(payload)
          if (pending !== null && pending !== undefined && typeof pending.catch === 'function') {
            pending.catch(function ignoreDismissFailure() {
              /* fire-and-forget */
            })
          }
        } catch (error) {
          /* fire-and-forget */
        }
      }

      function accept() {
        if (suggestion === null || !eligible || composing) return false
        const text = suggestion
        if (!writeDraft(text)) return false
        cacheRef.current = null
        dismissedRef.current = false
        try {
          if (typeof focusComposer === 'function') focusComposer()
        } catch (error) {
          /* focus is best-effort */
        }
        dismissCurrent()
        setSuggestion(null)
        setTurn(null)
        return true
      }

      function close() {
        if (suggestion === null) return false
        cacheRef.current = null
        dismissedRef.current = true
        dismissCurrent()
        setSuggestion(null)
        setTurn(null)
        return true
      }

      // ── State machine (one request per idle epoch) ───────────────────────
      React.useEffect(function syncSuggestionState() {
        if (lastSessionIdRef.current !== sessionId) {
          lastSessionIdRef.current = sessionId
          requestedRef.current = false
          cacheRef.current = null
          dismissedRef.current = false
          cancelInFlight()
          if (suggestion !== null) {
            setSuggestion(null)
            setTurn(null)
          }
          return
        }
        if (running) {
          // A turn started: this epoch is over; the next idle edge may ask again.
          requestedRef.current = false
          cacheRef.current = null
          dismissedRef.current = false
          cancelInFlight()
          if (suggestion !== null) {
            setSuggestion(null)
            setTurn(null)
          }
          return
        }
        if (!eligible) {
          // Draft / attachments / busy phase: hide (and cancel); no dismiss call.
          cancelInFlight()
          if (suggestion !== null) {
            setSuggestion(null)
            setTurn(null)
          }
          return
        }
        if (!requestedRef.current) {
          requestedRef.current = true
          startRequest()
          return
        }
        const cached = cacheRef.current
        if (suggestion === null && dismissedRef.current === false
          && cached !== null && cached.sessionId === sessionId) {
          // Same turn, draft cleared again: re-show without a second RPC.
          setSuggestion(cached.suggestion)
          setTurn(cached.turn)
        }
      }, [sessionId, running, eligible])

      // ── IME composition tracking (document-level, composer-scoped) ───────
      React.useEffect(function trackComposition() {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        let graceTimer = null
        function clearGrace() {
          if (graceTimer !== null) {
            try {
              clearTimeout(graceTimer)
            } catch (error) {
              /* ignore */
            }
            graceTimer = null
          }
        }
        function onCompositionStart(event) {
          if (!isInsideComposer(event === null || event === undefined ? undefined : event.target)) return
          clearGrace()
          setComposing(true)
        }
        function onCompositionEnd(event) {
          if (!isInsideComposer(event === null || event === undefined ? undefined : event.target)) return
          clearGrace()
          try {
            graceTimer = setTimeout(function endCompositionGrace() {
              graceTimer = null
              setComposing(false)
            }, COMPOSITION_GRACE_MS)
            if (typeof graceTimer === 'object' && graceTimer !== null && typeof graceTimer.unref === 'function') {
              graceTimer.unref()
            }
          } catch (error) {
            graceTimer = null
            setComposing(false)
          }
        }
        document.addEventListener('compositionstart', onCompositionStart, true)
        document.addEventListener('compositionend', onCompositionEnd, true)
        return function stopCompositionTracking() {
          document.removeEventListener('compositionstart', onCompositionStart, true)
          document.removeEventListener('compositionend', onCompositionEnd, true)
          clearGrace()
        }
      }, [])

      // ── Keyboard bridge: hand the live bar to the apply-owned listener ───
      React.useEffect(function publishKeyboardBar() {
        if (typeof activateBar !== 'function') return undefined
        return activateBar({
          sessionId: sessionId,
          isVisible: function isBarVisible() {
            return visible && composing === false
          },
          accept: function acceptFromKeyboard() {
            return accept()
          },
          close: function closeFromKeyboard() {
            return close()
          },
        })
      })

      // ── Unmount: never leave a transport request alive ───────────────────
      React.useEffect(function stopOnUnmount() {
        return function cleanupRequests() {
          cancelInFlight()
        }
      }, [])

      if (!visible) return null
      const translate = typeof t === 'function' ? t : identityTranslate
      function onAcceptClick(event) {
        if (event !== null && event !== undefined && typeof event.preventDefault === 'function') {
          try {
            event.preventDefault()
          } catch (error) {
            /* ignore */
          }
        }
        accept()
      }
      function onCloseClick(event) {
        if (event !== null && event !== undefined && typeof event.preventDefault === 'function') {
          try {
            event.preventDefault()
          } catch (error) {
            /* ignore */
          }
        }
        close()
      }
      return h('div', {
        key: 'followup-prompt',
        role: 'status',
        'aria-live': 'polite',
        'aria-label': translate('prediction.statusAria'),
        'data-followup-prompt': '',
        style: styles.bar,
      },
        h('style', { key: 'styles' }, CSS_TEXT),
        h('span', { key: 'glyph', style: styles.glyph, 'aria-hidden': 'true' }, '\u2726'),
        h('span', { key: 'prefix', style: styles.prefix }, translate('prediction.prefix')),
        h('button', {
          key: 'accept',
          type: 'button',
          className: 'fup-accept',
          style: styles.accept,
          title: translate('prediction.acceptAria'),
          'aria-label': translate('prediction.acceptAria'),
          onMouseDown: preventFocusLoss,
          onClick: onAcceptClick,
        }, suggestion),
        h('span', { key: 'hint', style: styles.hint },
          h('kbd', { key: 'kbd', style: styles.kbd }, 'Tab'),
          h('span', { key: 'hintText' }, translate('prediction.acceptHint')),
        ),
        h('button', {
          key: 'close',
          type: 'button',
          className: 'fup-close',
          style: styles.close,
          title: translate('prediction.dismissAria'),
          'aria-label': translate('prediction.dismissAria'),
          onMouseDown: preventFocusLoss,
          onClick: onCloseClick,
        }, '\u00d7'),
      )
    }

    // ── Apply (plugin body) ────────────────────────────────────────────────
    /**
     * Install dictionaries, the compositor keyboard/IME guards, and the dock
     * entry. All registrations ride the plugin fiber's effect lifetime.
     * @param ctx - Client Cordis context.
     */
    function apply(ctx) {
      /** The mounted bar (at most one visible composer); set by the component. */
      const barBridge = { current: null }

      function activateBar(handle) {
        barBridge.current = handle
        return function deactivateBar() {
          if (barBridge.current === handle) barBridge.current = null
        }
      }

      /**
       * POST one endpoint to the Host's exact Fetch route and unwrap the
       * `{ok:true,value}` envelope. Every failure (missing fetch, non-OK HTTP,
       * thrown/aborted request, malformed JSON, `{ok:false}`) resolves to
       * `null`, so callers stay silent by construction.
       * @param {string} endpoint - channel endpoint, e.g. `suggestions/wait`.
       * @param {object} payload - endpoint payload.
       * @param {AbortSignal|undefined} signal - request cancellation.
       * @returns {Promise<unknown|null>} the envelope value, or null.
       */
      async function call(endpoint, payload, signal) {
        if (typeof fetch !== 'function') return null
        let response
        try {
          const init = {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint: endpoint, payload: payload === undefined ? null : payload }),
          }
          if (signal !== undefined) init.signal = signal
          // Relative URL on purpose: resolves under any mount prefix (ds-bot's `api/bot`).
          response = await fetch('api/followup-prompt/rpc', init)
        } catch (error) {
          return null
        }
        if (response === null || response === undefined || response.ok !== true) return null
        let envelope
        try {
          envelope = await response.json()
        } catch (error) {
          return null
        }
        if (envelope === null || envelope === undefined || typeof envelope !== 'object') return null
        if (envelope.ok !== true) return null
        return envelope.value
      }

      /**
       * Long-poll the Host for this turn's prediction.
       * @returns `{suggestion, turn, reason?}` or null for every failure.
       */
      async function waitForSuggestion(payload, signal) {
        const value = await call('suggestions/wait', payload, signal)
        if (value === null || value === undefined || typeof value !== 'object') return null
        const suggestion = typeof value.suggestion === 'string' ? value.suggestion.trim() : ''
        if (suggestion === '') return null
        const resolved = {
          suggestion: suggestion,
          turn: typeof value.turn === 'number' ? value.turn : null,
        }
        if (typeof value.reason === 'string') resolved.reason = value.reason
        return resolved
      }

      /** Fire-and-forget invalidation for the current turn (never throws). */
      function dismissSuggestion(payload) {
        return call('suggestions/dismiss', payload, undefined).catch(function ignoreDismissFailure() {
          /* fire-and-forget */
        })
      }

      /**
       * Best-effort keyboard return to the composer (used by click accept).
       * Feature-detected: the conversation service is optional here.
       */
      function focusComposer(sessionId) {
        try {
          const sessions = ctx.sessions !== undefined && ctx.sessions !== null
            ? ctx.sessions
            : (typeof ctx.get === 'function' ? ctx.get('sessions') : undefined)
          if (sessions === null || sessions === undefined) return
          const binding = typeof sessions.binding === 'function' ? sessions.binding(sessionId) : undefined
          let actx = binding === null || binding === undefined ? undefined : binding.ctx
          if (actx === undefined && typeof sessions.scope === 'function') actx = sessions.scope(sessionId)
          if (actx === undefined || actx === null) return
          let conversation = typeof actx.get === 'function' ? actx.get('conversation') : undefined
          if (conversation === undefined || conversation === null) {
            conversation = typeof ctx.get === 'function' ? ctx.get('conversation') : undefined
          }
          if (conversation === null || conversation === undefined) return
          const input = conversation.input
          if (input === null || input === undefined || typeof input.for !== 'function') return
          const facade = input.for(actx)
          if (facade !== null && facade !== undefined && typeof facade.focus === 'function') facade.focus()
        } catch (error) {
          /* focus is best-effort */
        }
      }

      // Tab accepts / Escape closes only when the suggestion bar is the
      // authoritative gesture target: capture phase so Lexical's TAB_COMMAND
      // never sees a consumed event, but preventDefault+stopPropagation only
      // after accept/close actually applied.
      function installKeyboardGuards() {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
          return function noop() {}
        }
        function onKeyDown(event) {
          try {
            const handle = barBridge.current
            if (handle === null || handle === undefined) return
            if (!handle.isVisible()) return
            if (isComposingEvent(event)) return
            const key = event.key
            if (key !== 'Tab' && key !== 'Escape') return
            if (event.shiftKey === true || event.altKey === true
              || event.ctrlKey === true || event.metaKey === true) return
            if (!isInsideComposer(event.target)) return
            if (hasOpenPopup()) return
            const applied = key === 'Tab' ? handle.accept() : handle.close()
            if (applied !== true) return
            if (typeof event.preventDefault === 'function') event.preventDefault()
            if (typeof event.stopPropagation === 'function') event.stopPropagation()
          } catch (error) {
            /* never break typing */
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return function uninstallKeyboardGuards() {
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }

      ctx.effect(function registerDictionaries() {
        return ctx.locale.register(NS, { en: EN, zh: ZH })
      }, NS + ': dictionaries')

      ctx.effect(installKeyboardGuards, NS + ': composer keyboard guards')

      ctx.slots.inject(SLOT, function registerSuggestionBar() {
        return ctx.slots.register({
          name: SLOT,
          id: SLOT_ID,
          order: SLOT_ORDER,
          locale: NS,
          inject: function injectBarFace(sessionId) {
            return {
              waitForSuggestion: waitForSuggestion,
              dismissSuggestion: dismissSuggestion,
              focusComposer: function focusSessionComposer() {
                focusComposer(sessionId)
              },
              activateBar: activateBar,
            }
          },
        }, FollowupSuggestionBar)
      })
    }

    return {
      inject: ['slots', 'sessions', 'locale'],
      apply: apply,
    }
  },
})
