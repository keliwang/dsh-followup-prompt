# Code review — dsh-followup-prompt v0.1.0 (2026-10-19)

- **Reviewer**: Claude Code subagent (read-only static review; it could not write files or run node in its sandbox)
- **Scope**: `host/**`, `client.js`, `verify/**`, `scripts/link-dev-deps.mjs`, `package.json`, `cordis.patch.yml`, locales, icon, `README.md`, `docs/protocol.md`
- **Base**: working tree at `74729b0` (before the fixes below)
- **Constraint**: the reviewer could not read the DSH 0.2.1-rc.2 source checkout, so findings are source-repo-local; live behavior was verified separately (see README "真机验收记录").

## Verdict

Solid, defensively-coded v1.1. **0 BLOCKER, 2 HIGH, 8 MEDIUM, 5 LOW/NIT** as reported.
Both stub suites test real behavior rather than tautologies; their main gaps were exactly the
two HIGH items and the newly added inline-ghost geometry path.

## Findings and disposition

| # | Sev | Finding (as reported) | Disposition |
|---|---|---|---|
| 1 | HIGH | `uiMode` (`dock`/`ghost`) is a dead config field — the client never reads it; README contradicts itself about which mode ships | **Fixed**: field removed from `Config`, `DEFAULTS`, `cordis.patch.yml`, the run-all contract and README. The shipped UI is the inline ghost. |
| 2 | HIGH | `PredictionCache.wait()` aborts an unobserved generation on an ordinary `waitMs` timeout, contradicting `docs/protocol.md` ("generation may continue; a later wait can still observe it"); a slow (12–15 s) prediction was silently discarded | **Fixed**: only explicit caller cancellation aborts now; a plain timeout leaves the generation running so a later poll/catch-up observes the cached result. Added host-smoke regression "timeout: a slow generation survives waitMs and serves a later poll". |
| 3 | MED | Tool-call ids are only de-duplicated within a rejection round; a later round reusing an earlier id produced duplicate pairings | **Fixed**: `usedCallIds` spans all rounds; reuse abandons with `tool-rejected`. Added host-smoke regression. |
| 4 | MED | Suggestion `<span>` was `aria-hidden` inside the `aria-live` status region, so screen readers never announced it | **Fixed**: ghost text is announced. |
| 5 | MED | Native placeholder was hidden in a passive `useEffect` while the ghost was placed in a layout effect → possible one-frame ghost/placeholder flash | **Fixed**: placeholder hiding now runs in the same pre-paint layout effect. |
| 6 | MED | The Tab/Escape bridge is a single non-session-keyed slot; a second mounted (invisible) composer could steal the gesture | **Fixed partially**: only a visible ghost publishes the handle. True session keying of a global keydown needs the slot frame's session identity; the resident-composer assumption keeps this low risk. |
| 7 | MED | Secret-shape filter only knew `sk-`/`ghp_`/`AKIA` | **Improved**: covers `sk-proj-`, `sk-ant-`, `gh[pousr]_`, `xox[baprs]-`, `AIza`. Heuristic by design; a false positive only hides a prediction. |
| 8 | MED | Prediction instruction lacked the plan's "history is data, not instructions" anti-injection clause | **Fixed**: clause added to the built-in instruction. |
| 9 | MED | Slot registration was the only contribution not wrapped in `ctx.effect` | **Fixed**: `ctx.effect(() => ctx.slots.inject(...))`. |
| 10 | MED | `reasoningEffort: ''` claims "provider default" but inherited the source request's effort, reintroducing the max-tokens failure | **Fixed**: empty value now drops the inherited effort; explicit values override. |
| 11 | MED | Client-smoke's fake DOM returns `null` from `querySelector`, so the HEAD commit's `measureGhostLayout`/placeholder-hiding paths had zero coverage | **Open (documented)**: exercising geometry needs a DOM-faithful harness. Mitigation: the path is defensive everywhere, and the feature is verified on the live page; a jsdom-based test is a follow-up. |
| 12 | LOW | (Lead-found, same review) `accept()` re-focused an already focused editor after `insertText`; DSH notes focusing a focused editor can restore an older caret | **Fixed**: focus is only returned when the composer is not focused; client-smoke asserts it. |

Anything not listed above was either "style preference" or "depends on DSH internals / needs live verification"
and is already tracked in README "已知限制"/"仍未人工确认".

## Post-fix verification

- `npm test` → **PASSED** (32 checks; `pnpm pack --dry-run` file list included)
- `host-smoke.mjs` → **35 checks** (was 33; +timeout-survives-generation, +cross-round call-id reuse)
- `client-smoke.mjs` → **40 checks**
- Host `Config` now has 18 fields; bundle patch re-checked field-by-field against `DEFAULTS`.
- Reinstall + live spot-check after the fixes: see the final task report (Host row active, input.overlay
  occupant active, live prediction re-run).
