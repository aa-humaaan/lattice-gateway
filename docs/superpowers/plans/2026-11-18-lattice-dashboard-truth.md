# Dashboard Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the dashboard show only models from configured providers and replace every hard-coded number with live data or an honest empty placeholder.

**Architecture:** `getEnrichedModelsCatalog` gains an `available` flag derived from active accounts (or keyless backends); `/api/models` hides unavailable models by default. Dashboard KPIs start at `--` and are populated from real endpoints, with badges refreshed centrally.

**Tech Stack:** TypeScript, Bun test, Hono, existing dashboard.

## Global Constraints
- Deleting all accounts must leave zero models shown in Free Models for credentialed providers.
- Keyless local backends (opencode, freellmapi) remain available when enabled.
- No fake numbers anywhere in shipped HTML; `--` until fetched.
- No new dependencies; no commits without explicit approval.

## Review Focus
- A provider with zero active accounts must not contribute models; Task 1 tests it.
- An `available` flag must be honest for combos too; Task 1 tests it.
- Dashboard must contain no hard-coded token/account/plugin counts; Task 2 asserts it.

---

### Task 1: Catalog availability
- Modify `src/admin/models-catalog.ts`, `src/admin/admin-router.ts`; test `tests/unit/availability.test.ts`.
- Add `available` + `unavailableReason` to `EnrichedModelCatalogItem`; derive from `globalAccountPool` active accounts, keyless backends, plugin enable state, and combo target availability.
- `/api/models` returns only available models unless `?all=true`.
- Run targeted and full suite.

### Task 2: Dashboard hard-coded values
- Modify `src/admin/dashboard-ui.ts`; test `tests/unit/dashboard-truth.test.ts`.
- Replace all hard-coded KPI/badge numbers with `--`; add `refreshBadges()` and ensure every KPI is fed by a live fetch.
- Run targeted and full suite.

### Task 3: Docs, verification, commit
