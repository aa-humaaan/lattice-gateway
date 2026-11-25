# Router Breaker Single-Owner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the router the single owner of per-request breaker gating and outcome recording, so a 5xx storm stops provider calls and a mid-stream death opens the breaker.

**Architecture:** `router.ts` gates every dialect/path once with `globalBreakerRegistry.get(providerId).allow()` and records outcomes directly on that breaker. Remove the duplicate recorder from `account-pool.ts`. Stream success is recorded only after the stream is delivered to completion; errors record exactly one failure.

**Tech Stack:** TypeScript, Bun, Hono.

**Spec:** Design approved in conversation 2026-11-24 (single recorder in router, single `allow()` gate, remove account-pool recorder).

## Global Constraints

- One failure recorded per failed request; gated requests (no provider call) record nothing.
- Keyless/non-accounted paths must be gated identically to accounted paths.
- `combo.ts` keeps its per-target breaker recording (different breaker keys, internal failover).
- Do not call `breaker.beginAttempt()` in the router gate; existing allocators own probe lifecycle.

## Review Focus

- Mid-stream iterator throw with no `stream_error` event → one failure, not a success.
- Client abort → no outcome recorded, no usage logged.
- `stream_error` followed by iterator end → one failure, not two.
- Breaker already open at request start → no provider call and no failure record.
- Half-open `allow()` path → request permitted, outcome recorded once.

---

### Task 1: Behavioral tests (failing first)

**Files:**
- Create: `tests/unit/router-breaker.test.ts`
- Modify: `tests/unit/part4-adversarial.test.ts:230-272`

**Interfaces:**
- Consumes: `createServer` from `src/core/server`, `globalBreakerRegistry` from `src/core/breaker`, `GatewayError`, `ProviderPlugin` types.
- Produces: three behavioral assertions — gated keyless storm, six mid-stream deaths open breaker, failures == failed call count.

- [ ] **Step 1: Write tests for the three behaviors**
- [ ] **Step 2: Run `bun test tests/unit/router-breaker.test.ts` — expect FAIL**
- [ ] **Step 3: Flip stale ADV-5 unit test to assert the fix (provider not reached after breaker opens)**

### Task 2: Router gate + single recorder

**Files:**
- Modify: `src/core/router.ts` (imports, three handlers)
- Modify: `src/pool/account-pool.ts:183-190` (delete two methods)

**Interfaces:**
- Produces: `gateProvider(providerId: string): void` local helper in `router.ts`.

- [ ] **Step 1: Add `gateProvider` helper and call after `resolveProvider()` in all three handlers**
- [ ] **Step 2: Replace `globalAccountPool.reportProviderSuccess/Failure` with direct breaker calls**
- [ ] **Step 3: Delete `reportProviderFailure`/`reportProviderSuccess` from `account-pool.ts`**
- [ ] **Step 4: Run behavioral tests — expect PASS for non-stream paths**

### Task 3: Stream outcome after delivery

**Files:**
- Modify: `src/core/router.ts` (three stream generators)

- [ ] **Step 1: Remove early success-on-headers in all three stream branches**
- [ ] **Step 2: Add `settled` guard; success only on clean completion, failure on stream_error/throw/early end**
- [ ] **Step 3: Run behavioral tests — expect PASS**

### Task 4: Verification

- [ ] **Step 1: `bun run typecheck`**
- [ ] **Step 2: `bun test tests/unit`**
- [ ] **Step 3: `bun run tests/audit/fixtures/breaker-gate.ts` — expect `failures=3`, `calls=3`**
