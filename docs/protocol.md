# Followup Prompt — wire protocol (Host ↔ Client)

The shared contract between the Host half (`host/channel.js`, `host/cache.js`) and the browser half
(`client.js`). Change both halves together. Design rationale: [`design.md`](design.md).

## Transport

- Browser → Host: same-origin `POST /api/followup-prompt/rpc`, an **exact Fetch route** registered by
  the Host half with `ctx.connection.fetch.register({ path, methods: ['POST'], requestBody: 'buffered', fetch })`
  inside `ctx.effect(...)`. The client uses `fetch('api/followup-prompt/rpc', …)` (relative URL).
- Why not the generic Connection RPC channel: on the live 0.2.1-rc.2 Harness, activating a profile
  bundle that calls `ctx.connection.rpc.handle('/followup-prompt', handler)` fails with
  `cannot get property "webServer" without inject` — the RPC registrar captures the Connection
  service's own context (which injects only `credentials`) and then calls `owner.webServer.register`,
  so the caller's `webServer` injection is never consulted. No in-repo plugin uses `rpc.handle`;
  in-repo plugins and the installed third-party `ds-bot` bundle all use exact Fetch routes. This is
  also why the Host half injects `['connection','llm','sessions']` and no `webServer`.
- The route lives under `/api`, so it inherits the same Host/Origin trust fence, browser-cookie
  authentication, body limit, and request cancellation as the rest of the DSH API. Only owner
  Peers reach the route.
- Request body (JSON, POST):

  ```jsonc
  { "endpoint": "suggestions/wait", "payload": { /* endpoint payload */ } }
  ```

- Response: **HTTP 200** with a JSON envelope, either `{ "ok": true, "value": … }` or
  `{ "ok": false, "error": { "code", "message", "details" } }`. The Client treats any non-200,
  network/abort, malformed-JSON, or `ok:false` result as "no suggestion" (silent).
- The Host validates every field at this wire boundary and never throws from the route handler
  (unexpected exceptions map to `followup-prompt/internal`). `request.signal` carries the caller's
  cancellation into the long poll.

## Endpoints

### `suggestions/wait`

Long-poll for the prediction of the latest completed turn.

Request:

```jsonc
{
  "sessionId": "…",   // required, non-empty string
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

- The Host always predicts for its own latest completed turn; the Client does not name one.
- No completed turn yet / unknown session / subagent session → `{ suggestion: null, turn: null,
  reason: "unknown-session" | "no-completed-turn" }`.
- Cached terminal result for `(sessionId, turn)` returns immediately (a `null` result is cached too,
  so repeated polling does not re-bill).
- A running generation is shared by all waiters; the Client aborting its request only removes a
  waiter. The Host cancels work when the last waiter leaves (unless `prefetchOnTurnEnd` started it).
- `waitMs` expiry → `{ suggestion: null, turn, reason: "timeout" }` (generation may continue in the
  background; a later wait can still observe it).
- Deterministic sampling (internal `sampleRate < 1`) → `reason: "sampled-out"`, cached for the turn.
- Global concurrency (internal `maxConcurrent`) exceeded → `reason: "busy"`.
- Master switch off (`enabled: false`) → `reason: "disabled"` (nothing is generated or cached).
- Model/provider failure → `reason: "error"`; abort/timeout → `reason: "aborted"` / `"timeout"`;
  output truncated by `maxTokens` (`finish.kind === "max-tokens"`) → `reason: "max-tokens"`;
  a model that still insists on tool calls after the internal `maxToolRejectRounds` → `reason: "tool-rejected"`.
- Successful completion whose text is rejected by the local filter (empty, `NO_PREDICTION`,
  control characters, secret-like shape) → `{ suggestion: null, turn }` with **no** `reason`;
  the Host logs it as `filtered`. The Client treats every null suggestion identically.

### `suggestions/dismiss`

Request: `{ "sessionId": "…", "turn": 7 /* optional integer >= 0, the turn from the wait result */ }`

Success value: `{ "ok": true }`

Marks the suggestion dismissed for the turn (accepted or explicitly closed); subsequent `wait`
calls return `{ suggestion: null, turn, reason: "stale" }`. Dismiss is idempotent and is
fire-and-forget from the Client's perspective.

## Error envelope

Business failures use the JSON result envelope (still HTTP 200):

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
hidden ──(conditions hold again, same session and turn)──> shown from the local cache (no RPC)
shown ──(Tab accept)──> accepted: write draft via inputActions, call suggestions/dismiss, clear
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
