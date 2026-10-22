// Browser half: a classic lazy-CJS script (no bundler, no JSX) that renders the prediction
// as an inline ghost in `conversation.input.overlay`. It only writes drafts, never submits.
// The `data-composer-*` attributes it relies on are DSH 0.2.1 implementation details.
window.__ModuleLoader__.load({
  id: 'dsh-followup-prompt',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'followup-prompt'
    const SLOT = 'conversation.input.overlay'
    const SLOT_ID = 'followup-prompt'
    /** Last in the overlay's additive order (menus use 0). */
    const SLOT_ORDER = 100
    /** Client-side safety net; the Host ends its long poll by `timeoutMs` (max 30s) + 2s. */
    const REQUEST_TIMEOUT_MS = 35000
    /** Safari can emit the closing keydown after compositionend; keep the gate briefly. */
    const COMPOSITION_GRACE_MS = 10
    const COMPOSER_INPUT_SELECTOR = '[data-composer-input]'
    const COMPOSER_CARD_SELECTOR = '[data-composer-card]'
    const COMPOSER_PLACEHOLDER_SELECTOR = '[data-composer-placeholder]'
    /** Font properties cloned from the editor so the ghost reads as its first line. */
    const FONT_KEYS = ['fontFamily', 'fontSize', 'lineHeight', 'fontWeight', 'fontStyle', 'letterSpacing']
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

    // `meta.*` mirrors locale/*.json.
    const EN = {
      'meta.title': 'Followup Prompt',
      'meta.description': 'Predicts your next message after each reply and shows it inside the empty composer as an editable draft. Press Tab to accept; it never sends by itself.',
      'prediction.statusAria': 'Predicted next message',
    }
    const ZH = {
      'meta.title': '后续提示',
      'meta.description': '每轮回复结束后预测你的下一条消息，并在空输入框内显示为可编辑草稿。按 Tab 接受，绝不自动发送。',
      'prediction.statusAria': '预测的下一条消息',
    }

    // Theme alias tokens only, so light and dark both resolve through the theme.
    const styles = {
      // Fully click-through, so typing and caret placement still work.
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
    }

    const CSS_TEXT = [
      '@keyframes fup-fade-in { from { opacity: 0; } to { opacity: 1; } }',
      '@media (prefers-reduced-motion: no-preference) {',
      '  [data-followup-prompt] { animation: fup-fade-in 120ms ease-out; }',
      '}',
    ].join('\n')

    /** Identity selector: the published snapshots are stable references. */
    function selectSnapshot(snapshot) {
      return snapshot
    }

    function isInsideComposer(target) {
      return target instanceof Element && target.closest(COMPOSER_INPUT_SELECTOR) !== null
    }

    function findComposerCard(root) {
      return root?.closest(COMPOSER_CARD_SELECTOR) ?? document.querySelector(COMPOSER_CARD_SELECTOR)
    }

    // A visible slash/command menu owns Tab/Escape; mounted-but-hidden menus do not count.
    function hasOpenPopup() {
      for (const node of document.querySelectorAll('[role="listbox"], [role="menu"]')) {
        if (node.getClientRects().length > 0) return true
      }
      return false
    }

    function isComposingEvent(event) {
      // Legacy engines signal composition with keyCode 229 while isComposing stays false.
      return event.isComposing === true || event.keyCode === 229
    }

    function sameLayout(previous, next) {
      return previous.ready
        && ['top', 'left', 'width'].every((key) => Math.abs(previous[key] - next[key]) < 0.5)
        && FONT_KEYS.every((key) => previous[key] === next[key])
    }

    function FollowupSuggestionBar(props) {
      const { sessionId, useSession, useInput, inputActions, t, waitForSuggestion, dismissSuggestion, activateBar } = props
      const session = useSession(selectSnapshot)
      const input = useInput(selectSnapshot)

      /** `{ suggestion, turn }` currently on screen, or null. */
      const [shown, setShown] = React.useState(null)
      const [composing, setComposing] = React.useState(false)
      const [ghostLayout, setGhostLayout] = React.useState(DEFAULT_GHOST_LAYOUT)
      const ghostRootRef = React.useRef(null)

      const abortRef = React.useRef(null)
      /** One request per idle epoch; reset when a new turn starts. */
      const requestedRef = React.useRef(false)
      /** This epoch's answer, re-shown when the draft is cleared again; null once accepted or closed. */
      const cacheRef = React.useRef(null)
      const eligibleRef = React.useRef(false)
      const lastSessionIdRef = React.useRef(sessionId)

      const running = session?.running === true
      const eligible = session?.running === false
        && session.blank !== true
        && session.awaitingFirstTurn !== true
        && input?.draft === ''
        && input.phase === 'plain'
        && input.attachmentIds?.length === 0
      const visible = shown !== null && eligible && !composing
      eligibleRef.current = eligible

      function measureGhostLayout() {
        const card = findComposerCard(ghostRootRef.current)
        const editor = card?.querySelector(COMPOSER_INPUT_SELECTOR)
        if (editor == null) return
        const cardRect = card.getBoundingClientRect()
        const editorRect = editor.getBoundingClientRect()
        if (!(editorRect.width > 0)) return
        const computed = getComputedStyle(editor)
        const px = (value, fallback) => {
          const parsed = Number.parseFloat(value)
          return Number.isFinite(parsed) ? parsed : fallback
        }
        const paddingLeft = px(computed.paddingLeft, 14)
        const paddingRight = px(computed.paddingRight, 8)
        const next = {
          ready: true,
          top: editorRect.top - cardRect.top + px(computed.paddingTop, 4),
          left: editorRect.left - cardRect.left + paddingLeft,
          width: Math.max(0, editorRect.width - paddingLeft - paddingRight - 4),
        }
        for (const key of FONT_KEYS) next[key] = computed[key] || DEFAULT_GHOST_LAYOUT[key]
        setGhostLayout((previous) => (sameLayout(previous, next) ? previous : next))
      }

      function cancelInFlight() {
        abortRef.current?.abort()
        abortRef.current = null
      }

      function startRequest() {
        const controller = new AbortController()
        abortRef.current = controller
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        waitForSuggestion({ sessionId }, signal).then((value) => {
          if (abortRef.current === controller) abortRef.current = null
          // A cancelled request belongs to an older epoch: drop its answer.
          if (value === null || controller.signal.aborted) return
          cacheRef.current = value
          if (eligibleRef.current) setShown(value)
        })
      }

      function writeDraft(text) {
        try {
          return inputActions.insertText(text, inputActions.captureInsertion()) === true
        } catch {
          return false
        }
      }

      function retire() {
        cacheRef.current = null
        dismissSuggestion({ sessionId, turn: shown.turn })
        setShown(null)
      }

      function accept() {
        if (!visible || !writeDraft(shown.suggestion)) return false
        retire()
        return true
      }

      function close() {
        if (!visible) return false
        retire()
        return true
      }

      React.useEffect(function syncSuggestionState() {
        if (lastSessionIdRef.current !== sessionId || running) {
          // A new session or turn starts a new epoch: the next idle edge may ask again.
          lastSessionIdRef.current = sessionId
          requestedRef.current = false
          cacheRef.current = null
          setShown(null)
        }
        if (!eligible) {
          // Draft / attachments / busy phase: hide (and cancel); no dismiss call.
          cancelInFlight()
          setShown(null)
          return
        }
        if (!requestedRef.current) {
          requestedRef.current = true
          cancelInFlight()
          startRequest()
        } else if (cacheRef.current !== null) {
          // Same turn, draft cleared again: re-show without a second RPC.
          setShown(cacheRef.current)
        }
      }, [sessionId, running, eligible])

      React.useEffect(function trackComposition() {
        let graceTimer
        function onCompositionStart(event) {
          if (!isInsideComposer(event.target)) return
          clearTimeout(graceTimer)
          setComposing(true)
        }
        function onCompositionEnd(event) {
          if (!isInsideComposer(event.target)) return
          clearTimeout(graceTimer)
          graceTimer = setTimeout(() => setComposing(false), COMPOSITION_GRACE_MS)
        }
        document.addEventListener('compositionstart', onCompositionStart, true)
        document.addEventListener('compositionend', onCompositionEnd, true)
        return function stopCompositionTracking() {
          document.removeEventListener('compositionstart', onCompositionStart, true)
          document.removeEventListener('compositionend', onCompositionEnd, true)
          clearTimeout(graceTimer)
        }
      }, [])

      React.useEffect(function publishKeyboardBar() {
        // Session-scoped overlays can stay mounted for more than one composer;
        // only the visible ghost may claim the Tab/Escape gesture.
        if (!visible) return undefined
        return activateBar({ accept, close })
      })

      // The ghost stands where the native placeholder would be: place it from the
      // editor's real geometry and hide the placeholder in the same layout pass, so
      // the two never overlap for a frame.
      React.useLayoutEffect(function placeInlineGhost() {
        if (!visible) return undefined
        measureGhostLayout()
        let frame = null
        const schedule = () => {
          if (frame !== null) return
          frame = requestAnimationFrame(() => {
            frame = null
            measureGhostLayout()
          })
        }
        window.addEventListener('resize', schedule)
        const card = findComposerCard(ghostRootRef.current)
        const observer = card == null ? null : new ResizeObserver(schedule)
        observer?.observe(card)
        const placeholder = card?.querySelector(COMPOSER_PLACEHOLDER_SELECTOR)
        const previousVisibility = placeholder?.style.visibility
        if (placeholder != null) placeholder.style.visibility = 'hidden'
        return function cleanupPlacement() {
          window.removeEventListener('resize', schedule)
          if (frame !== null) cancelAnimationFrame(frame)
          observer?.disconnect()
          if (placeholder != null) placeholder.style.visibility = previousVisibility
        }
      }, [visible, sessionId])

      React.useEffect(function stopOnUnmount() {
        return cancelInFlight
      }, [])

      if (!visible) return null
      const { ready, top, left, width, ...font } = ghostLayout
      const ghostStyle = {
        ...styles.ghost,
        ...font,
        top,
        left,
        width: ready ? Math.max(24, width) : 'calc(100% - 32px)',
      }
      return h('div', {
        key: 'followup-prompt',
        ref: ghostRootRef,
        role: 'status',
        'aria-live': 'polite',
        'aria-label': t('prediction.statusAria'),
        'data-followup-prompt': '',
        style: styles.root,
      },
        h('style', { key: 'styles' }, CSS_TEXT),
        h('span', { key: 'ghost', style: ghostStyle }, shown.suggestion),
      )
    }

    function apply(ctx) {
      const barBridge = { current: null }

      function activateBar(handle) {
        barBridge.current = handle
        return function deactivateBar() {
          if (barBridge.current === handle) barBridge.current = null
        }
      }

      /** Every failure (transport, non-200, bad JSON, `ok: false`) resolves to null: callers stay silent. */
      async function call(endpoint, payload, signal) {
        try {
          // Relative URL on purpose: resolves under any mount prefix (ds-bot's `api/bot`).
          const response = await fetch('api/followup-prompt/rpc', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint, payload }),
            signal,
          })
          if (!response.ok) return null
          const envelope = await response.json()
          return envelope?.ok === true ? envelope.value : null
        } catch {
          return null
        }
      }

      async function waitForSuggestion(payload, signal) {
        const value = await call('suggestions/wait', payload, signal)
        const suggestion = typeof value?.suggestion === 'string' ? value.suggestion.trim() : ''
        if (suggestion === '') return null
        return { suggestion, turn: Number.isInteger(value.turn) ? value.turn : undefined }
      }

      function dismissSuggestion(payload) {
        return call('suggestions/dismiss', payload)
      }

      // Tab accepts / Escape closes only when the suggestion bar is the
      // authoritative gesture target: capture phase so Lexical's TAB_COMMAND
      // never sees a consumed event, but preventDefault+stopPropagation only
      // after accept/close actually applied.
      function installKeyboardGuards() {
        function onKeyDown(event) {
          try {
            const handle = barBridge.current
            if (handle === null || isComposingEvent(event)) return
            if (event.key !== 'Tab' && event.key !== 'Escape') return
            if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
            if (!isInsideComposer(event.target) || hasOpenPopup()) return
            const applied = event.key === 'Tab' ? handle.accept() : handle.close()
            if (!applied) return
            event.preventDefault()
            event.stopPropagation()
          } catch {
            /* never break typing */
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return function uninstallKeyboardGuards() {
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }

      const face = { waitForSuggestion, dismissSuggestion, activateBar }

      ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), NS + ': dictionaries')

      ctx.effect(installKeyboardGuards, NS + ': composer keyboard guards')

      ctx.effect(() => ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: SLOT_ID,
        order: SLOT_ORDER,
        locale: NS,
        inject: () => face,
      }, FollowupSuggestionBar)), NS + ': composer ghost entry')
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
