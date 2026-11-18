# OS Keychain Secret Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the plaintext file fallback with a real OS-backed secret store on Windows, macOS and Linux, while reporting availability honestly.

**Architecture:** One `SecretStore` facade selects a back end at first use: Windows DPAPI (PowerShell `ProtectedData`, CurrentUser), macOS Keychain (`security` CLI), Linux libsecret (`secret-tool`). A probe verifies the backend before claiming `keychain`; failure falls back to the 0600 file store. Command execution is injectable so tests never touch the real OS store.

**Tech Stack:** TypeScript, Bun test, `child_process.execFileSync`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-18-lattice-phase-c-design.md`

## Global Constraints
- Never spawn an OS command at module import time; selection is lazy.
- `availability()` must never say `keychain` unless a probe succeeded.
- Secrets never appear in logs or error messages.
- Fallback file stays 0600 and git-ignored.
- Opt-in via `LATTICE_SECRET_BACKEND=keychain`; default stays file fallback so existing tests and deploys are unchanged.
- No new dependencies or commits.

## Review Focus
- Probe failure must not be reported as keychain; Task 1 tests it.
- A store-only secret must round-trip through the Windows backend; Task 1 tests with an injected runner.
- Default facade must stay file fallback without spawning anything; Task 2 tests it.
- Existing account credentials must remain unaffected; Task 2 runs the full suite.

---

### Task 1: Backend selection and round-trip
- Modify `src/core/secret-store.ts`; test `tests/unit/keychain-store.test.ts`.
- Produces: `SecretAvailability` extended with `os-dpapi`; `CommandRunner`; `createKeychainStore(options)`.
- Failing tests: platform detection, DPAPI round-trip with fake runner, probe-failure fallback, honest availability.
- Run targeted and full suite.

### Task 2: Lazy global facade and verification
- Modify `src/core/secret-store.ts`, `.gitignore`, docs, ledger.
- Run `bun test` and `bun run verify`; self-review; fix Critical/Important findings test-first; ledger Minors.
