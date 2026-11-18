# Correctness Minor Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the seven deferred correctness minors with small, test-first changes.

**Architecture:** Independent one-file fixes plus one shared USD rate constant; no architecture changes.

**Spec:** accumulated deferred-minors lists in `docs/superpowers/specs/` and `.superpowers/sdd/` ledgers.

## Global Constraints
- No behavior regressions in existing tests; each change gets a regression test.
- No new dependencies or external calls.
- Commit once at the end.

## Review Focus
- A chunked request larger than the cap must still be rejected; Task 1 tests it.
- Port message should name the owning PID when available without killing it; Task 3 tests it.
- Allow-list must reject loopback/private obfuscations; Task 4 tests them.
- One USD rate everywhere; Task 5 tests a single constant.

---

### Task 1: Streamed body-size enforcement
- Modify `src/core/server.ts`; test `tests/unit/security-correctness.test.ts`.
- Count bytes while reading the body for requests without a trusted Content-Length; 413 on overflow.

### Task 2: Abort upstream fetch on deadline
- Modify `src/utils/request-deadline.ts`; test `tests/unit/security-correctness.test.ts`.
- Produce `withDeadline(signal, timeoutMs, label)` returning a race that also aborts; wire router call sites if safe.

### Task 3: Switch cap off-by-one
- Modify `src/plugins/combo.ts`; test `tests/unit/combo-context-overflow.test.ts`.
- Use `>=` so at most MAX_STREAM_TARGET_SWITCHES attempts occur.

### Task 4: `tokensPerSec` window consistency
- Modify `src/admin/admin-router.ts`; test `tests/unit/admin-dashboard.test.ts`.
- Compute numerator and span over the same recent-events window.

### Task 5: One honest USD rate
- Create `src/core/pricing.ts`; modify `src/admin/admin-router.ts` and `src/admin/dashboard-ui.ts`; test `tests/unit/honesty-guard.test.ts`.
- Single labelled illustrative rate constant.

### Task 6: Allow-list edge cases
- Modify `src/core/config.ts`; test `tests/unit/security-web-boundaries.test.ts`.
- Normalize decimal/octal/hex IPv4, `127.0.0.0/8`, IPv4-mapped IPv6.

### Task 7: Port-conflict PID
- Modify `src/index.ts`, `bin/lattice.ts`; test `tests/unit/security-port.test.ts`.
- Include the PID from the error when available; never kill it.

### Task 8: Docs, verification, commit
