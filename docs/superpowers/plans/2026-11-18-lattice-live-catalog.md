# Live Free-Model Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the Free Models list from each connected provider's live `/v1/models` response, free-only, with zero accounts yielding zero models, and harden the store loader.

**Architecture:** An async `buildLiveFreeCatalog()` iterates enabled plugins that have active accounts, calls `syncModels(account)` (live upstream fetch), filters `isFree === true`, and returns enriched items. Static `CANONICAL_FREE_MODELS` and plugin `cachedModels` are removed as fallbacks. `/api/models` uses the live catalog. `LatticeStorage.load()` strips a BOM before parsing.

**Tech Stack:** TypeScript, Bun test, Hono, existing plugin sync.

## Global Constraints
- No static model list may seed the catalog.
- Only free models (`isFree === true`); never show paid models.
- Providers with no active account are never queried and contribute no models.
- No provider network calls during tests — tests inject fake plugin results.
- No commits without explicit approval.

## Review Focus
- Zero accounts must yield zero models with no upstream calls; Task 1 tests it.
- Only free models survive; Task 1 tests a paid model is excluded.
- A provider sync failure must not break other providers; Task 1 tests isolation.
- BOM-prefixed store must load without error; Task 2 tests it.

---

### Task 1: Live catalog
- Create `src/admin/live-catalog.ts`; modify `src/admin/admin-router.ts`, `src/admin/models-catalog.ts`; test `tests/unit/live-catalog.test.ts`.
- Produces `buildLiveFreeCatalog(): Promise<EnrichedModelCatalogItem[]>`.
- Remove `CANONICAL_FREE_MODELS` seeding and `cachedModels` fallback from the models path.
- Wire `/api/models` to the live catalog.
- Run targeted and full suite.

### Task 2: BOM-hardened storage loader
- Modify `src/pool/storage.ts`; test `tests/unit/storage-bom.test.ts`.
- Strip leading `\ufeff` before `JSON.parse`.
- Run targeted and full suite.

### Task 3: Docs, verification, commit
