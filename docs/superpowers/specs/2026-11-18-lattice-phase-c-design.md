# Lattice Gateway Phase C Design

## Intent

Make Lattice trustworthy and continuity-first rather than larger. A user should know why the gateway believes a model supports a capability, keep one model/account identity through a working session, and verify each supported client dialect against public fixtures.

## Goals

- Replace anonymous catalogue assertions with signed, traceable model passports.
- Separate `declared`, `discovered`, and `measured` evidence; never present one as another.
- Let explicit model probes update availability evidence without probing providers automatically.
- Keep a session on the same combo target and account while they remain usable.
- Rotate accounts within the same model before changing models; change models only before a turn emits content.
- Publish deterministic OpenAI Chat, Anthropic Messages, and OpenAI Responses conformance fixtures.
- Add account import as preview → redact → confirm; never scan or import silently.
- Put a narrow secret-storage interface in front of persisted credentials, with an explicit file fallback when an OS keychain is unavailable.

## Non-goals

- Adding providers or choosing a different model for each message/task.
- Claiming a health check proves tools, context size, streaming, quality, or price.
- Running paid/provider probes at startup or in tests.
- Seamless handoff after response content has reached a client.
- Rewriting every provider plugin before passports ship.

## Anti-goals

- A signed lie: signatures prove record integrity, not model truth. Every claim must retain its evidence class.
- Hidden account harvesting.
- Session affinity that traps a request on an unhealthy account.
- A conformance badge based only on hand-written expected output with no executable runner.

## Constraints

- Preserve the plugin seam, canonical dialect layer, XML interceptor, combo router, and current dirty working tree.
- No new runtime dependency for passports; use Node/Bun `crypto` Ed25519 and SHA-256.
- No external provider calls during implementation or tests.
- Every behavior change is test-first.
- No commits, history rewrites, credential rotation, or pushes.
- Passport and key files live under `data/`, use restrictive permissions where supported, and remain git-ignored.

## Approaches considered

### 1. Replace the catalogue in one rewrite

Move every model and combo to a new database and delete the static catalogue immediately. Clean end-state, highest migration risk: the dashboard, combo context checks, aliases, and provider caches all depend on today’s shapes.

### 2. Evidence overlay, then make it authoritative — chosen

Observe existing plugin descriptors into signed passports, label legacy static entries as unverified, update passports only from explicit probes, and make combo context selection prefer passport evidence. This ships truthfulness first without blocking on every provider plugin. Once coverage is sufficient, the legacy list can shrink safely.

### 3. Remote signed catalogue

Consume one centrally signed catalogue like FreeLLMAPI. Useful later for distribution, but it transfers trust rather than measuring local provider behavior and creates an unavailable remote dependency.

## Design

### Model passports

`src/core/model-passports.ts` owns stable canonical JSON, an Ed25519 local signing key, persistence, verification, and observation of `ModelDescriptor` values. A passport contains schema version, model/provider IDs, generation time, claims, optional availability, content digest, signer key ID, public key, and signature.

Each claim contains `value`, `source` (`declared`, `discovered`, or `measured`), `observedAt`, and `evidence`. A signature protects that exact record; APIs must also return whether verification succeeds. Unknown values remain absent rather than receiving 128k/8k defaults.

Plugin `listModels()` values enter as `declared` unless a descriptor explicitly marks its catalogue source as `discovered`. Existing hand-maintained catalogue rows remain visible but carry `verificationStatus: "unverified"` until observed. A provider-wide health check is provider evidence and must not create model-level capability claims.

An explicit basic probe executes the requested model with a one-token/simple prompt, measures latency and success, and records only model availability. It does not infer tools, streaming, context, free status, or quality.

### Session continuity

Clients may send `x-lattice-session`; otherwise metadata keys `session_id`, `conversation_id`, or `task_id` may supply affinity. Requests without a key keep current stateless behavior. The canonical request carries an optional `affinity` object rather than provider-specific headers.

A bounded in-memory affinity table stores session → combo target → account hint with idle expiry. Combo routing tries the pinned target first if it still fits context and has quota. Providers that support account hints honor the pinned account first, then another account for the same model. Only a pre-content failure may hand off to another model; successful requests refresh the pin. No message content is persisted.

### Public dialect conformance

Fixtures live in `conformance/fixtures/<dialect>/` as request JSON plus canonical and response expectations. A runner normalizes, serializes, and stream-adapts fixtures without network access and writes `conformance/results.json`. CI/test assertions fail on semantic drift. The result reports dialect, fixture, pass/fail, and exact failed invariant.

### Consentful import and secret storage

Import adapters only read a path the user explicitly submits. Preview returns provider, account count, and redacted identifiers; confirmation requires a short-lived import token bound to the preview digest. Raw secrets never enter logs or preview responses.

`SecretStore` exposes `get`, `set`, `delete`, and `availability`. OS-specific implementations may be added behind it. Until one exists, the gateway reports `file-fallback` honestly and retains mode `0600`; it never labels file storage as keychain-backed.

## Delivery order

1. Signed evidence-first model passports and real explicit basic probes.
2. Session/model/account continuity using passport IDs.
3. Public executable dialect conformance fixtures.
4. Consentful import and secret-store abstraction, then OS keychain implementations.

Each increment must be independently usable and green before the next begins.
