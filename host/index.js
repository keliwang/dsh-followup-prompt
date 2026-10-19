// Host half: predicts the next user message after each completed turn and serves it
// over /api/followup-prompt/rpc. Design: docs/design.md §4.

import { resolveConfig } from './config.js'
import { PredictionCache } from './cache.js'
import { generatePrediction } from './prediction.js'
import { createFetchRoute } from './channel.js'
import { isSubagentSession, latestCompletedTurn } from './session.js'

export { Config } from './config.js'

export const name = 'followup-prompt'

// No `webServer`: the /api route is hosted by the Connection plugin.
export const inject = ['connection', 'llm', 'sessions']

export function apply(ctx, rawConfig) {
  const getConfig = () => resolveConfig(rawConfig)
  const cache = new PredictionCache({
    getConfig,
    generate: (session, turn, signal, config) => generatePrediction(ctx, session, turn, config, signal),
  })

  ctx.effect(() => () => cache.dispose(), 'followup-prompt: cache')

  const onSessionEvent = (session, event) => {
    if (event?.type === 'turn/start') {
      // A new turn makes the previous turn's suggestion obsolete; stop paying
      // for an in-flight prediction nobody may see.
      cache.invalidate(session.id)
      return
    }
    if (event?.type !== 'turn/end' || event.data?.reason?.kind !== 'completed') return
    // Only the committed tail turn may be predicted for; a replayed or
    // out-of-order event must not invalidate newer state.
    const turn = event.data.turn
    if (!Number.isInteger(turn) || latestCompletedTurn(session) !== turn) return
    cache.invalidate(session.id)
    const config = getConfig()
    if (!config.enabled || !config.prefetchOnTurnEnd) return
    if (config.excludeSubagents && isSubagentSession(session)) return
    cache.prefetch(session, turn)
  }

  ctx.on('session/event', (session, event) => {
    try {
      onSessionEvent(session, event)
    } catch (error) {
      ctx.logger?.debug?.('followup-prompt: session/event handling failed: %s', String(error?.message ?? error))
    }
  })

  ctx.on('session/disposed', (session) => cache.invalidate(session?.id))

  ctx.effect(
    () => ctx.connection.fetch.register(createFetchRoute({ ctx, cache, getConfig })),
    'followup-prompt: /api fetch route',
  )
}
