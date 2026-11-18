# Credential Resolution Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make imported accounts usable by having provider plugins resolve credentials through the secret store instead of reading only `account.credentials`.

**Architecture:** A single `CredentialResolver` returns a merged credentials object (secret-store values overlay account values) without mutating the account, so secrets never get persisted back into `data/lattice-store.json`. Each plugin's credential read sites call it.

**Tech Stack:** TypeScript, Bun test, existing SecretStore and plugin seam.

**Spec:** Phase C4 gap documented in `LATTICE_GATEWAY_REPORT.html` and `README.md`.

## Global Constraints
- Never mutate `account.credentials` — globalStorage.save() would re-persist secrets into the tracked-format store.
- Secret-store values take precedence over account-record values.
- Missing secrets fall back to existing credentials so non-imported accounts are unchanged.
- No new dependencies, provider calls, commits, pushes, or history rewrites.

## Review Focus
- A secret from the store must reach the outbound Authorization header; Task 2 tests this end-to-end.
- The account record must remain free of the secret after resolution; Task 1 asserts non-mutation.
- Cookies and customData must keep working for existing accounts; Task 2 covers deepSeek.
- Refresh writes must not silently drop a refreshed token for an imported account; ledger a ruling.
- Typecheck must stay green across all six plugin edits; Task 3 verifies.

---

### Task 1: CredentialResolver
- Create `src/core/credential-resolver.ts`; test `tests/unit/credential-resolver.test.ts`.
- Produces: `CredentialResolver`, `createCredentialResolver(store)`, `globalCredentialResolver`.
- Failing tests: overlay precedence, account not mutated, missing secret falls back, string cookies pass through.
- Run targeted and full suite.

### Task 2: Wire plugin read sites
- Modify `src/plugins/kilo.ts`, `nous.ts`, `cline.ts`, `deepseek.ts`, `opencode.ts`, `freellmapi.ts`.
- Test: `tests/unit/credential-resolver.test.ts` (end-to-end with mock upstream).
- Failing test: an imported opaque-ID account with only a secret-store apiKey produces the right Authorization header through a real Kilo execute.
- Run targeted and full suite.

### Task 3: Docs and verification
- Update `README.md`, `LATTICE_GATEWAY_REPORT.html`, and the Phase C ledger.
- Run `bun run verify` and `bun test`; self-review; fix Critical/Important findings test-first; ledger Minors.
