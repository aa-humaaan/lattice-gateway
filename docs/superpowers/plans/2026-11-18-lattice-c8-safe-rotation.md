# Safe Account Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop ambiguous network failures from rotating accounts, preventing duplicate tool calls while preserving rate-limit and auth-failure rotation.

**Architecture:** A shared `failFastNetworkError` helper converts a fetch rejection into a 502 GatewayError. Kilo, Nous and Cline call it instead of `continue` in their network catch blocks. 429 and 401/403 rotation remain, since those responses prove the request was not processed.

**Tech Stack:** TypeScript, Bun test, existing GatewayError and plugin retry loops.

**Spec:** original report Phase B; `docs/superpowers/specs/2026-11-18-lattice-phase-c-design.md`.

## Global Constraints
- Never rotate on a network error, timeout, or abort — the upstream may have processed the request.
- Keep rotating on 429 (rate limit) and 401/403 (auth failure), both provably unprocessed.
- 5xx already fails fast; do not change it.
- No new dependencies, commits (until the final step), pushes, or history rewrites.

## Review Focus
- A network failure must not reach a second account; Task 1 counts fetch calls.
- A 429 must still rotate; existing intra-model rotation tests cover it.
- A 401 must still rotate where existing tests expect it; Task 1 covers Kilo.
- Streaming paths must fail fast too; Task 1 covers Kilo stream.
- No credential or raw error text in the thrown message.

---

### Task 1: Fail fast on network errors
- Create `src/utils/network-error.ts`; modify `src/plugins/kilo.ts`, `nous.ts`, `cline.ts`.
- Test: `tests/unit/safe-rotation.test.ts`.
- Failing tests: network failure makes exactly one fetch call and throws 502; Kilo stream same; 401 and 429 still rotate; message has no secret text.
- Run targeted and full suite.

### Task 2: Docs, verification, and commit
- Update README, report, ledger; `bun test`, `bun run verify`, self-review.
- Commit the increment only if the user has approved committing further work.
