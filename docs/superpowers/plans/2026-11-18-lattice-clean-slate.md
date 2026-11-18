# Clean Slate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the dashboard truthful with zero accounts, remove the unwanted FreeLLMAPI plugin everywhere, and remove hard-coded credentials/personal paths so the operator can add their own accounts via OAuth.

**Architecture:** Availability requires an active account on a real provider (keyless providers excluded). FreeLLMAPI is deleted from files, entrypoints, catalog, combos, resolver and UI. Hard-coded harness tokens and personal paths become generated/dynamic values.

**Tech Stack:** TypeScript, Bun test, Hono, existing plugin/registry seam.

## Global Constraints
- With zero accounts, `/api/models` returns zero models (combos included).
- No `freellmapi` string in shipped source; plugin file deleted.
- No personal absolute paths or hard-coded provider credentials in source.
- No commits without explicit approval; no history rewrite.

## Review Focus
- Zero accounts must yield zero models; Task 1 tests it.
- FreeLLMAPI removal must not leave dangling combo targets; Task 2 tests it.
- Harness config must use a generated token, not a literal; Task 3 tests it.

---

### Task 1: Availability requires configured accounts
- Modify `src/admin/models-catalog.ts`, `src/admin/dashboard-ui.ts`; test `tests/unit/clean-slate.test.ts`.
- Remove KEYLESS_PROVIDERS exception; delete static "31" strings and hard-coded provider lists; counts come from live data.
- Run targeted and full suite.

### Task 2: Delete FreeLLMAPI everywhere
- Delete `src/plugins/freellmapi.ts`; modify both entrypoints, admin-router, models-catalog, combos, combo, resolver, dashboard; update tests.
- Remove 8 static catalog entries and combo targets; keep the default combos functional via remaining providers.
- Run targeted and full suite.

### Task 3: Remove hard-coded credentials and paths
- Modify `src/admin/harness-manager.ts`, `src/plugins/opencode.ts`, `src/admin/admin-router.ts`; test `tests/unit/clean-slate.test.ts`.
- Replace `sk-lattice-master` with a generated token from auth-tokens; remove personal `C:\Users\adity\...` path; remove fallback emails.
- Run targeted and full suite.

### Task 4: Docs, verification, commit
