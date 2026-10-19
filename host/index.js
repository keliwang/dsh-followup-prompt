/**
 * Followup Prompt Host plugin.
 *
 * After a turn completes, predict the next human message once through
 * `ctx.llm.stream()` (inherited request prefix, no agent loop, no tool
 * execution, no session writes), cache the result in memory keyed by
 * `sessionId`, and serve it to the browser half over DSH's authenticated
 * Connection RPC channel `/followup-prompt`.
 *
 * Wiring summary (`dsh-followup-prompt-plan.md` §4.1):
 * - `session/event` + `turn/end(completed)` → invalidate the previous turn's
 *   entry; optionally prefetch the new turn when `prefetchOnTurnEnd` is on;
 * - `session/event` + `turn/start` → abort in-flight work and drop the cache;
 * - `session/disposed` → abort and delete all state for that session;
 * - plugin unload → abort the plugin lifetime, dispose the cache, and let
 *   `ctx.effect` remove the RPC channel.
 *
 * @module dsh-followup-prompt/host/index
 */

import { Config as FollowupPromptConfig, resolveConfig } from './config.js'
import { PredictionCache, isSubagentSession, latestCompletedTurn } from './cache.js'
import { generatePrediction } from './prediction.js'
import { CHANNEL, createChannelHandler } from './channel.js'

/** Cordis plugin name (Loader row id is `followup-prompt`). */
export const name = 'followup-prompt'

/**
 * Required Host services. `webServer` is required because
 * `ctx.connection.rpc.handle()` registers its channel through
 * `owner.webServer.register` on the calling fiber.
 */
export const inject = ['connection', 'llm', 'sessions', 'webServer']

/** Loader/Settings schema (all fields volatile; see `host/config.js`). */
export const Config = FollowupPromptConfig

/**
 * Apply the Host plugin to the Harness.
 *
 * @param {object} ctx - plugin context.
 * @param {object} rawConfig - validated Loader config; volatile fields are live
 *   references, so the plugin re-resolves it at every use site.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const lifetime = new AbortController()
  const getConfig = () => resolveConfig(rawConfig)
  const cache = new PredictionCache({
    getConfig,
    generate: (session, turn, signal, config) => generatePrediction(ctx, session, turn, config, signal),
  })

  /** Plugin-level lifetime: cancel every prediction and channel waiter on unload/HMR. */
  ctx.effect(() => () => {
    lifetime.abort(new Error('followup-prompt: plugin disposed'))
    cache.dispose()
  }, 'followup-prompt: lifetime')

  /**
   * Handle the lightweight slice of the post-commit session event feed the
   * predictor needs. Every other event type is ignored immediately so the
   * fire-and-forget listener stays cheap.
   * @param {object} session - the session whose log grew.
   * @param {object} event - the committed session event.
   * @returns {void}
   */
  const onSessionEvent = (session, event) => {
    if (lifetime.signal.aborted) return
    const type = event?.type
    if (type === 'turn/start') {
      // A new turn makes the previous turn's suggestion obsolete; stop paying
      // for an in-flight prediction nobody may see.
      if (session?.id !== undefined) cache.invalidate(session.id)
      return
    }
    if (type !== 'turn/end') return
    const data = event.data
    if (data?.reason?.kind !== 'completed') return
    const turn = data.turn
    if (!Number.isInteger(turn) || turn < 0) return
    // Only the committed tail turn may be predicted for; a replayed or
    // out-of-order event must not invalidate newer state.
    if (latestCompletedTurn(session) !== turn) return
    if (session?.id !== undefined) cache.invalidate(session.id)
    const config = getConfig()
    if (!config.enabled) return
    if (config.excludeSubagents && isSubagentSession(session)) return
    if (!config.prefetchOnTurnEnd) return
    cache.prefetch(session, turn)
  }

  ctx.on('session/event', (session, event) => {
    try {
      onSessionEvent(session, event)
    } catch (error) {
      // Listener failures are contained by the dispatcher already; log a short
      // non-sensitive line so a broken prediction never disturbs the session.
      ctx.logger?.debug?.('followup-prompt: session/event handling failed: %s', String(error?.message ?? error))
    }
  })

  ctx.on('session/disposed', (session) => {
    if (session?.id !== undefined) cache.invalidate(session.id)
  })

  // The channel registration belongs to this plugin fiber: `rpc.handle`
  // registers a prefix route through `owner.webServer.register`, and the
  // returned disposer removes it on unload/HMR.
  ctx.effect(() => {
    const handler = createChannelHandler({ ctx, config: getConfig, cache })
    const dispose = ctx.connection.rpc.handle(CHANNEL, handler)
    return () => {
      void dispose()
    }
  }, 'followup-prompt: rpc channel')
}
