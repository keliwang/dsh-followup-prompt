// Browser half: a classic lazy-CJS script (no bundler, no JSX) that renders the prediction
// as an inline ghost in `conversation.input.overlay` and edits this row's configuration on
// the Plugins page. It only writes drafts, never submits.
// The `data-composer-*` attributes it relies on are DSH 0.2.1 implementation details.
window.__ModuleLoader__.load({
  id: 'dsh-followup-prompt',
  factory(require) {
    const React = require('react')
    // Baseline client modules: the settings frame and controls every plugin page shares.
    const { Button, SettingsForm, Tag } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    const NS = 'followup-prompt'
    const SLOT = 'conversation.input.overlay'
    const SLOT_ID = 'followup-prompt'
    /** Last in the overlay's additive order (menus use 0). */
    const SLOT_ORDER = 100
    /** The Plugins page's per-row configure seat, keyed by `<package name>#<row id>`. */
    const CONFIG_SLOT = 'plugins.row.config'
    const CONFIG_KEY = 'dsh-followup-prompt#followup-prompt'
    /** The combined provider/model control on the configuration page. */
    const MODEL_ROUTE_ID = 'followup-config-model'
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
      'config.summary': 'Prediction settings: model route and limits.',
      'config.loading': 'Loading configuration…',
      'config.unavailable': 'This configuration is not available in the current deployment.',
      'config.intro': 'Saving writes this row’s configuration to the active profile patch and applies it without a restart. The row switch on the plugin page disables or enables the whole plugin.',
      'config.overridden': 'Overridden',
      'config.reset': 'Reset',
      'config.save': 'Save',
      'config.saving': 'Saving…',
      'config.saveFailed': 'The save did not apply. Reload the page or try again.',
      'config.readOnly': 'This row’s configuration is read-only in the current profile.',
      'config.invalidNumber': 'Enter a whole number in the allowed range.',
      'config.modelRoute.label': 'Model',
      'config.modelRoute.hint': 'Models come from the providers configured in DSH. The session default follows the model the session currently runs.',
      'config.modelRoute.sessionDefault': 'Session default',
      'config.modelRoute.currentGroup': 'Current configuration',
      'config.modelRoute.loading': 'Reading models from DSH…',
      'config.modelRoute.error': 'Could not read the model list from DSH.',
      'config.modelRoute.retry': 'Retry',
      'config.reasoningEffort.label': 'Reasoning effort',
      'config.reasoningEffort.hint': 'The session’s own reasoning setting is never inherited.',
      'config.reasoningEffort.modelDefault': 'Model default',
      'config.reasoningEffort.off': 'Off',
      'config.reasoningEffort.low': 'Low',
      'config.reasoningEffort.high': 'High',
      'config.reasoningEffort.max': 'Max',
      'config.maxTokens.label': 'Max output tokens',
      'config.maxTokens.hint': '1–8192, reasoning tokens included.',
      'config.timeoutMs.label': 'Timeout (ms)',
      'config.timeoutMs.hint': '2000–30000 milliseconds for one prediction.',
      'config.prompt.label': 'Custom instruction',
      'config.prompt.hint': 'Advanced: replaces the built-in prediction instruction. Leave empty for the built-in one (max 20,000 characters).',
    }
    const ZH = {
      'meta.title': '后续提示',
      'meta.description': '每轮回复结束后预测你的下一条消息，并在空输入框内显示为可编辑草稿。按 Tab 接受，绝不自动发送。',
      'prediction.statusAria': '预测的下一条消息',
      'config.summary': '预测设置：模型路由与上限。',
      'config.loading': '正在加载配置…',
      'config.unavailable': '当前部署没有提供这个配置。',
      'config.intro': '保存会把本行的配置写入当前 profile 的 patch 并立即生效，无需重启。插件页上的行开关用来停用或启用整个插件。',
      'config.overridden': '已覆盖',
      'config.reset': '重置',
      'config.save': '保存',
      'config.saving': '保存中…',
      'config.saveFailed': '保存没有生效，请刷新页面或重试。',
      'config.readOnly': '当前 profile 中本行配置为只读。',
      'config.invalidNumber': '请输入范围内的整数。',
      'config.modelRoute.label': '模型',
      'config.modelRoute.hint': '模型来自 DSH 已配置的 provider。选择「跟随当前会话」时使用会话当前的模型。',
      'config.modelRoute.sessionDefault': '跟随当前会话',
      'config.modelRoute.currentGroup': '当前配置',
      'config.modelRoute.loading': '正在从 DSH 读取模型…',
      'config.modelRoute.error': '无法从 DSH 读取模型列表。',
      'config.modelRoute.retry': '重试',
      'config.reasoningEffort.label': '推理强度',
      'config.reasoningEffort.hint': '不会跟随当前会话的推理设置。',
      'config.reasoningEffort.modelDefault': '模型默认',
      'config.reasoningEffort.off': '关闭',
      'config.reasoningEffort.low': '低',
      'config.reasoningEffort.high': '高',
      'config.reasoningEffort.max': '最高',
      'config.maxTokens.label': '输出 token 上限',
      'config.maxTokens.hint': '1–8192，推理 token 也计入。',
      'config.timeoutMs.label': '超时（毫秒）',
      'config.timeoutMs.hint': '单次预测 2000–30000 毫秒。',
      'config.prompt.label': '自定义指令',
      'config.prompt.hint': '高级：替换内置的预测指令。留空使用内置指令（最多 20,000 字符）。',
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

    // ── Plugin configuration page (Plugins → Installed → the plugin row) ────
    //
    // The page edits the row's `.volatile()` Config fields through the form
    // state the Plugins page owner supplies: `form.state` holds the Host's
    // resolved values (`value`), the inherited layer (`base`), the raw profile
    // override (`user`), the revision, and writability; `form.mutate` writes
    // staged path edits atomically. A save goes through the Host settings
    // service and ConfigEditor, which rewrites the row's config in the active
    // profile patch and updates the live `.volatile()` references in place.

    /**
     * The page's field model. JSON-compatible on purpose: `verify/package.test.mjs`
     * parses it and compares it with `FIELDS` in `host/config.js`, so the form
     * cannot silently drift from the Host schema.
     */
    const CONFIG_FIELDS = Object.freeze([
      { "key": "provider", "kind": "text", "placeholder": true },
      { "key": "model", "kind": "text", "placeholder": true },
      { "key": "reasoningEffort", "kind": "enum", "values": ["", "off", "low", "high", "max"] },
      { "key": "maxTokens", "kind": "integer", "min": 1, "max": 8192 },
      { "key": "timeoutMs", "kind": "integer", "min": 2000, "max": 30000 },
      { "key": "prompt", "kind": "text", "multiline": true, "maxLength": 20000 }
    ])

    /** The two fields the page renders as one model selector row. */
    const PROVIDER_FIELD = CONFIG_FIELDS.find((field) => field.key === 'provider')
    const MODEL_FIELD = CONFIG_FIELDS.find((field) => field.key === 'model')
    const REASONING_EFFORT_FIELD = CONFIG_FIELDS.find((field) => field.key === 'reasoningEffort')

    /** One row's staged edits relative to the Host snapshot: raw texts, typed toggles, staged clears. */
    const EMPTY_DRAFT = Object.freeze({
      texts: Object.freeze({}),
      values: Object.freeze({}),
      resets: Object.freeze({}),
    })

    // Mirrors the settings form's own chrome with theme alias tokens.
    const configStyles = {
      page: {
        display: 'flex',
        flexDirection: 'column',
      },
      intro: {
        margin: '0 0 4px',
        fontSize: '12px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-tertiary)',
      },
      row: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '12px 0',
        borderTop: '0.5px solid var(--dsw-alias-border-l2)',
      },
      firstRow: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '6px 0 12px',
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      },
      label: {
        flex: 1,
        minWidth: 0,
        fontSize: '13px',
        fontWeight: 500,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-primary)',
      },
      badges: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
      },
      control: {
        boxSizing: 'border-box',
        height: '34px',
        padding: '0 12px',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-layer-3)',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-primary)',
      },
      textarea: {
        boxSizing: 'border-box',
        minHeight: '76px',
        padding: '8px 12px',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-layer-3)',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-primary)',
        resize: 'vertical',
      },
      hint: {
        margin: 0,
        fontSize: '12px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-tertiary)',
      },
      error: {
        margin: 0,
        fontSize: '12px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-state-error-primary)',
      },
    }

    function isPlainObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    /** Immutable key removal for the staged-edit state. */
    function withoutKey(object, key) {
      if (!Object.hasOwn(object, key)) return object
      const next = { ...object }
      delete next[key]
      return next
    }

    /** Detach the form snapshot into the four values this page reads. */
    function configSnapshot(form) {
      const state = form.state
      return {
        value: isPlainObject(state.value) ? state.value : {},
        base: isPlainObject(state.base) ? state.base : {},
        user: isPlainObject(state.user) ? state.user : {},
        revision: state.revision,
        writable: state.writable === true,
      }
    }

    /** Render one stored scalar as editable text; `undefined` reads as empty. */
    function formatField(value) {
      return value === undefined || value === null ? '' : String(value)
    }

    /** Provider order shared with the harness model picker: account and official first. */
    function orderedModelGroups(groups) {
      const rank = (group) => group.id === 'deepseek-account' ? 0 : group.id === 'deepseek-official' ? 1 : 2
      return (Array.isArray(groups) ? groups : []).slice().sort((left, right) => rank(left) - rank(right))
    }

    /** One catalog model entry, when the configured route is still advertised. */
    function catalogModelOf(groups, provider, model) {
      for (const group of Array.isArray(groups) ? groups : []) {
        if (group.id !== provider) continue
        for (const entry of Array.isArray(group.models) ? group.models : []) {
          if (entry.id === model) return entry
        }
      }
      return undefined
    }

    /** Opaque option value for one provider/model pair. */
    function modelOptionValue(provider, model) {
      return JSON.stringify([provider, model])
    }

    function parseModelOptionValue(value) {
      try {
        const parsed = JSON.parse(value)
        if (Array.isArray(parsed) && parsed.length === 2
          && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
          return { provider: parsed[0], model: parsed[1] }
        }
      } catch {
        /* values are written by this page only; an unreadable one means no selection */
      }
      return null
    }

    /** The value a field shows after staged edits, or the Host value when untouched. */
    function stagedFieldValue(snapshot, draft, field) {
      const key = field.key
      if (field.kind === 'enum') {
        if (Object.hasOwn(draft.values, key)) return draft.values[key]
        if (Object.hasOwn(draft.resets, key)) return snapshot.base[key]
        return snapshot.value[key]
      }
      if (Object.hasOwn(draft.texts, key)) return draft.texts[key]
      if (Object.hasOwn(draft.resets, key)) return formatField(snapshot.base[key])
      return formatField(snapshot.value[key])
    }

    /** Whether a save would leave a user-layer entry for this field. */
    function fieldIsOverridden(snapshot, draft, field) {
      const key = field.key
      if (Object.hasOwn(draft.resets, key)) return false
      if (Object.hasOwn(draft.texts, key) || Object.hasOwn(draft.values, key)) {
        const staged = Object.hasOwn(draft.texts, key) ? draft.texts[key] : draft.values[key]
        const comparable = field.kind === 'integer' && /^-?\d+$/.test(String(staged).trim())
          ? Number(String(staged).trim())
          : staged
        // An edit that lands on the current value stages no write; keep reporting the stored state.
        return Object.is(comparable, snapshot.value[key]) ? Object.hasOwn(snapshot.user, key) : true
      }
      return Object.hasOwn(snapshot.user, key)
    }

    /** Resolve the whole staged draft into one atomic write plan with field errors. */
    function planConfigSave(snapshot, draft) {
      const errors = {}
      const desired = {}
      for (const field of CONFIG_FIELDS) {
        const key = field.key
        if (Object.hasOwn(draft.resets, key)) {
          // A staged reset clears the override whatever the field renders meanwhile.
          desired[key] = { clear: true }
          continue
        }
        if (field.kind === 'integer') {
          const text = String(stagedFieldValue(snapshot, draft, field)).trim()
          if (text === '') {
            // Empty staged text clears the override and inherits the composed default.
            desired[key] = { clear: true }
            continue
          }
          if (!/^-?\d+$/.test(text)) {
            errors[key] = 'config.invalidNumber'
            continue
          }
          const value = Number(text)
          if (!Number.isSafeInteger(value) || value < field.min || value > field.max) {
            errors[key] = 'config.invalidNumber'
            continue
          }
          desired[key] = { value }
        } else {
          // Text and enum fields stage their rendered value as-is; the
          // prompt's length is bounded by the textarea's maxLength and the Host schema.
          desired[key] = { value: stagedFieldValue(snapshot, draft, field) }
        }
      }
      const ops = []
      if (Object.keys(errors).length === 0) {
        for (const field of CONFIG_FIELDS) {
          const key = field.key
          const want = desired[key]
          if (want === undefined) continue
          if (want.clear === true) {
            if (Object.hasOwn(snapshot.user, key)) ops.push({ op: 'unset', path: [key] })
            continue
          }
          if (!Object.is(want.value, snapshot.value[key])) ops.push({ op: 'set', path: [key], value: want.value })
        }
      }
      return { ops, errors, invalid: Object.keys(errors).length > 0, dirty: ops.length > 0 }
    }

    /** One labelled control with the staged override badge and reset. */
    function ConfigRow(props) {
      const {
        id, htmlFor, label, hint, overridden, disabled, invalid, error, first,
        overriddenLabel, resetLabel, onReset, action, children,
      } = props
      const hasBadges = overridden || (action !== undefined && action !== null)
      return h('div', { style: first === true ? configStyles.firstRow : configStyles.row },
        h('div', { style: configStyles.head },
          h('label', { htmlFor, style: configStyles.label }, label),
          hasBadges
            ? h('span', { style: configStyles.badges },
              overridden ? h(Tag, { tone: 'neutral' }, overriddenLabel) : null,
              overridden ? h(Button, { variant: 'ghost', size: 'sm', disabled, onClick: onReset }, resetLabel) : null,
              action === undefined ? null : action)
            : null),
        children,
        invalid
          ? h('p', { role: 'status', style: configStyles.error }, error)
          : h('p', { style: configStyles.hint }, hint))
    }

    /** The row's configuration page: staged edits saved atomically through the Plugins page owner. */
    function FollowupConfigPage(props) {
      const { view, form, t } = props
      const [draft, setDraft] = React.useState(EMPTY_DRAFT)
      const [catalog, setCatalog] = React.useState({ status: 'loading', groups: [] })
      const catalogGeneration = React.useRef(0)

      /** Read the Host's configured model catalog; failures keep the current value visible. */
      function loadCatalog() {
        const generation = catalogGeneration.current + 1
        catalogGeneration.current = generation
        const loader = props.loadModelCatalog
        if (typeof loader !== 'function') {
          setCatalog({ status: 'error', groups: [] })
          return
        }
        setCatalog((previous) => ({ status: 'loading', groups: previous.groups }))
        Promise.resolve().then(loader).then((value) => {
          if (catalogGeneration.current !== generation) return
          setCatalog({ status: 'ready', groups: Array.isArray(value?.groups) ? value.groups : [] })
        }, () => {
          if (catalogGeneration.current !== generation) return
          setCatalog((previous) => ({ status: 'error', groups: previous.groups }))
        })
      }

      React.useEffect(function readModelCatalogOnMount() {
        if (view !== 'page') return undefined
        loadCatalog()
        return function cancelCatalogRead() { catalogGeneration.current += 1 }
      }, [view])

      if (view === 'summary') return t('config.summary')
      if (form === undefined || form === null) return h('p', { style: configStyles.hint }, t('config.unavailable'))
      const state = form.state
      if (state === undefined || state === null || state.status === 'loading') {
        return h('p', { style: configStyles.hint }, t('config.loading'))
      }
      if (state.status !== 'ready') return h('p', { style: configStyles.hint }, t('config.unavailable'))

      const snapshot = configSnapshot(form)
      const plan = planConfigSave(snapshot, draft)
      const disabled = !snapshot.writable || draft.saving === true

      function stage(update) {
        setDraft((previous) => ({ ...update(previous), saving: false, failed: false }))
      }
      function stageText(key, text) {
        stage((previous) => ({
          texts: { ...previous.texts, [key]: text },
          values: withoutKey(previous.values, key),
          resets: withoutKey(previous.resets, key),
        }))
      }
      function stageValue(key, value) {
        stage((previous) => ({
          texts: withoutKey(previous.texts, key),
          values: { ...previous.values, [key]: value },
          resets: withoutKey(previous.resets, key),
        }))
      }
      function stageModelRoute(provider, model) {
        stage((previous) => {
          const currentEffort = String(stagedFieldValue(snapshot, previous, REASONING_EFFORT_FIELD))
          const values = withoutKey(previous.values, 'reasoningEffort')
          const entry = provider === '' || model === '' ? undefined : catalogModelOf(catalog.groups, provider, model)
          let nextValues = values
          if (entry !== undefined) {
            const efforts = Array.isArray(entry.reasoning?.efforts)
              ? entry.reasoning.efforts.map((effort) => effort.id)
              : []
            // This page can express only the Config enum; an unsupported or
            // unadvertised effort falls back to the model default ('').
            if (currentEffort !== '' && !efforts.includes(currentEffort)) {
              nextValues = { ...values, reasoningEffort: '' }
            }
          }
          return {
            texts: { ...previous.texts, provider, model },
            values: nextValues,
            resets: withoutKey(withoutKey(previous.resets, 'provider'), 'model'),
          }
        })
      }
      function resetModelRoute() {
        stage((previous) => ({
          texts: withoutKey(withoutKey(previous.texts, 'provider'), 'model'),
          values: previous.values,
          resets: { ...previous.resets, provider: true, model: true },
        }))
      }
      function resetField(key) {
        stage((previous) => ({
          texts: withoutKey(previous.texts, key),
          values: withoutKey(previous.values, key),
          resets: { ...previous.resets, [key]: true },
        }))
      }
      function discard() {
        setDraft(EMPTY_DRAFT)
      }
      function commit() {
        const current = planConfigSave(snapshot, draft)
        if (current.invalid || current.ops.length === 0 || draft.saving === true) return
        setDraft((previous) => ({ ...previous, saving: true, failed: false }))
        Promise.resolve(form.mutate(current.ops, snapshot.revision)).then((accepted) => {
          setDraft(accepted === true ? EMPTY_DRAFT : ((previous) => ({ ...previous, saving: false, failed: true })))
        }, () => {
          setDraft((previous) => ({ ...previous, saving: false, failed: true }))
        })
      }

      const rows = CONFIG_FIELDS.map((field, index) => {
        const key = field.key
        // Provider and model form one selector: the Host model catalog owns the pair.
        if (key === 'model') return null
        if (key === 'provider') {
          const groups = orderedModelGroups(catalog.groups)
          const providerValue = String(stagedFieldValue(snapshot, draft, PROVIDER_FIELD))
          const modelValue = String(stagedFieldValue(snapshot, draft, MODEL_FIELD))
          const pair = providerValue === '' || modelValue === ''
            ? null
            : { provider: providerValue, model: modelValue }
          const routeOverridden = fieldIsOverridden(snapshot, draft, PROVIDER_FIELD)
            || fieldIsOverridden(snapshot, draft, MODEL_FIELD)
          const knownRoute = pair !== null && catalogModelOf(groups, pair.provider, pair.model) !== undefined
          const options = [h('option', { key: 'session', value: '' }, t('config.modelRoute.sessionDefault'))]
          for (const group of groups) {
            options.push(h('optgroup', {
              key: 'group:' + group.id,
              label: group.name ?? group.id,
            }, (Array.isArray(group.models) ? group.models : []).map((model) => h('option', {
              key: group.id + '/' + model.id,
              value: modelOptionValue(group.id, model.id),
            }, model.name ?? model.id))))
          }
          // A route that DSH no longer advertises stays visible instead of silently
          // switching the plugin to another provider's model.
          if (pair !== null && !knownRoute) {
            options.push(h('optgroup', { key: 'group:current', label: t('config.modelRoute.currentGroup') },
              h('option', { value: modelOptionValue(pair.provider, pair.model) }, pair.provider + ' / ' + pair.model)))
          }
          return h(ConfigRow, {
            key,
            id: MODEL_ROUTE_ID,
            htmlFor: MODEL_ROUTE_ID,
            label: t('config.modelRoute.label'),
            hint: catalog.status === 'loading'
              ? t('config.modelRoute.loading')
              : catalog.status === 'error' ? t('config.modelRoute.error') : t('config.modelRoute.hint'),
            overridden: routeOverridden,
            disabled,
            invalid: false,
            error: '',
            first: false,
            overriddenLabel: t('config.overridden'),
            resetLabel: t('config.reset'),
            onReset: () => { if (!disabled) resetModelRoute() },
            action: catalog.status === 'error'
              ? h(Button, {
                variant: 'ghost',
                size: 'sm',
                disabled,
                onClick: () => { if (!disabled) loadCatalog() },
              }, t('config.modelRoute.retry'))
              : null,
          }, h('select', {
            id: MODEL_ROUTE_ID,
            style: configStyles.control,
            value: pair === null ? '' : modelOptionValue(pair.provider, pair.model),
            disabled,
            onChange: (event) => {
              if (disabled) return
              const selection = parseModelOptionValue(event.target.value)
              stageModelRoute(selection === null ? '' : selection.provider, selection === null ? '' : selection.model)
            },
          }, options))
        }
        const id = 'followup-config-' + key
        const value = stagedFieldValue(snapshot, draft, field)
        const common = {
          key,
          id,
          htmlFor: id,
          invalid: plan.errors[key] !== undefined,
          label: t('config.' + key + '.label'),
          hint: t('config.' + key + '.hint'),
          overridden: fieldIsOverridden(snapshot, draft, field),
          disabled,
          error: plan.errors[key] === undefined ? '' : t(plan.errors[key]),
          first: index === 0,
          overriddenLabel: t('config.overridden'),
          resetLabel: t('config.reset'),
          onReset: () => { if (!disabled) resetField(key) },
        }
        if (field.kind === 'enum') {
          return h(ConfigRow, common, h('select', {
            id,
            style: configStyles.control,
            value,
            disabled,
            'aria-invalid': common.invalid ? true : undefined,
            onChange: (event) => { if (!disabled) stageValue(key, event.target.value) },
          }, field.values.map((option) => h('option', {
            key: option === '' ? 'default' : option,
            value: option,
          }, option === '' ? t('config.reasoningEffort.modelDefault') : t('config.reasoningEffort.' + option)))))
        }
        if (field.multiline === true) {
          return h(ConfigRow, common, h('textarea', {
            id,
            style: configStyles.textarea,
            rows: 4,
            value,
            disabled,
            'aria-invalid': common.invalid ? true : undefined,
            maxLength: field.maxLength,
            onChange: (event) => { if (!disabled) stageText(key, event.target.value) },
          }))
        }
        return h(ConfigRow, common, h('input', {
          id,
          style: configStyles.control,
          type: 'text',
          inputMode: field.kind === 'integer' ? 'numeric' : undefined,
          value,
          disabled,
          'aria-invalid': common.invalid ? true : undefined,
          placeholder: field.placeholder === true ? t('config.' + key + '.placeholder') : undefined,
          onChange: (event) => { if (!disabled) stageText(key, event.target.value) },
        }))
      })

      return h('div', { style: configStyles.page },
        h('p', { style: configStyles.intro }, t('config.intro')),
        h(SettingsForm, {
          labels: {
            unavailable: t('config.unavailable'),
            readOnly: t('config.readOnly'),
            saveFailed: t('config.saveFailed'),
            save: t('config.save'),
            saving: t('config.saving'),
          },
          state: {
            available: true,
            writable: snapshot.writable,
            dirty: plan.dirty,
            invalid: plan.invalid,
            saving: draft.saving === true,
            failed: draft.failed === true,
          },
          onSave: commit,
          onDiscard: discard,
        }, rows))
    }

    function apply(ctx) {
      const barBridge = { current: null }

      /**
       * Loads the Host's configured model catalog for the settings page. Optional:
       * a composition without the Remote assembly keeps the plugin running, and
       * the page then shows that the list is unavailable instead of bare inputs.
       */
      let loadModelCatalog = null
      ctx.inject(['remote', 'remote.session'], (remoteCtx) => {
        remoteCtx.effect(() => {
          loadModelCatalog = async function modelCatalog() {
            const response = await remoteCtx.remote.session.modelCatalog()
            if (response === null || typeof response !== 'object' || response.ok !== true) {
              throw new Error(response?.error?.message ?? 'model catalog unavailable')
            }
            return response.value
          }
          return () => { loadModelCatalog = null }
        }, NS + ': model catalog')
      })

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

      // The row's Configure entry on the Plugins page. The page owner passes the
      // Host-backed form state; this registration only exists while the bundle is on.
      // The catalog loader stays optional so the page still renders without Remote.
      const configFace = {
        loadModelCatalog: () => {
          if (loadModelCatalog === null) return Promise.reject(new Error('model catalog unavailable'))
          return loadModelCatalog()
        },
      }
      ctx.effect(() => ctx.slots.inject(CONFIG_SLOT, () => ctx.slots.register({
        name: CONFIG_SLOT,
        key: CONFIG_KEY,
        locale: NS,
        inject: () => configFace,
      }, FollowupConfigPage)), NS + ': plugin settings page')
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
