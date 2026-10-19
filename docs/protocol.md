# Followup Prompt — wire protocol (Host ↔ Client)

Status: **v1 draft, aligned with `dsh-followup-prompt-plan.md` §3.1 / §4.7 / §5.2.** The Host half and the
browser half must be changed together; this document is the shared contract.

## Transport

- The browser calls the Host through DSH's own authenticated Connection RPC:
  `ctx.connection.rpc.call('/followup-prompt', endpoint, payload, signal)`.
- The Host registers the channel with `ctx.connection.rpc.handle('/followup-prompt', handler)`
  inside `ctx.effect(...)`; registration goes through `owner.webServer.register`, so the Host
  plugin must inject `webServer`. Channel names are `^/[A-Za-z0-9._~-]+$` and `/api` is reserved.
- `handler(endpoint, payload, signal, peer) => Promise<{ ok: true, value } | { ok: false, error }>`.
- Unary only, POST/JSON, same-origin loopback; browser cookie / process token authentication is
  handled by Connection. A transport failure (HTTP 401/403/404/500, network abort) is thrown to the
  caller; the Client treats any failure as "no suggestion".
- Payloads are JSON. The Host validates every field at the wire boundary and never throws from the
  handler (unexpected exceptions are mapped to `followup-prompt/internal`).

## Endpoints

### `suggestions/wait`

Long-poll for the prediction of the latest completed turn.

Request:

```jsonc
{
  "sessionId": "…",   // required, non-empty string
  "turn": 7,          // optional, integer >= 0; Client's view of the expected turn
  "waitMs": 12000     // optional, 0..15000; default 12000, Host-capped at 15000
}
```

Success value:

```jsonc
{
  "suggestion": "帮我补一个单元测试", // string | null
  "turn": 7,                        // number | null — the completed turn the result belongs to
  "reason": "timeout"               // optional, present when suggestion is null
}
```

Semantics:

- `turn` mismatch with the Host's latest completed turn → `{ suggestion: null, turn: <latest>,
  reason: "stale" }` (the Client may retry once with the returned turn).
- No completed turn yet / unknown session / subagent session → `{ suggestion: null, turn: null,
  reason: "unknown-session" | "no-completed-turn" }`.
- Cached terminal result for `(sessionId, turn)` returns immediately (a `null` result is cached too,
  so repeated polling does not re-bill).
- A running generation is shared by all waiters; the Client aborting its request only removes a
  waiter. The Host cancels work when the last waiter leaves (unless `prefetchOnTurnEnd` started it).
- `waitMs` expiry → `{ suggestion: null, turn, reason: "timeout" }` (generation may continue in the
  background; a later wait can still observe it).
- Deterministic sampling (`sampleRate < 1`) → `reason: "sampled-out"`, cached for the turn.
- Global concurrency (`maxConcurrent`) exceeded → `reason: "busy"`.
- Model/provider failure → `reason: "error"`; abort/disposal → `reason: "aborted"`; a model that
  still insists on tool calls after `maxToolRejectRounds` → `reason: "tool-rejected"`.

### `suggestions/dismiss`

Request: `{ "sessionId": "…", "turn": 7 /* optional integer >= 0 */ }`

Success value: `{ "ok": true }`

Marks the suggestion dismissed for the turn (accepted or explicitly closed); subsequent `wait`
calls return `{ suggestion: null, turn, reason: "stale" }`. Dismiss is idempotent and is
fire-and-forget from the Client's perspective.

## Error envelope

Handler-level failures use the Connection failure shape:

```jsonc
{ "ok": false, "error": { "code": "followup-prompt/bad-request", "message": "…", "details": {} } }
```

Codes: `followup-prompt/bad-request`, `followup-prompt/bad-endpoint`, `followup-prompt/internal`.
The Client MUST treat `ok: false` exactly like a transport failure: silent, no toast, no retry storm.

## Client state machine (summary)

```
idle
  ──(running true→false && draft === '' && attachmentIds.length === 0
     && input.phase === 'plain' && !blank && !awaitingFirstTurn
     && suggestion not yet requested for this session/turn)
  ──> requesting: abort previous request, call suggestions/wait
requesting ──(suggestion !== null && conditions still hold)──> shown
requesting ──(null / reason / ok:false / abort / timeout)────> idle (silent)
shown ──(draft !== '' || running || phase !== 'plain' || session switch || unmount)──> hidden (abort)
shown ──(Tab or click accept)──> accepted: write draft via inputActions, call suggestions/dismiss, clear
shown ──(close / Esc)────────> hidden: call suggestions/dismiss, clear
```

Catch-up: mounting into an already-idle, completed session issues one `suggestions/wait`; Host cache
serves it without a new model call.

## Hard invariants

- The prediction request never enters the agent loop: no tools are executed, no session events are
  appended, no compaction runs. Tool calls emitted by the model are rejected with one unified
  `isError` tool-result per call (maximum `maxToolRejectRounds` retries, then silence).
- The accepted suggestion is only ever written as an **editable draft**; the Client must never call
  `inputActions.submit()`.
- The Host stores predictions in process memory only (keyed by `sessionId`, latest completed
  `turn`); nothing is persisted to the session log or disk.
- No transcript content in logs — only non-sensitive metadata (session, turn, provider/model,
  latency, token counts, rounds, outcome).
