/**
 * Followup Prompt — Client (browser) half of the `dsh-followup-prompt` bundle.
 *
 * Lazy-CJS plugin loaded through `window.__ModuleLoader__` (no bundler, no JSX):
 * the browser module table hands us React, and we contribute one inline ghost
 * inside the composer card through the `conversation.input.overlay` slot. The
 * ghost renders the next-user-message prediction the Host generated for the
 * latest completed turn where the empty draft's placeholder would be; Tab
 * accepts it into the composer as an editable draft. It never sends, and
 * every failure/state change degrades to "render nothing".
 *
 * Contract sources verified against DSH 0.2.1-rc.2:
 * - module registration: packages/client/modules/src/client/manifest.ts
 * - slots: packages/client/ui-slots/src/index.ts + ui-renderer/src/client/registry.ts
 *   (`conversation.input.overlay` is a floating session-scope list slot inside
 *   the composer card; third-party entries register via ctx.slots.inject/register)
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
 *   keymap.ts sets `data-composer-composing`. The inline ghost measures that
 *   element (rect + computed font/padding) so it sits exactly where typed text
 *   starts, and temporarily hides `[data-composer-placeholder]` while shown
 *   (restoring it on hide/unmount), following the plan's P2 calibration note.
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
    const SLOT = 'conversation.input.overlay'
    const SLOT_ID = 'followup-prompt'
    /** Last in the overlay's additive order (menus use 0). */
    const SLOT_ORDER = 100
    /** Client-side safety net; the Host bounds its own long poll well below this. */
    const REQUEST_TIMEOUT_MS = 20000
    /** Safari can emit the closing keydown after compositionend; keep the gate briefly. */
    const COMPOSITION_GRACE_MS = 10
    /** The composer editor host's published DOM attributes (accept + alignment gates). */
    const COMPOSER_INPUT_SELECTOR = '[data-composer-input]'
    const COMPOSER_CARD_SELECTOR = '[data-composer-card]'
    const COMPOSER_PLACEHOLDER_SELECTOR = '[data-composer-placeholder]'
    /** Ghost geometry before the first real measurement (card-relative px). */
    const DEFAULT_GHOST_LAYOUT = Object.freeze({
      ready: false,
      top: 12,
      left: 14,
      width: 0,
      fontFamily: 'inherit',
      fontSize: '14px',
      lineHeight: '22px',
      fontWeight: '400',
      fontStyle: 'normal',
      letterSpacing: 'normal',
    })
    /** Room reserved for the Tab hint + close button at the ghost line's right. */
    const GHOST_HINT_RESERVE_PX = 118
    /** Layout effects must run before paint; fall back on React builds without one. */
    const useIsoLayoutEffect = typeof React.useLayoutEffect === 'function'
      ? React.useLayoutEffect
      : React.useEffect

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
      // Zero-height overlay host anchored at the composer card's top-left. The
      // real position comes from `measureGhostLayout`; children are
      // click-through except the tiny close button so typing/carets still work.
      root: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: 0,
        pointerEvents: 'none',
        zIndex: 2,
      },
      ghost: {
        position: 'absolute',
        boxSizing: 'border-box',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        pointerEvents: 'none',
        userSelect: 'none',
        opacity: 0.58,
        color: 'var(--dsw-alias-label-secondary, currentColor)',
      },
      hint: {
        position: 'absolute',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        pointerEvents: 'none',
        color: 'var(--dsw-alias-label-secondary, currentColor)',
        fontFamily: 'inherit',
        fontSize: '11px',
        lineHeight: '16px',
        whiteSpace: 'nowrap',
      },
      kbd: {
        fontFamily: 'inherit',
        fontSize: '11px',
        lineHeight: '16px',
        padding: '0 5px',
        borderRadius: '5px',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.18))',
        background: 'var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.08))',
        color: 'var(--dsw-alias-label-secondary, currentColor)',
      },
      close: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '18px',
        height: '18px',
        padding: 0,
        border: 'none',
        borderRadius: '999px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, currentColor)',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '1',
        cursor: 'pointer',
        pointerEvents: 'auto',
      },
    }

    const CSS_TEXT = [
      '[data-followup-prompt] button { font-family: inherit; }',
      '[data-followup-prompt] .fup-close:hover {',
      '  color: var(--dsw-alias-label-primary, currentColor);',
      '  background: var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.10));',
      '}',
      '[data-followup-prompt] .fup-close:focus-visible { outline-offset: 1px; }',
      '@keyframes fup-fade-in { from { opacity: 0; } to { opacity: 1; } }',
      '@media (prefers-reduced-motion: no-preference) {',
      '  [data-followup-prompt] { animation: fup-fade-in 120ms ease-out; }',
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
     * Inline next-message ghost, mounted as one floating entry inside
     * `conversation.input.overlay` for the current Session. It is positioned at
     * the real editor origin and visually replaces the empty draft's
     * placeholder, so it reads as typed-but-not-yet-committed text.
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
      /** Measured editor geometry for the inline ghost (card-relative px). */
      const [ghostLayout, setGhostLayout] = React.useState(DEFAULT_GHOST_LAYOUT)
      /** Ghost overlay host, used to find the composer card and return focus. */
      const ghostRootRef = React.useRef(null)

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

      /**
       * Measure the composer card and its editor, then store card-relative
       * geometry for the ghost: the editable element's real text origin,
       * available width, and the editor's computed font. Defensive on every
       * DOM capability so a test renderer or a future layout change degrades to
       * the default geometry instead of throwing.
       * @returns {void}
       */
      function measureGhostLayout() {
        if (typeof document === 'undefined') return
        const root = ghostRootRef.current
        if (root === null || root === undefined) return
        let card = null
        try {
          if (typeof root.closest === 'function') card = root.closest(COMPOSER_CARD_SELECTOR)
          if (card === null && typeof document.querySelector === 'function') {
            card = document.querySelector(COMPOSER_CARD_SELECTOR)
          }
        } catch (error) {
          card = null
        }
        if (card === null || card === undefined || typeof card.querySelector !== 'function') return
        let input = null
        try {
          input = card.querySelector(COMPOSER_INPUT_SELECTOR)
        } catch (error) {
          input = null
        }
        if (input === null || typeof input.getBoundingClientRect !== 'function'
          || typeof card.getBoundingClientRect !== 'function') return
        let cardRect
        let inputRect
        try {
          cardRect = card.getBoundingClientRect()
          inputRect = input.getBoundingClientRect()
        } catch (error) {
          return
        }
        if (cardRect === null || inputRect === null) return
        if (typeof inputRect.width !== 'number' || !(inputRect.width > 0)) return
        let computed = null
        try {
          computed = typeof getComputedStyle === 'function' ? getComputedStyle(input) : null
        } catch (error) {
          computed = null
        }
        const toPx = (value, fallback) => {
          const parsed = Number.parseFloat(value)
          return Number.isFinite(parsed) ? parsed : fallback
        }
        const paddingLeft = computed === null ? 14 : toPx(computed.paddingLeft, 14)
        const paddingRight = computed === null ? 8 : toPx(computed.paddingRight, 8)
        const paddingTop = computed === null ? 4 : toPx(computed.paddingTop, 4)
        const next = {
          ready: true,
          top: inputRect.top - cardRect.top + paddingTop,
          left: inputRect.left - cardRect.left + paddingLeft,
          width: Math.max(0, inputRect.width - paddingLeft - paddingRight - 4),
          fontFamily: (computed === null ? '' : computed.fontFamily) || 'inherit',
          fontSize: (computed === null ? '' : computed.fontSize) || 'inherit',
          lineHeight: (computed === null ? '' : computed.lineHeight) || '22px',
          fontWeight: (computed === null ? '' : computed.fontWeight) || '400',
          fontStyle: (computed === null ? '' : computed.fontStyle) || 'normal',
          letterSpacing: (computed === null ? '' : computed.letterSpacing) || 'normal',
        }
        setGhostLayout(function keepStableLayout(previous) {
          const same = previous.ready === true
            && Math.abs(previous.top - next.top) < 0.5
            && Math.abs(previous.left - next.left) < 0.5
            && Math.abs(previous.width - next.width) < 0.5
            && previous.fontFamily === next.fontFamily
            && previous.fontSize === next.fontSize
            && previous.lineHeight === next.lineHeight
            && previous.fontWeight === next.fontWeight
            && previous.fontStyle === next.fontStyle
            && previous.letterSpacing === next.letterSpacing
          return same ? previous : next
        })
      }

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

      // ── Inline ghost placement: measure before paint + follow resizes ────
      useIsoLayoutEffect(function placeInlineGhost() {
        if (!visible) return undefined
        measureGhostLayout()
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        let frame = null
        const schedule = function scheduleMeasure() {
          if (frame !== null) return
          if (typeof requestAnimationFrame === 'function') {
            frame = requestAnimationFrame(function remeasure() {
              frame = null
              measureGhostLayout()
            })
          } else {
            frame = setTimeout(function remeasureLater() {
              frame = null
              measureGhostLayout()
            }, 16)
          }
        }
        window.addEventListener('resize', schedule)
        let observer = null
        try {
          if (typeof ResizeObserver === 'function' && ghostRootRef.current !== null) {
            const root = ghostRootRef.current
            const card = typeof root.closest === 'function'
              ? root.closest(COMPOSER_CARD_SELECTOR)
              : null
            if (card !== null) {
              observer = new ResizeObserver(schedule)
              observer.observe(card)
            }
          }
        } catch (error) {
          observer = null
        }
        return function cleanupPlacement() {
          window.removeEventListener('resize', schedule)
          if (frame !== null) {
            try {
              if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
              else clearTimeout(frame)
            } catch (error) {
              /* ignore */
            }
            frame = null
          }
          if (observer !== null) {
            try {
              observer.disconnect()
            } catch (error) {
              /* ignore */
            }
          }
        }
      }, [visible, sessionId])

      // The ghost stands where the native placeholder would be; hide that
      // placeholder while shown and restore its inline value on hide/unmount.
      React.useEffect(function hideNativePlaceholder() {
        if (!visible || typeof document === 'undefined') return undefined
        let placeholder = null
        try {
          const root = ghostRootRef.current
          let card = root !== null && typeof root !== 'undefined' && typeof root.closest === 'function'
            ? root.closest(COMPOSER_CARD_SELECTOR)
            : null
          if (card === null && typeof document.querySelector === 'function') {
            card = document.querySelector(COMPOSER_CARD_SELECTOR)
          }
          placeholder = card !== null && typeof card.querySelector === 'function'
            ? card.querySelector(COMPOSER_PLACEHOLDER_SELECTOR)
            : null
        } catch (error) {
          placeholder = null
        }
        if (placeholder === null || placeholder === undefined || placeholder.style === undefined) return undefined
        const target = placeholder.style
        const previous = target.visibility
        target.visibility = 'hidden'
        return function restoreNativePlaceholder() {
          target.visibility = previous
        }
      }, [visible, sessionId])

      // ── Unmount: never leave a transport request alive ───────────────────
      React.useEffect(function stopOnUnmount() {
        return function cleanupRequests() {
          cancelInFlight()
        }
      }, [])

      if (!visible) return null
      const translate = typeof t === 'function' ? t : identityTranslate
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
      const lineHeight = ghostLayout.ready ? ghostLayout.lineHeight : DEFAULT_GHOST_LAYOUT.lineHeight
      const ghostTop = ghostLayout.ready ? ghostLayout.top : DEFAULT_GHOST_LAYOUT.top
      const ghostLeft = ghostLayout.ready ? ghostLayout.left : DEFAULT_GHOST_LAYOUT.left
      const ghostWidth = ghostLayout.ready
        ? Math.max(24, ghostLayout.width - GHOST_HINT_RESERVE_PX)
        : undefined
      const ghostStyle = {
        ...styles.ghost,
        top: ghostTop,
        left: ghostLeft,
        width: ghostWidth === undefined ? 'calc(100% - 150px)' : ghostWidth,
        lineHeight,
        fontFamily: ghostLayout.fontFamily,
        fontSize: ghostLayout.fontSize,
        fontWeight: ghostLayout.fontWeight,
        fontStyle: ghostLayout.fontStyle,
        letterSpacing: ghostLayout.letterSpacing,
      }
      const hintStyle = { ...styles.hint, top: ghostTop, right: 8, height: lineHeight }
      return h('div', {
        key: 'followup-prompt',
        ref: ghostRootRef,
        role: 'status',
        'aria-live': 'polite',
        'aria-label': translate('prediction.statusAria'),
        'data-followup-prompt': '',
        style: styles.root,
      },
        h('style', { key: 'styles' }, CSS_TEXT),
        h('span', { key: 'ghost', 'aria-hidden': 'true', style: ghostStyle }, suggestion),
        h('span', { key: 'hint', style: hintStyle },
          h('kbd', { key: 'kbd', style: styles.kbd }, 'Tab'),
          h('span', { key: 'hintText' }, translate('prediction.acceptHint')),
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
        ),
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
