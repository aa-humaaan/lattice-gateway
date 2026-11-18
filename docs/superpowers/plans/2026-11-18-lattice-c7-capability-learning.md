# Passive Capability Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade passport capability claims from `declared` to `measured` using evidence from real traffic, with no extra provider calls.

**Architecture:** A `recordCapabilityClaim` store method writes deduplicated measured claims. An observation module turns canonical responses, stream events and context-overflow errors into signed claims. Router response paths call it in a best-effort wrapper so learning never breaks a request.

**Tech Stack:** TypeScript, Bun test, existing passport store and router.

**Spec:** `docs/superpowers/specs/2026-11-18-lattice-phase-c-design.md`

## Global Constraints
- Never emit a negative capability claim (absence of tool_use proves nothing).
- Never make an extra upstream call to learn; observation is passive.
- Observation failures must never affect the request result.
- Deduplicate identical measured claims so high-traffic routes don't rewrite the passport file constantly.
- Catalogue `observe()` must preserve existing measured claims.
- No new dependencies or commits.

## Review Focus
- A measured claim must survive a later catalogue refresh; Task 1 tests it.
- Repeated identical observations must not change the signed record; Task 1 tests digest stability.
- A context-overflow must record a conservative upper bound, not a new contextWindow value; Task 2 tests it.
- Streams must upgrade supportsStreaming without misreading metadata as content; Task 2 tests it.

---

### Task 1: Deduplicating measured claims
- Modify `src/core/model-passports.ts`; test `tests/unit/passport-observation.test.ts`.
- Produces: `recordCapabilityClaim`, `contextOverflowAt` claim, measured-claim preservation in `observe()`.
- Run targeted and full suite.

### Task 2: Observation module and router wiring
- Create `src/core/passport-observation.ts`; modify `src/core/router.ts`.
- Test: `tests/unit/passport-observation.test.ts`.
- Failing tests: tool/thinking upgrade from a canonical response, stream upgrade, overflow bound, no negative claims.
- Run targeted and full suite.

### Task 3: Docs and verification
- Update README, report, ledger; `bun test`, `bun run verify`, self-review.
