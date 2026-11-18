# Receipts, Health State, and Quota Leases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the three remaining plan gaps: `lattice why <request-id>`, persisted account health with HalfOpen, and in-flight quota leases charged to the chosen account.

**Architecture:** A receipt builder reads request IDs from the ledger; a health store persists cooldowns atomically off the request path; a lease manager reserves accounts in-flight so concurrent requests do not double-spend quota.

**Tech Stack:** TypeScript, Bun test, existing ledger/pool/plugin seam.

**Spec:** `LATTICE_GATEWAY_REPORT.html` section 10, Phase B and C.

## Global Constraints
- No secrets in ledger, receipt, or health store.
- Health writes debounced and atomic (temp + rename), corrupt file non-fatal.
- Leases expire even if a request never completes.
- No new dependencies, no commits until user approval.

## Review Focus
- A receipt must name the real request and never invent data; Task 1 tests exact field values.
- A restart must restore cooldowns; Task 2 tests round-trip and corrupt recovery.
- Two concurrent requests must not pick the same sole account; Task 3 tests reservation.

---

### Task 1: Receipts CLI
- Modify `src/core/request-ledger.ts`, `src/admin/admin-router.ts`, `src/core/router.ts`; create `src/core/receipt.ts`, `bin/why.ts`; test `tests/unit/receipt.test.ts`.
- Add `requestId` to ledger events, thread `reqId` from all six broadcastLog calls.
- Produce `buildReceipt` and `findLedgerEvent(idPrefix)`.
- CLI accepts prefix, prints structured explanation, exits 1 when not found.
- Run targeted and full suite.

### Task 2: Persisted account health
- Create `src/pool/health-store.ts`; modify `src/pool/account-pool.ts`; test `tests/unit/health-store.test.ts`.
- Atomic keyed-by-account health with Healthy/Cooling/HalfOpen, debounced writes, no secrets, corrupt recovery.
- Run targeted and full suite.

### Task 3: In-flight quota leases
- Modify `src/core/types/canonical.ts`, `src/pool/account-pool.ts`, `src/plugins/*.ts`, `src/core/router.ts`; test `tests/unit/quota-lease.test.ts`.
- Add `accountId` to canonical request; reserve/release/expire leases; charge usage to chosen account; selection avoids leased accounts.
- Run targeted and full suite.

### Task 4: Docs, verification, commit
