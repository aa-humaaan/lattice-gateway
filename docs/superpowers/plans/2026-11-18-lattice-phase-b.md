# Lattice Gateway — Phase B: make the numbers true

Source: LATTICE_GATEWAY_REPORT.html section 10, Phase B. Ledger: `.superpowers/sdd/lattice-phase-b/progress.md`.

## Global constraints

- Keep Phase A green at every step: 561 tests, `bun run verify` clean.
- No provider credentials used or printed. No history rewrite. No commits (dirty user tree).
- Every behaviour change test-first. No fake numbers anywhere after these tasks.

## Task 1 — Delete fabricated telemetry

Remove seeded `globalTokenMetrics`, the `/api/telemetry/simulate` endpoint, fake fallback log rows, multiplier-based usage stats, hardcoded provider shares, and random "authentic measurement" probes. Update tests that assert the fake behaviour.

## Task 2 — Real request ledger

Add an append-only NDJSON ledger (`data/request-ledger.ndjson`) written by `broadcastLog`. Telemetry, usage stats, provider breakdowns and usage logs derive from it. Estimates are labelled `estimated: true`. Git-ignore the ledger.

## Task 3 — Correctness fixes with small blast radius

- Parse both delta-seconds and HTTP-date `Retry-After`.
- Apply request deadlines to non-streaming `execute()` calls.
- Cap request body size (413 on overflow).
- Make plugin enable/disable authoritative in routing and catalogue.

## Task 4 — Honest failover

- Only effective upstream 429 (or an explicit bounded wrapper) may switch accounts.
- Mid-stream failures before any content token may retry the next combo target; after content, emit a stream error and stop.
- Cap account switches per request.

## Task 5 — Delete vapourware claims

Remove "egress proxy rotation" and "uTLS" claims from README unless implemented. Document the honest feature table.
