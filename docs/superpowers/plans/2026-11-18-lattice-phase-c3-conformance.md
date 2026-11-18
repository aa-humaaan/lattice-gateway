# Public Dialect Conformance Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish deterministic, executable fixtures proving Lattice’s OpenAI Chat, Anthropic Messages, and OpenAI Responses dialect behavior without provider calls.

**Architecture:** JSON fixtures contain inbound requests, hand-derived canonical/response path expectations, canonical response data, and optional canonical stream events. A small runner selects the real normalizer/serializer/stream adapter, compares semantic paths rather than dynamic bytes, and emits stable JSON results.

**Tech Stack:** TypeScript, Bun, existing dialect engine, JSON fixtures.

**Spec:** `docs/superpowers/specs/2026-11-18-lattice-phase-c-design.md`

## Global Constraints

- No provider/network calls, credentials, timestamps from wall-clock, or random IDs in asserted results.
- Expectations are literal fixture data, never computed by the production function under test.
- Failures identify fixture, stage, path, expected value, and actual value.
- OpenAI Responses streaming is reported unsupported until a real adapter exists; never fabricate a pass.
- No new dependencies, commits, pushes, or history rewrites.

## Review Focus

- Dynamic stream IDs/timestamps must not make results nondeterministic; Task 2 asserts only semantic event/data patterns.
- A fixture with a wrong expected value must fail; Task 1 mutation test proves the runner is not tautological.
- Malformed fixture JSON/schema must fail clearly rather than being skipped; Task 1 tests validation.
- Tool arguments, thinking blocks, usage, and stop-reason mappings must survive round trips; Task 2 covers each.
- Results must sort deterministically regardless filesystem enumeration order; Task 3 tests stable output.

---

### Task 1: Fixture contract and semantic runner

**Files:**
- Create: `src/conformance/runner.ts`
- Create: `tests/unit/conformance.test.ts`

**Interfaces:**
- Produces: `ConformanceFixture`, `ConformanceResult`, `runConformanceFixture(fixture)`, `runConformanceDirectory(path)`.

- [ ] Write failing tests for literal path equality, mismatch diagnostics, malformed fixture rejection, and deterministic result ordering.
- [ ] Implement dialect dispatch, dot/index path lookup, deep literal comparison, schema validation, and stable results.
- [ ] Run targeted tests and full suite.

### Task 2: Public dialect fixtures and streaming checks

**Files:**
- Create: `conformance/fixtures/openai-chat/tools.json`
- Create: `conformance/fixtures/anthropic-messages/thinking-tools.json`
- Create: `conformance/fixtures/openai-responses/basic.json`
- Modify: `src/conformance/runner.ts`
- Test: `tests/unit/conformance.test.ts`

**Interfaces:**
- Consumes: Task 1 runner.
- Produces: fixture coverage for normalize, serialize, and supported stream adapters.

- [ ] Write failing tests requiring all three dialects, tool/thinking/usage/stop invariants, OpenAI and Anthropic stream semantic checks, and an explicit unsupported Responses stream status.
- [ ] Add hand-authored fixtures and stream parsing that ignores dynamic IDs/timestamps while checking event order and semantic payload fragments.
- [ ] Run targeted tests and full suite.

### Task 3: CLI results, documentation and verification

**Files:**
- Create: `scripts/run-conformance.ts`
- Create: `conformance/results.json`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `LATTICE_GATEWAY_REPORT.html`
- Create: `.superpowers/sdd/lattice-phase-c3-conformance/progress.md`

**Interfaces:**
- Consumes: `runConformanceDirectory`.
- Produces: `bun run conformance`, stable `conformance/results.json`, public documentation.

- [ ] Write a failing CLI test proving nonzero exit on failed fixtures and stable output on success.
- [ ] Add the script and package command, generate results, and document exactly what is and is not covered.
- [ ] Run `bun run conformance`, `bun run verify`, and `bun test`; record exact results.
- [ ] Self-review; fix Critical/Important findings test-first and ledger Minor findings.
