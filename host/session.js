// Read-only views over a Host session object.

// Keyed by `turn`, not `seq`: seq shifts when compaction replaces history.
export function latestCompletedTurn(session) {
  let events
  try {
    events = session?.snapshotEvents?.()
  } catch {
    return null
  }
  if (!Array.isArray(events)) return null
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start') return null
    if (event?.type !== 'turn/end') continue
    const turn = event.data?.turn
    if (!Number.isInteger(turn) || turn < 0) return null
    return event.data.reason?.kind === 'completed' ? turn : null
  }
  return null
}

// User-visible forks also carry `parentSession`; only subagents are excluded.
export function isSubagentSession(session) {
  const header = session?.header
  return header?.origin === 'subagent' || header?.delegationDepth > 0
}
