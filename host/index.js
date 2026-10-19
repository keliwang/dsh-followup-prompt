// Host half: predicts the next user message after each completed turn and serves it
// over /api/followup-prompt/rpc. Design: docs/design.md §4.

import { Config as FollowupPromptConfig, resolveConfig } from './config.js'
import { PredictionCache, isSubagentSession, latestCompletedTurn } from './cache.js'
import { generatePrediction } from './prediction.js'
import { createFetchRoute } from './channel.js'

export const name = 'followup-prompt'

// No `webServer`: the /api route is hosted by the Connection plugin.
export const inject = ['connection', 'llm', 'sessions']

export const Config = FollowupPromptConfig

export function apply(ctx, rawConfig) {
  const lifetime = new AbortController()
  const getConfig = () => resolveConfig(rawConfig)
  const cache = new PredictionCache({
    getConfig,
    generate: (session, turn, signal, config) => generatePrediction(ctx, session, turn, config, signal),
  })

  ctx.effect(() => () => {
    lifetime.abort(new Error('followup-prompt: plugin disposed'))
    cache.dispose()
  }, 'followup-prompt: lifetime')

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
      ctx.logger?.debug?.('followup-prompt: session/event handling failed: %s', String(error?.message ?? error))
    }
  })

  ctx.on('session/disposed', (session) => {
    if (session?.id !== undefined) cache.invalidate(session.id)
  })

  ctx.effect(
    () => ctx.connection.fetch.register(createFetchRoute({ ctx, config: getConfig, cache })),
    'followup-prompt: /api fetch route',
  )
}
