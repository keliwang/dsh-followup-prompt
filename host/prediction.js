/**
 * Followup Prompt predictor: context assembly, the one-shot inherited model
 * call, the tool-rejection loop, and output normalization.
 *
 * The prediction request is a pure function of the session log: it reuses the
 * same derived history, request header, tool declarations, and tool history as
 * the session's next real request (maximizing provider prefix reuse), appends
 * one prediction instruction as the tail user message, and dispatches through
 * `ctx.llm.stream()` without entering the agent loop. Tools are declared but
 * never executed: a model tool call is rejected with one unified `isError`
 * tool result per call and the model is asked again, bounded by
 * `maxToolRejectRounds` and one shared deadline.
 *
 * Security/privacy notes: the transcript is never logged, the transcript is
 * never persisted, and only non-sensitive request metadata (session id, turn,
 * provider/model, latency, token counts, rounds, outcome) reaches `ctx.logger`.
 *
 * @module dsh-followup-prompt/host/prediction
 */

import { BlockAssembler, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'

/** Instruction prompt version, for README/A-B metadata (`promptVersion`). */
export const PROMPT_VERSION = 1

/**
 * Built-in prediction instruction. Reuses the derived-prompt prefix instead of
 * re-framing the transcript, which keeps the provider context-cache prefix
 * stable; the output is plain text with a `NO_PREDICTION` sentinel.
 */
export const FOLLOWUP_INSTRUCTION = [
  'You predict the next message the human user will type in this coding conversation.',
  "Read the conversation above, including the assistant's most recent answer.",
  'Do not call any tool. Reply with ONLY the predicted message text, in the language the user has been using.',
  'Keep it to one short message. No quotes, labels, markdown fences, or explanations.',
  'If a confident prediction is impossible, reply with exactly: NO_PREDICTION',
].join('\n')

/**
 * Unified tool-rejection text. Every rejected call in every round receives this
 * exact error result, so the synthetic history stays pairing-valid and the
 * model is told plainly that no tool exists in this context.
 */
export const TOOL_REJECTION_TEXT = [
  'Tool calls are disabled in this context. No tool was executed and no tool can be executed.',
  'Do not call any tool. Reply with ONLY the predicted next user message as plain text.',
].join(' ')

/** Rough per-message structural overhead used by the character budget estimate. */
const MESSAGE_OVERHEAD_CHARS = 12
/** Rough character cost of an image/file placeholder used by the budget estimate. */
const MEDIA_PLACEHOLDER_CHARS = 200

/** Terminal outcomes without a suggestion. */
export const PREDICTION_REASONS = Object.freeze({
  noRoute: 'no-route',
  error: 'error',
  aborted: 'aborted',
  timeout: 'timeout',
  toolRejected: 'tool-rejected',
  maxTokens: 'max-tokens',
})

/**
 * Reject terminal-vs-transcript output that must never be shown.
 * @param {unknown} value - candidate number.
 * @param {number} fallback - value used when not finite.
 * @returns {number} the finite number.
 */
function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Estimate one message's contribution to the character budget.
 *
 * Text and reasoning blocks count their characters; tool calls count their
 * name and raw arguments; media blocks count a fixed placeholder (the full
 * prefix path does not strip them, but the estimate stays conservative).
 *
 * @param {object} message - one model-visible message.
 * @returns {number} estimated characters.
 */
export function estimateMessageChars(message) {
  let total = MESSAGE_OVERHEAD_CHARS
  const content = Array.isArray(message?.content) ? message.content : []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
      case 'reasoning':
        total += String(block.text ?? '').length
        break
      case 'tool-call':
        total += String(block.name ?? '').length + String(block.arguments ?? '').length
        break
      case 'image':
      case 'file':
        total += MEDIA_PLACEHOLDER_CHARS
        break
      default:
        total += 40
        break
    }
  }
  return total
}

/**
 * Whether a message is a leading head message (system prompt or developer
 * context) that trimming must always preserve.
 * @param {object} message - one message.
 * @returns {boolean} true for system/developer roles.
 */
function isHeadMessage(message) {
  return message?.role === 'system' || message?.role === 'developer'
}

/**
 * Whether a message is a human-typed user message — the only safe trim
 * boundary. Synthetic injected user context (file notices, skills, goals) has
 * another producer `source.kind` and must not be used as a cut point.
 * @param {object} message - one message.
 * @returns {boolean} true for a human user message.
 */
export function isHumanUserMessage(message) {
  return message?.role === 'user' && message?.source?.kind === 'user'
}

/**
 * Replace image/file blocks with text placeholders, leaving every other block
 * untouched. Only used in the degraded (trimmed) path; the full-prefix path
 * keeps media byte-identical to the parent request.
 * @param {object} message - one message.
 * @returns {object} the message with media projected to text placeholders.
 */
function stripMediaFromMessage(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  const projected = content.map((block) => {
    if (block?.type === 'image') return { type: 'text', text: '[image omitted from prediction context]' }
    if (block?.type === 'file') {
      const name = block.attachment?.name ?? block.attachment?.fileName ?? 'file'
      return { type: 'text', text: `[file omitted from prediction context: ${String(name)}]` }
    }
    return block
  })
  return { ...message, content: projected }
}

/**
 * Trim a derived history to the configured budget and/or turn cap.
 *
 * Default behavior keeps the full history so the request prefix matches the
 * parent conversation (the reason not to trim). Trimming is the degraded path:
 * it keeps the leading system/developer head and a suffix starting at a human
 * user message, never inside an assistant-tool-call/tool-result pair. A cut is
 * only ever made at a human user message boundary; when no candidate fits, the
 * prediction is abandoned rather than sending an orphaned tool call.
 *
 * @param {readonly object[]} messages - full `session.deriveMessages()` output.
 * @param {object} config - resolved config.
 * @param {number} [instructionChars] - budget reserved for the tail instruction.
 * @returns {{ messages: readonly object[], trimmed: boolean } | null} the kept
 *   history, or null when the history cannot fit the budget at all.
 */
export function trimRequestMessages(messages, config, instructionChars = 0) {
  if (!Array.isArray(messages) || messages.length === 0) return null
  const maxInputChars = finite(config?.maxInputChars, 0)
  const maxTurns = finite(config?.maxTurns, 0)
  const budgetActive = maxInputChars > 0
  const turnsActive = maxTurns > 0
  if (!budgetActive && !turnsActive) return { messages, trimmed: false }

  let headEnd = 0
  while (headEnd < messages.length && isHeadMessage(messages[headEnd])) headEnd += 1
  const head = messages.slice(0, headEnd)
  const body = messages.slice(headEnd)

  const humanIndices = []
  for (let index = 0; index < body.length; index += 1) {
    if (isHumanUserMessage(body[index])) humanIndices.push(index)
  }

  const headChars = head.reduce((sum, message) => sum + estimateMessageChars(message), 0)
  const bodyChars = body.reduce((sum, message) => sum + estimateMessageChars(message), 0)
  const needsBudget = budgetActive && headChars + bodyChars + instructionChars > maxInputChars
  const needsTurns = turnsActive && humanIndices.length > maxTurns
  // Default behavior: full history, byte-identical prefix. Nothing to cut.
  if (!needsBudget && !needsTurns) return { messages, trimmed: false }
  if (humanIndices.length === 0) {
    // No human boundary means no safe cut point: abandon instead of sending an
    // orphaned tool call/result pair.
    return needsBudget ? null : { messages, trimmed: false }
  }

  // Turn cap: keep the most recent `maxTurns` human turns.
  let start = needsTurns ? humanIndices[humanIndices.length - maxTurns] : 0

  if (needsBudget) {
    const suffixChars = new Array(body.length + 1).fill(0)
    for (let index = body.length - 1; index >= 0; index -= 1) {
      suffixChars[index] = suffixChars[index + 1] + estimateMessageChars(body[index])
    }
    const limit = maxInputChars - instructionChars
    let budgetStart = null
    for (const index of humanIndices) {
      if (headChars + suffixChars[index] <= limit) {
        budgetStart = index
        break
      }
    }
    if (budgetStart === null) return null
    start = Math.max(start, budgetStart)
  }

  if (start === 0) return { messages, trimmed: false }
  const kept = [...head, ...body.slice(start)]
  // Defensive invariant: a cut is only ever made before a human user message.
  if (!isHumanUserMessage(kept[head.length])) return null
  return { messages: kept, trimmed: true }
}

/**
 * The prediction instruction for this configuration.
 * @param {object} config - resolved config.
 * @returns {string} the instruction text.
 */
export function instructionText(config) {
  const prompt = typeof config?.prompt === 'string' ? config.prompt.trim() : ''
  return prompt.length > 0 ? prompt : FOLLOWUP_INSTRUCTION
}

/**
 * Assemble request messages plus the degraded-path flag in one pass.
 * @param {object} session - live Session.
 * @param {object} config - resolved config.
 * @returns {{ messages: object[], degraded: boolean } | null} the bundle.
 */
function buildRequestBundle(session, config) {
  const all = session?.deriveMessages?.()
  if (!Array.isArray(all) || all.length === 0) return null
  const instruction = instructionText(config)
  const trimmed = trimRequestMessages(all, config, instruction.length + MESSAGE_OVERHEAD_CHARS)
  if (trimmed === null) return null
  let history = trimmed.messages
  if (trimmed.trimmed && config?.stripMedia === true) history = history.map(stripMediaFromMessage)
  return {
    // The tail instruction is one plain user input: no second system slot, so
    // the inherited prefix stays reusable and cache-friendly.
    messages: [...history, { role: 'user', content: [{ type: 'text', text: instruction }] }],
    degraded: trimmed.trimmed,
  }
}

/**
 * Build the request messages for a prediction.
 * @param {object} session - live Session.
 * @param {object} config - resolved config.
 * @returns {object[] | null} messages, or null when no prediction is possible.
 */
export function buildRequestMessages(session, config) {
  return buildRequestBundle(session, config)?.messages ?? null
}

/**
 * Build the inherited one-shot request from the session's latest request
 * header: reuse provider/model/controls/tools/toolHistory for prefix reuse,
 * delete adapter-materialized defaults, and override the route only when the
 * configured `provider`+`model` pair is complete.
 *
 * @param {object} session - live Session.
 * @param {object} config - resolved config.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @returns {{ options: object, messages: object[], provider: string, model: string,
 *   degraded: boolean } | null} the request seed, or null when the session has
 *   no route/history to inherit.
 */
export function buildInheritedRequest(session, config, signal) {
  const header = session?.requestHeader?.()
  if (header === null || typeof header !== 'object') return null
  const inherited = header.config
  if (inherited === null || typeof inherited !== 'object') return null
  const callConfig = { ...inherited }
  if (header.adapterDefaults?.reasoningEffort === true) delete callConfig.reasoningEffort
  if (header.adapterDefaults?.maxTokens === true) delete callConfig.maxTokens

  const provider = config?.provider || callConfig.provider
  const model = config?.model || callConfig.model
  if (typeof provider !== 'string' || provider.length === 0) return null
  if (typeof model !== 'string' || model.length === 0) return null

  const bundle = buildRequestBundle(session, config)
  if (bundle === null) return null

  const options = {
    ...callConfig,
    provider,
    model,
    messages: bundle.messages,
    // Keep the full tool declarations so the request prefix matches the parent
    // session's next request; tools are declared, never executed.
    ...(Array.isArray(header.tools) && header.tools.length > 0 ? { tools: header.tools } : {}),
    toolHistory: session.toolHistory?.(),
    sessionId: session.id,
    maxTokens: config?.maxTokens,
    ...(config?.reasoningEffort === '' || config?.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: config.reasoningEffort }),
    signal,
  }
  return { options, messages: bundle.messages, provider, model, degraded: bundle.degraded }
}

/**
 * Normalize and safety-filter raw model text into a suggestion.
 *
 * Removes a wrapping markdown fence and outer quotes/backticks, drops the
 * `NO_PREDICTION` sentinel, rejects control characters and secret-looking
 * tokens, and truncates to `maxSuggestionChars`.
 *
 * @param {unknown} raw - raw model text.
 * @param {object} config - resolved config.
 * @returns {string | null} the suggestion, or null when it must be dropped.
 */
export function normalizeSuggestion(raw, config) {
  let text = String(raw ?? '').trim()
  text = text.replace(/^```[a-zA-Z]*\n?|```$/g, '').trim()
  if (text.length >= 2) {
    const first = text[0]
    const last = text.at(-1)
    if ((first === '"' && last === '"') || (first === '`' && last === '`')) text = text.slice(1, -1).trim()
  }
  if (text === '' || text.includes('NO_PREDICTION')) return null
  // C0 control characters except tab/LF/CR; terminal escapes never reach the UI.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return null
  // Obvious secret shapes: the suggestion is never auto-sent, but it is shown.
  if (/(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/.test(text)) return null
  const max = finite(config?.maxSuggestionChars, 400)
  return text.length > max ? text.slice(0, max) : text
}

/**
 * A completion deadline shared by every tool-rejection round.
 * @param {AbortSignal | undefined} parent - caller cancellation.
 * @param {number} timeoutMs - whole-prediction deadline.
 * @returns {{ signal: AbortSignal, timedOut: () => boolean, dispose: () => void }} the deadline handle.
 */
function createDeadline(parent, timeoutMs) {
  const controller = new AbortController()
  let timer
  const parentAborted = () => parent?.aborted === true
  const onAbort = () => {
    controller.abort(parent?.reason instanceof Error ? parent.reason : new Error('followup-prompt: aborted'))
  }
  if (parent?.aborted) {
    onAbort()
  } else if (parent !== undefined) {
    parent.addEventListener('abort', onAbort, { once: true })
  }
  if (!controller.signal.aborted) {
    timer = setTimeout(() => controller.abort(new Error('followup-prompt: prediction timed out')), timeoutMs)
  }
  return {
    signal: controller.signal,
    timedOut: () => controller.signal.aborted && !parentAborted(),
    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      parent?.removeEventListener?.('abort', onAbort)
    },
  }
}

/**
 * Reject one round's tool calls with synthetic pairing-valid history.
 *
 * The synthetic assistant message carries only the tool-call blocks (no
 * reasoning, which may need provider signatures), and each call gets exactly
 * one `isError` tool result containing the unified rejection text. A duplicate
 * or empty call id is unrepresentable in provider history, so it abandons the
 * attempt instead.
 *
 * @param {object} input - builder inputs.
 * @param {readonly object[]} input.messages - history so far.
 * @param {readonly object[]} input.calls - assembled tool-call blocks.
 * @param {string} input.provider - request provider.
 * @param {string} input.model - request model.
 * @param {string} input.rejectionText - unified rejection text.
 * @returns {object[] | null} the extended messages, or null on invalid call ids.
 */
function appendToolRejections({ messages, calls, provider, model, rejectionText }) {
  const ids = new Set()
  for (const call of calls) {
    const id = String(call?.id ?? '')
    if (id.length === 0 || ids.has(id)) return null
    ids.add(id)
  }
  return [
    ...messages,
    createAssistantMessage({ content: calls, source: { provider, model } }),
    ...calls.map((call) => createToolResultMessage({
      callId: call.id,
      content: [{ type: 'text', text: rejectionText }],
      isError: true,
    })),
  ]
}

/**
 * Log non-sensitive attempt metadata. Never logs transcript text.
 * @param {object} ctx - plugin context.
 * @param {object} session - live Session.
 * @param {number} turn - completed turn.
 * @param {object} config - resolved config.
 * @param {number} startedAt - attempt start timestamp.
 * @param {object} result - attempt result.
 * @param {string} outcome - short outcome label.
 * @returns {void}
 */
function logPrediction(ctx, session, turn, config, startedAt, result, outcome) {
  const usage = result.usage
  const suggestion = result.suggestion
  const meta = {
    promptVersion: PROMPT_VERSION,
    sessionId: String(session?.id ?? ''),
    turn: typeof turn === 'number' ? turn : null,
    provider: result.provider ?? config?.provider ?? '',
    model: result.model ?? config?.model ?? '',
    rounds: result.rounds,
    toolRejected: result.toolRejected === true,
    degraded: result.degraded === true,
    ms: Date.now() - startedAt,
    suggestionChars: typeof suggestion === 'string' ? suggestion.length : 0,
    inputTokens: usage?.inputTokens,
    cacheReadTokens: usage?.cacheReadTokens,
    outputTokens: usage?.outputTokens,
    outcome,
  }
  ctx.logger?.debug?.('followup-prompt: prediction %o', meta)
}

/**
 * Generate one prediction for a completed turn.
 *
 * Never throws: model, provider, stream, and assembly failures are mapped to a
 * silent `suggestion: null` outcome with a reason. The only model side effect
 * is a normal, billable completion call made through `ctx.llm.stream()`; the
 * agent loop is never entered, no tool executes, and nothing is persisted.
 *
 * @param {object} ctx - plugin context (`llm`, `logger`).
 * @param {object} session - live Session.
 * @param {number} turn - the completed turn being predicted for (metadata only).
 * @param {object} config - resolved config.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @returns {Promise<{ suggestion: string | null, reason?: string, rounds: number,
 *   toolRejected: boolean, degraded: boolean, provider?: string, model?: string,
 *   usage?: object }>} the attempt result.
 */
export async function generatePrediction(ctx, session, turn, config, signal) {
  const startedAt = Date.now()
  const base = { rounds: 0, toolRejected: false, degraded: false, provider: undefined, model: undefined }

  let built
  try {
    built = buildInheritedRequest(session, config, signal)
  } catch (error) {
    ctx.logger?.debug?.('followup-prompt: context assembly failed: %s', String(error?.message ?? error))
    return { suggestion: null, reason: PREDICTION_REASONS.error, ...base }
  }
  if (built === null) return { suggestion: null, reason: PREDICTION_REASONS.noRoute, ...base }
  base.degraded = built.degraded
  base.provider = built.provider
  base.model = built.model

  const deadline = createDeadline(signal, finite(config?.timeoutMs, 15000))
  const rejectionText = typeof config?.toolRejectionText === 'string' && config.toolRejectionText.length > 0
    ? config.toolRejectionText
    : TOOL_REJECTION_TEXT
  const maxRejectRounds = Math.max(0, finite(config?.maxToolRejectRounds, 1))
  let messages = built.messages
  let usage

  /** Abandon the attempt with one non-sensitive debug record. */
  const finish = (reason, outcome) => {
    const result = { suggestion: null, reason, ...base, usage }
    logPrediction(ctx, session, turn, config, startedAt, result, outcome ?? reason)
    return result
  }

  try {
    for (let round = 0; round <= maxRejectRounds; round += 1) {
      base.rounds = round + 1
      if (deadline.signal.aborted || signal?.aborted) {
        return finish(deadline.timedOut() ? PREDICTION_REASONS.timeout : PREDICTION_REASONS.aborted)
      }
      const assembler = new BlockAssembler()
      let streamError
      try {
        const stream = ctx.llm.stream({ ...built.options, messages, signal: deadline.signal })
        for await (const chunk of stream) assembler.push(chunk)
      } catch (error) {
        streamError = error
      }
      usage = assembler.usage ?? usage

      if (signal?.aborted) return finish(PREDICTION_REASONS.aborted)
      if (deadline.timedOut()) return finish(PREDICTION_REASONS.timeout)
      if (streamError !== undefined) {
        // The LLM service turns adapter failures into terminal finish chunks, so
        // this path is a consumer/middleware failure: silent, never throw.
        ctx.logger?.debug?.('followup-prompt: stream failed: %s', String(streamError?.message ?? streamError))
        return finish(PREDICTION_REASONS.error)
      }

      let blocks
      try {
        blocks = assembler.blocks()
      } catch (error) {
        // `blocks()` throws on an unknown block type left unclosed: treat as error.
        ctx.logger?.debug?.('followup-prompt: assembly failed: %s', String(error?.message ?? error))
        return finish(PREDICTION_REASONS.error)
      }
      const terminal = assembler.finish
      const calls = blocks.filter((block) => block.type === 'tool-call')

      if (calls.length === 0) {
        if (terminal.kind !== 'stop') {
          if (terminal.kind === 'aborted') {
            return finish(deadline.timedOut() ? PREDICTION_REASONS.timeout : PREDICTION_REASONS.aborted)
          }
          return finish(terminal.kind === 'max-tokens' ? PREDICTION_REASONS.maxTokens : PREDICTION_REASONS.error)
        }
        const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
        const suggestion = normalizeSuggestion(text, config)
        const result = { suggestion, ...base, usage: assembler.usage ?? usage }
        logPrediction(ctx, session, turn, config, startedAt, result, suggestion === null ? 'filtered' : 'suggested')
        return result
      }

      // A model tool call is expected occasionally; never execute it.
      base.toolRejected = true
      if (round >= maxRejectRounds) return finish(PREDICTION_REASONS.toolRejected)
      const extended = appendToolRejections({
        messages,
        calls,
        provider: built.provider,
        model: built.model,
        rejectionText,
      })
      if (extended === null) {
        // Duplicate/empty call ids cannot form a valid provider history.
        ctx.logger?.debug?.('followup-prompt: duplicate tool-call id; abandoning prediction')
        return finish(PREDICTION_REASONS.toolRejected, 'duplicate-call-id')
      }
      messages = extended
    }
    return finish(PREDICTION_REASONS.toolRejected)
  } finally {
    deadline.dispose()
  }
}
