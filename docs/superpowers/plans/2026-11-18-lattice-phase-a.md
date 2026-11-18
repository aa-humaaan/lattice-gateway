# Lattice Gateway — Phase A rescue plan

Source: LATTICE_GATEWAY_REPORT.html, section 10 "The rescue plan", Phase A (days 1–7).
Execution mode: inline, no per-task subagents. Ledger: `.superpowers/sdd/lattice-phase-a/progress.md`.

## Global constraints

- Do not rewrite the engine. Keep the plugin seam, dialect layer and combo router.
- Treat all pre-existing uncommitted work as the user's; never overwrite or delete it wholesale.
- Every behaviour change gets a test written first and watched failing before implementation.
- No provider credentials are used, rotated externally, or printed. Token rotation at providers is the user's action.
- No history rewrites or pushes. Removing the store from git index is allowed; scrubbing history is documented, not performed.
- Full suite (`bun test`) green after every task. Typecheck green by task A5.

## Task 1 — Remove live credentials from version control

- Add `data/lattice-store.json` to `.gitignore`; untrack it with `git rm --cached` while leaving the local file intact.
- Add `SECURITY.md` with rotation + history-scrub instructions and a clear "do this first" order.
- Test: `git check-ignore -q data/lattice-store.json` succeeds and the path is absent from `git ls-files`.

## Task 2 — Lock the control plane

- Add optional `gatewayToken` / `adminToken` to `GatewayConfig`; when configured, require Bearer token on `/v1/*` and on `/api/*` + `/admin` respectively.
- Generate/persist a random gateway token at application entrypoints (`src/index.ts`, `bin/lattice.ts`) and print it once at startup.
- Default CORS to explicit loopback origins; reject requests carrying a foreign `Origin` header.
- Test: configured token required; wrong token 401; no Origin blocked; allowed Origin passes.

## Task 3 — Stop returning credentials

- `/api/oauth/status` returns a redacted account summary, never tokens.
- `POST /api/accounts` never echoes credentials back.
- OAuth session ids become random UUIDs with expiry and cleanup.
- Update the existing test that asserts the leaking response.
- Test: no `accessToken`/`refreshToken` in any response body; session id not timestamp-shaped.

## Task 4 — Stop killing unrelated processes

- Remove taskkill / Stop-Process / netstat-kill from `start.bat`, `start.ps1`, `src/index.ts`, `bin/lattice.ts`.
- On port conflict: report the owning process and exit with a clear message, or choose another port only when explicitly configured.
- Test: static assertions over launcher/entrypoint sources plus a unit test of the new "port busy" message.

## Task 5 — Make typecheck green

- Fix the three `src/plugins/freellmapi.ts` type errors (`checkedAt` missing twice, canonical stream event types).
- Ensure `bun run verify` passes end to end.

## Task 6 — Pull forward the two critical web-facing fixes from Phase B

Ruling: the report places SSRF/XSS hardening in Phase B, but the code audit ranked them P0 and the fixes are small; doing them in A6 prevents shipping an insecure Phase A.
- Allow-list upstream `baseUrl` (https by default, private/link-local blocked unless explicitly configured).
- Escape all dashboard `innerHTML` interpolations of account fields.
- Test: private/link-local baseUrl rejected; `<img onerror=...>` in account id stays inert text.
