# Evidence-First Model Passports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build locally signed model passports whose claims retain their evidence source, expose them through the admin API, and make explicit probes record real model availability.

**Architecture:** Add one focused passport module for canonicalization, Ed25519 signing, verification, persistence, and descriptor observation. The admin catalogue overlays passport status on legacy rows, while combo routing prefers passport context claims without deleting its compatibility fallback yet.

**Tech Stack:** TypeScript, Bun test, Node/Bun `crypto`, JSON persistence, Hono.

**Spec:** `docs/superpowers/specs/2026-11-18-lattice-phase-c-design.md`

## Global Constraints

- Preserve the plugin seam, canonical dialect layer, XML interceptor, combo router, and dirty working tree.
- No new runtime dependencies and no external provider calls during implementation/tests.
- Every behavior change follows red test → minimal implementation → green test.
- Unknown values stay absent; no new 128k/8k guesses.
- Signatures prove record integrity only; evidence source remains visible.
- No commits, pushes, history rewrites, or credential operations.

## Review Focus

- A tampered passport must fail verification; Task 1 tests claim and signature mutation.
- A corrupt/truncated passport file must not crash startup or erase valid in-memory records; Task 2 tests load behavior.
- Concurrent observations of the same model must update one record deterministically; Task 2 tests replacement by newer evidence.
- A provider health check must not become a model capability claim; Task 4 tests the exact probe output.
- Disabled plugins and unknown models must not gain passports or execute probes; Tasks 3 and 4 test both paths.

---

### Task 1: Canonical signed passport records

**Files:**
- Create: `src/core/model-passports.ts`
- Create: `tests/unit/model-passports.test.ts`

**Interfaces:**
- Produces: `ModelPassport`, `PassportClaim<T>`, `createPassportSigner(dataDir: string): PassportSigner`, `verifyPassport(passport: ModelPassport): boolean`, `passportFromDescriptor(model: ModelDescriptor, providerId: string, signer: PassportSigner, observedAt?: number): ModelPassport`.

- [ ] **Step 1: Write failing tests** for deterministic signing, successful verification, tampered claim rejection, tampered signature rejection, absent unknown claims, and `catalogSource` mapping to `declared`/`discovered`.
- [ ] **Step 2: Run** `bun test tests/unit/model-passports.test.ts`; expect missing-module failure.
- [ ] **Step 3: Implement minimal types, stable recursive key ordering, SHA-256 digest, persisted Ed25519 key creation, signing, verification, and descriptor conversion.** Add optional `catalogSource` and `catalogEvidence` to `ModelDescriptor`.
- [ ] **Step 4: Run** `bun test tests/unit/model-passports.test.ts`; expect all Task 1 tests pass.

### Task 2: Crash-safe passport store

**Files:**
- Modify: `src/core/model-passports.ts`
- Modify: `.gitignore`
- Test: `tests/unit/model-passports.test.ts`

**Interfaces:**
- Consumes: Task 1 passport and signer types.
- Produces: `createModelPassportStore(filePath: string, signer: PassportSigner): ModelPassportStore` with `get(id)`, `list()`, `observe(descriptor, providerId, observedAt?)`, `recordAvailability(id, result)`, and `verify(id)`.

- [ ] **Step 1: Write failing tests** for empty store, round-trip persistence, corrupt JSON recovery without overwrite, one-record replacement, invalid stored signature rejection, and measured availability preserving declared capability claims.
- [ ] **Step 2: Run targeted test** and confirm failures name missing store functions.
- [ ] **Step 3: Implement atomic JSON persistence** (`.tmp` then rename), restrictive file mode where supported, signature verification on load, and deterministic newest-record replacement.
- [ ] **Step 4: Ignore** `data/model-passports.json`, `data/model-passport-key.json`, and temporary files.
- [ ] **Step 5: Run targeted test**; expect pass.

### Task 3: Catalogue observation and honest status overlay

**Files:**
- Modify: `src/admin/models-catalog.ts`
- Modify: `src/admin/admin-router.ts`
- Modify: `src/core/router.ts`
- Test: `tests/unit/model-passports.test.ts`
- Test: `tests/unit/admin-dashboard.test.ts`

**Interfaces:**
- Consumes: `ModelPassportStore.observe`, `list`, `verify`.
- Produces: `observeEnabledPluginCatalogs(): Promise<ModelPassport[]>`; admin routes `GET /api/model-passports`, `GET /api/model-passports/:id`, `POST /api/model-passports/refresh`.

- [ ] **Step 1: Write failing tests** proving enabled plugin descriptors become verified passports, disabled plugins are skipped, unknown static rows remain `verificationStatus: "unverified"`, observed rows expose evidence/source, and unknown passport IDs return 404.
- [ ] **Step 2: Run targeted tests**; expect route/module failures.
- [ ] **Step 3: Create one process-wide store** using `DATA_DIR`, observe enabled plugin catalogues only on explicit refresh and existing catalogue reads, and return public passport records with `signatureValid`.
- [ ] **Step 4: Overlay catalogue rows** with `verificationStatus`, `passportDigest`, `claimSources`, and no guessed defaults for newly discovered models.
- [ ] **Step 5: Run targeted tests**; expect pass.

### Task 4: Real explicit model probe

**Files:**
- Modify: `src/admin/models-catalog.ts`
- Modify: `src/admin/admin-router.ts`
- Test: `tests/unit/model-passports.test.ts`
- Test: `tests/unit/m1-features.test.ts`

**Interfaces:**
- Consumes: plugin registry, model resolver, `ModelPassportStore.recordAvailability`.
- Produces: `probeModel(modelId: string, prompt?: string)` that executes that model explicitly and records only measured availability/latency.

- [ ] **Step 1: Write failing tests** proving a successful probe calls `execute` with the requested model and bounded output, records model-scoped availability, never creates tool/context claims, rejects disabled/unknown models, and records failure status without throwing raw credentials/body data.
- [ ] **Step 2: Run targeted tests**; expect old health-check behavior to fail assertions.
- [ ] **Step 3: Replace provider-wide health probe behavior** with a minimal canonical non-streaming request (`maxTokens: 1`, default prompt `Ping`) and sanitized result capture.
- [ ] **Step 4: Run targeted tests**; expect pass.

### Task 5: Passport-backed combo context selection

**Files:**
- Modify: `src/plugins/combo.ts`
- Test: `tests/unit/combo-context-overflow.test.ts`
- Test: `tests/unit/model-passports.test.ts`

**Interfaces:**
- Consumes: `ModelPassportStore.get` and signed `claims.contextWindow`.
- Produces: combo context resolution order: valid passport claim → live plugin descriptor → compatibility heuristic/default.

- [ ] **Step 1: Write failing tests** proving a valid passport context overrides a stale descriptor, a tampered passport is ignored, and an absent context claim falls through without inventing a passport value.
- [ ] **Step 2: Run targeted tests**; expect passport preference failure.
- [ ] **Step 3: Update `getModelContextWindow`** to consume only signature-valid positive passport context claims before existing fallbacks.
- [ ] **Step 4: Run targeted tests**; expect pass.

### Task 6: Verification and truthful documentation

**Files:**
- Modify: `README.md`
- Modify: `LATTICE_GATEWAY_REPORT.html`
- Create: `.superpowers/sdd/lattice-phase-c1/passports-progress.md`

**Interfaces:**
- Consumes: completed Tasks 1–5.
- Produces: accurate operator docs and execution ledger.

- [ ] **Step 1: Run** `bun test`; expect all tests pass.
- [ ] **Step 2: Run** `bun run verify`; expect typecheck, dashboard check, and unit tests pass.
- [ ] **Step 3: Document** what signatures prove, which claims are unverified/declared/measured, that probes are explicit and may consume provider quota, and the local key/passport paths.
- [ ] **Step 4: Record** test counts, rulings, and deferred compatibility fallbacks in the Phase C1 ledger.
- [ ] **Step 5: Self-review** the diff for credential output, automatic provider calls, invented capability claims, and overwrite of pre-existing work.
