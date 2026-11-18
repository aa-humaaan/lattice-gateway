# Session Continuity and Cache Locality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep an opted-in session on the same combo target and provider account while healthy, rotate accounts before models, and never persist message content.

**Architecture:** A bounded in-memory affinity store owns hashed session keys, target pins, and per-provider account pins. Router ingress derives affinity from `x-lattice-session` or explicit metadata; combo routing and account-aware plugins consume the same store. Stateless requests preserve current behavior.

**Tech Stack:** TypeScript, Bun test, Node/Bun SHA-256, existing canonical request and plugin interfaces.

**Spec:** `docs/superpowers/specs/2026-11-18-lattice-phase-c-design.md`

## Global Constraints

- No message content, prompts, raw session identifiers, or credentials in affinity state.
- Session keys are SHA-256-derived fixed identifiers; header takes precedence over metadata.
- Default idle TTL is 30 minutes; default maximum is 10,000 sessions; oldest idle entry is evicted at capacity.
- Requests without affinity remain stateless and retain existing routing behavior.
- A pinned unhealthy/cooling account may rotate to another account for the same provider/model.
- Combo model handoff remains legal only before content emission.
- No new dependencies, provider calls in tests, commits, pushes, or history rewrites.

## Review Focus

- Attacker-controlled unbounded session IDs must not produce unbounded memory or raw-ID retention; Task 1 tests hashing, TTL and capacity.
- Two sessions must not share target/account pins; Tasks 1, 3 and 4 test isolation.
- A disabled, missing, cooldown, or already-tried pinned account must not be selected; Task 4 tests fallback ordering.
- Metadata must not override an explicit header, and unrelated metadata must stay stateless; Task 2 tests precedence.
- Stream failures before content may change target, but post-content failures must not repin or hand off; Task 3 tests both.

---

### Task 1: Bounded session affinity store

**Files:**
- Create: `src/core/session-affinity.ts`
- Create: `tests/unit/session-affinity.test.ts`

**Interfaces:**
- Produces: `SessionAffinityStore`, `createSessionAffinityStore(options?)`, `globalSessionAffinityStore`, `deriveSessionKey(headers, body)`, `getTarget`, `pinTarget`, `getAccount`, `pinAccount`, `listSummary`.

- [ ] Write failing tests for deterministic hashing, no raw identifier retention, header/metadata precedence, TTL expiry, LRU-style capacity eviction, isolated target/account pins, and empty stateless input.
- [ ] Run `bun test tests/unit/session-affinity.test.ts`; expect missing-module failure.
- [ ] Implement the minimum bounded map and extraction helpers.
- [ ] Run the targeted test and full suite; expect green.

### Task 2: Preserve affinity at ingress

**Files:**
- Modify: `src/core/types/canonical.ts`
- Modify: `src/core/router.ts`
- Test: `tests/unit/session-affinity.test.ts`
- Test: `tests/unit/server.test.ts`

**Interfaces:**
- Consumes: `deriveSessionKey`.
- Produces: `CanonicalRequest.affinity?: { sessionKey: string }` on all three dialect routes.

- [ ] Write failing route tests proving Chat, Messages, and Responses propagate the same hashed header session key, metadata fallback works, and absent identity stays undefined.
- [ ] Pass real request headers/body to the affinity resolver after normalization; do not alter public response shapes.
- [ ] Run targeted tests and full suite.

### Task 3: Session-pinned combo target

**Files:**
- Modify: `src/plugins/combo.ts`
- Test: `tests/unit/session-affinity.test.ts`
- Test: `tests/unit/security-correctness.test.ts`

**Interfaces:**
- Consumes: `CanonicalRequest.affinity`, `SessionAffinityStore.getTarget/pinTarget`.
- Produces: pinned-target-first ordering and successful target pinning for non-stream and stream paths.

- [ ] Write failing tests proving repeated turns use the pinned target, separate sessions remain isolated, an unavailable pin falls through, a pre-content failure repins the successful fallback, and a post-content failure does not change the pin.
- [ ] Inject the affinity store as the second optional `LatticeComboPlugin` constructor dependency after the passport store.
- [ ] Reorder a copy of combo targets; never mutate combo configuration. Pin only after non-stream success or first content-bearing stream event.
- [ ] Run targeted tests and full suite.

### Task 4: Session-pinned provider account

**Files:**
- Modify: `src/plugins/kilo.ts`
- Modify: `src/plugins/nous.ts`
- Modify: `src/plugins/cline.ts`
- Modify: `src/plugins/deepseek.ts`
- Test: `tests/unit/session-affinity.test.ts`
- Test: `tests/unit/intra-model-rotation.test.ts`

**Interfaces:**
- Consumes: `SessionAffinityStore.getAccount/pinAccount` and `CanonicalRequest.affinity`.
- Produces: preferred active account first; same-model account rotation on failure; successful account pin refresh.

- [ ] Write failing helper/integration tests proving a pinned account wins over round-robin, cooling/missing pins fall through, 429 rotates within the same model and repins the successful account, streams use the pinned account, and sessions stay isolated.
- [ ] Add optional affinity-store constructor dependencies without breaking existing call sites.
- [ ] Update account selection in Kilo, Nous, Cline and DeepSeek non-stream/stream paths; pin only after upstream acceptance/success.
- [ ] Run targeted tests and full suite.

### Task 5: Visibility, documentation and verification

**Files:**
- Modify: `src/admin/admin-router.ts`
- Modify: `README.md`
- Modify: `LATTICE_GATEWAY_REPORT.html`
- Create: `.superpowers/sdd/lattice-phase-c2-session-continuity/progress.md`
- Test: `tests/unit/admin-dashboard.test.ts`

**Interfaces:**
- Consumes: `SessionAffinityStore.listSummary`.
- Produces: `GET /api/session-affinity` with hashed IDs, target/provider/account pins and expiry only.

- [ ] Write a failing API test proving no raw session IDs, prompts, or credentials appear.
- [ ] Add the read-only admin endpoint and document opt-in header, TTL/capacity, rotation semantics, and memory-only lifecycle.
- [ ] Run `bun run verify` and `bun test`; record exact results.
- [ ] Complete one review pass; fix Critical/Important findings test-first and ledger Minor findings.
