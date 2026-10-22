// Host half: predicts the next user message after each completed turn and serves it
// over /api/followup-prompt/rpc. Design: docs/design.md §4.

import { resolveConfig } from './config.js'
import { PredictionCache } from './cache.js'
import { generatePrediction } from './prediction.js'
import { createFetchRoute } from './channel.js'

export { Config } from './config.js'

export const name = 'followup-prompt'

// No `webServer`: the /api route is hosted by the Connection plugin.
export const inject = ['connection', 'llm', 'sessions']

export function apply(ctx, rawConfig) {
  const getConfig = () => resolveConfig(rawConfig)
  const cache = new PredictionCache({
    generate: (session, turn, signal) => generatePrediction(ctx, session, turn, getConfig(), signal),
  })

  ctx.effect(() => () => cache.dispose(), 'followup-prompt: cache')

  // This bundle ships its own page on the Plugins page, so the settings service
  // must not generate one for the entry. Optional: a Host without Settings still
  // runs the plugin face.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
      'followup-prompt: own settings page',
    )
  })

  ctx.on('session/event', (session, event) => {
    // A new turn makes the previous turn's suggestion obsolete; stop paying for an
    // in-flight prediction nobody may see. Waits only ever target the latest
    // completed turn, so no other event needs cache work.
    if (event?.type === 'turn/start') cache.invalidate(session.id)
  })

  ctx.on('session/disposed', (session) => cache.invalidate(session?.id))

  ctx.effect(
    () => ctx.connection.fetch.register(createFetchRoute({ ctx, cache, getConfig })),
    'followup-prompt: /api fetch route',
  )
}
