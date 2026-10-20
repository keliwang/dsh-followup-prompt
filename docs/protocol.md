# Followup Prompt — wire protocol

The contract between the Host half (`host/`) and the browser half (`client.js`). Both halves ship in
the same package and are always deployed together, so the protocol is not versioned: change both
sides in the same commit. Implementation and rationale live in [`design.md`](design.md).

## Transport

| | |
|---|---|
| Route | `POST /api/followup-prompt/rpc`, an exact Fetch route registered by the Host through `ctx.connection.fetch.register` |
| Client URL | `api/followup-prompt/rpc` (relative, so it resolves under any mount prefix) |
| Auth | Inherited from `/api`: Host/Origin check, browser-cookie authentication, body limit. Only owner Peers reach the route. |
| Request | JSON body `{ "endpoint": string, "payload": object }` |
| Response | Always **HTTP 200** with a JSON envelope: `{ "ok": true, "value": … }` or `{ "ok": false, "error": { "code", "message", "details" } }`. A non-POST method gets a plain `405`. |
| Cancellation | Aborting the HTTP request aborts `request.signal`, which the Host treats as the caller leaving. |

The Host validates every field and never throws out of the handler; an unexpected exception
becomes `followup-prompt/internal`.

## `suggestions/wait`

Long-polls for the prediction of the session's latest completed turn. The Client never names a
turn: the Host always answers for its own latest completed one.

```jsonc
// payload
{ "sessionId": "…" }               // non-empty string

// value
{
  "suggestion": "帮我补一个单元测试", // string | null
  "turn": 7,                        // integer | null: the completed turn the answer belongs to
  "reason": "timeout"               // only present when suggestion is null (see below)
}
```

**Timing.** The poll stays open until that turn's generation settles. A generation is bounded by
the `timeoutMs` setting (at most 30 s); as a guard against a provider that ignores cancellation,
the Host also ends the poll at `timeoutMs + 2 s`. So a poll never lasts longer than 32 s.

**Sharing and billing.** Concurrent polls for the same turn share one generation. A poll that
leaves (client abort) only removes itself; when the last one leaves, the Host cancels the
generation, unless it was started by `prefetchOnTurnEnd`. Terminal results are cached per turn,
so polling again does not bill again.

**Null answers.** Every `suggestion: null` means "show nothing"; the Client must not branch on
`reason`, which exists for logs and tests.

| `reason` | Meaning | Cached for the turn |
|---|---|---|
| `disabled` | `enabled` is false; nothing is generated | — |
| `unknown-session` | No such session, or a subagent session | — |
| `no-completed-turn` | The session's latest turn is open or did not complete; `turn` is null | — |
| `busy` | The Host is already running its maximum number of generations | no |
| `no-route` | The session has no usable provider/model or no complete user/assistant pair yet; nothing was billed | no |
| `aborted` | The generation was cancelled (last poll left, new turn, plugin unload) | no |
| `timeout` | The generation hit `timeoutMs`, or the poll hit the `+2 s` guard | yes / no |
| `max-tokens` | Output was truncated by `maxTokens` | yes |
| `error` | Provider or stream failure | yes |
| `stale` | The turn's suggestion was dismissed | yes |
| *(absent)* | The model answered but the local filter rejected it (empty, `NO_PREDICTION`, control characters, secret-like text) | yes |

## `suggestions/dismiss`

```jsonc
// payload
{ "sessionId": "…", "turn": 7 }   // turn: optional integer >= 0, from the wait value

// value
{ "ok": true }
```

Marks the turn's suggestion as used (accepted or closed) and cancels its generation if still
running; later polls for that turn answer `stale`. Without `turn` it applies to whatever turn the
Host holds. Idempotent; unknown sessions and mismatched turns are ignored.

## Errors

| `error.code` | When |
|---|---|
| `followup-prompt/bad-request` | Body is not a JSON object, `endpoint` is not a non-empty string, or the payload is invalid |
| `followup-prompt/bad-endpoint` | Unknown `endpoint` |
| `followup-prompt/internal` | Unexpected Host exception |

## Obligations

**Client**

- Treat every failure — network error, abort, non-200, malformed JSON, `ok: false`, null
  suggestion — as "nothing to show": no toast, no retry loop.
- Keep its own request timeout above the 32 s poll ceiling (it uses 35 s).
- Write an accepted suggestion only as an editable draft; never call `inputActions.submit()`.
- Call `suggestions/dismiss` after accept or close.

**Host**

- A prediction never enters the agent loop: no tools are sent or executed, no session events are
  appended, no compaction runs.
- Predictions live in process memory only, keyed by session and latest completed turn.
- Logs carry metadata only (session, turn, provider/model, latency, token counts, outcome), never
  transcript or suggestion text.
