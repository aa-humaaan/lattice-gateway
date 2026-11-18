# Consentful Import and Secret Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded, silent credential sync with explicit-path, preview → redact → confirm import behind an honestly-labeled secret-store abstraction.

**Architecture:** A `SecretStore` interface with a file fallback (0600) fronts persisted credentials. Import adapters read only a user-supplied path, produce a redacted preview digest, and require a short-lived confirmation token before writing accounts. The old `sync-local` endpoint is removed.

**Tech Stack:** TypeScript, Bun test, Hono, Node/Bun crypto and fs.

**Spec:** `docs/superpowers/specs/2026-11-18-lattice-phase-c-design.md`

## Global Constraints

- Never read a hardcoded personal path; every source path comes from the operator.
- Preview responses contain no credentials, emails, tokens, cookies, or raw account IDs.
- Confirmation token is short-lived (60s), bound to the preview digest, and single-use.
- Raw secrets never appear in logs, responses, or error messages.
- File fallback is reported as `file-fallback`, never as keychain-backed.
- No new dependencies, provider/network calls, commits, pushes, or history rewrites.

## Review Focus

- Email-derived account IDs leak PII; Task 1 uses random opaque IDs.
- A stale or tampered confirmation token must not import; Task 2 tests digest binding and single-use.
- Preview must not expose tokens; Task 2 asserts redaction on a fixture containing secrets.
- Reading a path the operator did not provide must be impossible; Task 2 asserts no implicit paths.
- Legacy `sync-local` must be gone; Task 3 asserts 404.

---

### Task 1: Secret store abstraction with honest file fallback

**Files:**
- Create: `src/core/secret-store.ts`
- Test: `tests/unit/secret-store.test.ts`

**Interfaces:**
- Produces: `SecretStore` with `get`, `set`, `delete`, `availability`; `createFileSecretStore(filePath)`; `globalSecretStore`.

- [ ] Failing tests: round-trip, key namespacing, 0600 mode where supported, `availability()` returns `file-fallback`, corrupt JSON recovery, missing keys.
- [ ] Implement minimal in-memory map persisted atomically to JSON.
- [ ] Run targeted and full suite.

### Task 2: Consentful import adapters and session manager

**Files:**
- Create: `src/core/account-import.ts`
- Test: `tests/unit/account-import.test.ts`

**Interfaces:**
- Consumes: `SecretStore`.
- Produces: `ImportSource` adapters `jsonAccounts` and `sqlite9router`, `previewImport(path)`, `confirmImport(token)`, `ImportManager`.

- [ ] Failing tests: JSON fixture preview redacts secrets/email, digest-bound 60s single-use token, confirm writes opaque-ID accounts to the pool and secret store, unknown source/path rejected, no hardcoded paths, expired/tampered token rejected.
- [ ] Implement preview/confirm with opaque IDs and redacted summaries.
- [ ] Run targeted and full suite.

### Task 3: Admin routes and removal of silent sync

**Files:**
- Modify: `src/admin/admin-router.ts`
- Test: `tests/unit/admin-dashboard.test.ts`

**Interfaces:**
- Consumes: `ImportManager`.
- Produces: `POST /api/accounts/import/preview`, `POST /api/accounts/import/confirm`, `GET /api/secrets/availability`; legacy `/api/accounts/sync-local` removed.

- [ ] Failing tests: preview response has no secret/email fields, confirm without valid token rejected, availability reports `file-fallback`, `sync-local` returns 404.
- [ ] Replace the old sync block with the three new routes.
- [ ] Run targeted and full suite.

### Task 4: Documentation and verification

**Files:**
- Modify: `README.md`, `SECURITY.md`, `LATTICE_GATEWAY_REPORT.html`
- Create: `.superpowers/sdd/lattice-phase-c4-consentful-import/progress.md`

- [ ] Run `bun run verify` and `bun test`; document explicit-path consent flow and secret-store honesty.
- [ ] Self-review; fix Critical/Important findings test-first; ledger Minors.
