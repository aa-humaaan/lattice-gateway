# OpenCode Connect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give OpenCode a real connect flow so it can be added back after deletion, supporting both keyless and API-key modes.

**Architecture:** Add a backend `POST /api/oauth/opencode/connect` that registers an active anonymous (keyless) OpenCode account, and an optional API-key path through the existing `/api/accounts`. Update the dashboard to offer a Connect button and a keyless/API-key form for OpenCode instead of the dead "already active" message.

**Tech Stack:** TypeScript, Bun test, Hono, existing account pool.

## Global Constraints
- The keyless account must be `active` with `authType: 'anonymous'` so the live catalog includes OpenCode.
- No credentials are hardcoded; keyless uses minted sessions, API key is user-supplied.
- Tests use in-process app; no upstream calls.
- No commits without explicit approval.

## Review Focus
- Connecting keyless produces an active account and OpenCode models appear; Task 1 tests it.
- Deleting then reconnecting works (no stale state); Task 1 tests it.
- API-key path still works; Task 1 tests it.

---

### Task 1: Backend connect endpoint
- Modify `src/admin/admin-router.ts`; test `tests/unit/opencode-connect.test.ts`.
- Add `POST /api/oauth/opencode/connect` registering `{ id: acc_opencode_keyless_<short>, providerId: 'opencode', authType: 'anonymous', status: 'active', credentials: {} }` and wiring the plugin.
- Verify `/api/models` then includes OpenCode free models from live sync (test via fake plugin injection).
- Run targeted and full suite.

### Task 2: Dashboard connect UI
- Modify `src/admin/dashboard-ui.ts`; test `tests/unit/opencode-ui.test.ts`.
- Add Connect button for OpenCode; replace dead message with keyless button + API-key form; update submit path.
- Run targeted and full suite.

### Task 3: Docs, verification, commit
