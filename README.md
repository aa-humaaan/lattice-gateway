# 🚀 Project Lattice (`lattice-gateway`)

> **The Universal Plugin-Driven LLM Gateway & Account Pooling Harness**  
> Consolidating Cline, OpenCode, Kilo Code, Nous Research, and DeepSeek into one zero-maintenance, extensible gateway.

---

## 🌟 The Philosophy: Everything is a Plugin
Instead of running 4 separate fragmented daemons on different ports (`3457`, `20128`, `9655`, `8080`), **Project Lattice** implements the **DeepSeek Harness Architecture**:
* **Immutable Core:** High-throughput HTTP/SSE streaming, universal dialect translation (OpenAI ⇄ Anthropic ⇄ Responses), 429 auto-failover, an append-only request ledger, and JSON state persistence.
* **Extensible Plugins:** Every upstream provider is an independent, self-contained plugin implementing the `ProviderPlugin` interface. Adding a new provider takes zero changes to core routing.

```
                      ┌──────────────────────────────────────────────┐
                      │          CODING CLIENTS & AGENTS             │
                      │  Cursor / Claude Code / Windsurf / Roo-Cline │
                      └──────────────────────┬───────────────────────┘
                                             │
                       /v1/chat/completions  │  /v1/messages (Anthropic)
                       /v1/responses         │  /v1/models
                                             ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 LATTICE CORE ENGINE                                    │
│  ┌───────────────────────┐  ┌───────────────────────┐  ┌────────────────────────────┐  │
│  │  Dialect Translator   │  │  Streaming / XML Gate  │  │  Account & Cooldown Pool   │  │
│  └───────────────────────┘  └───────────────────────┘  └────────────────────────────┘  │
│  ┌───────────────────────┐  ┌───────────────────────┐  ┌────────────────────────────┐  │
│  │  Virtual Model Combos │  │  Signed Model Passports │  │  Real-Time Admin Dashboard │  │
│  └───────────────────────┘  └───────────────────────┘  └────────────────────────────┘  │
└────────────────────────────────────────────┬───────────────────────────────────────────┘
                                             │  Unified Plugin Interface
        ┌───────────────────┬────────────────┼───────────────────┬───────────────────┐
        ▼                   ▼                ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐ ┌─────────────┐   ┌─────────────────┐ ┌────────────────┐
│   KILO CODE   │   │ NOUS RESEARCH │ │ CLINE POOL  │   │  OPENCODE ZEN   │ │ DEEPSEEK POOL  │
│  (OAuth/BYOK) │   │ (Portal/OAuth)│ │ (WorkOS RR) │   │ (Keyless / 0$) │ │ (Cookie Pool)  │
└───────────────┘   └───────────────┘ └─────────────┘   └─────────────────┘ └────────────────┘
```

---

## 📦 What Ships Out of the Box

### 1. Universal Dialects
* **OpenAI Chat Completions** (`/v1/chat/completions`): Native streaming & JSON for Cursor, Windsurf, Roo, Aider.
* **Anthropic Messages** (`/v1/messages`): Full SSE delta streaming, thinking blocks, and `tool_use` for Claude Code.
* **OpenAI Responses** (`/v1/responses`): Universal support for emerging agentic interfaces.
* **Aggregated Catalog** (`/v1/models`): Aggregates all live models and virtual aliases across all active plugins.

### 2. First-Wave Built-In Plugins
| Provider | Supported Authentication | Default Models Included | Key Feature |
| :--- | :--- | :--- | :--- |
| **Kilo Code** | OAuth, API Key, Org ID | `kilo/claude-3-7-sonnet`, `kilo/code-fast:free`, `kilo/qwen-2.5-coder:free` | `:free` tagged tier & Org ID policies |
| **Nous Research** | Portal OAuth, `sk-nous` keys | `nous/hermes-3-llama3`, `nous/hermes-3-llama-3.1-405b`, `nous/deepseek-v3` | Flagship Hermes agentic reasoning |
| **Cline Pool** | WorkOS OAuth, API Key | `cline/claude-3-7-sonnet`, `cline/sonnet-agent`, `cline-free/mimo-v2.6-flash` | Natural language 429 Retry-After parsing |
| **OpenCode Zen** | Keyless Anonymous, API Key | `big-pickle`, `mimo-v2.6-flash-free`, `deepseek-v4.1-flash-free` | Gate tools injection; live `/v1/models` sync (no uTLS or proxy rotation in this build) |
| **DeepSeek Web** | Chrome Session / Cookies | `deepseek/deepseek-reasoner`, `deepseek/deepseek-chat` | Thinking token (`<think>`) preservation |

### 3. Virtual Model Combos (Intelligent 429 Fallback)
Define virtual models like `lattice/code-flagship` that route to your favorite model, and if it hits a rate limit or goes down, automatically and transparently fail over to the next provider without breaking your IDE session.

### 4. Evidence-First Model Passports
Lattice records model claims in locally signed passports instead of flattening every catalogue value into “fact”:
* `declared` — supplied by a plugin descriptor.
* `discovered` — returned by a provider catalogue endpoint.
* `measured` — observed by an explicit model probe.

Ed25519 signatures protect record integrity; they do **not** certify that a provider's claim is true. Unknown values remain absent. Combo context selection prefers a signature-valid passport, then falls back to the live plugin descriptor and legacy compatibility rules.

Admin APIs:
* `POST /api/model-passports/refresh` observes enabled plugin catalogues.
* `GET /api/model-passports` and `GET /api/model-passports/:id` expose evidence and signature validity.
* `POST /api/models/probe` executes the selected model with a one-token output limit and records model availability only. It is never run automatically and may consume provider quota.

Local records live at `data/model-passports.json`; the private signing key lives at `data/model-passport-key.json`. Both are git-ignored and created with restrictive permissions where the OS supports them.

### 5. Session Continuity & Cache Locality
Send `x-lattice-session: <your conversation id>` to keep a conversation on the same combo target and provider account while both remain usable. Lattice hashes the identifier before storing it, keeps no prompts or message content, and holds affinity in memory only.

* Idle affinity expires after 30 minutes; the store is capped at 10,000 sessions.
* A healthy pinned account is tried first. A cooling, missing, or failed account rotates to another account for the **same model** before combo fallback.
* A combo may change models only before response content is emitted. After content starts, an upstream failure is reported instead of splicing another model into the turn.
* Requests without the header (or explicit `metadata.session_id`, `conversation_id`, or `task_id`) remain stateless.
* `GET /api/session-affinity` exposes hashed session IDs, target/account pins, and expiry—never raw session IDs, prompts, or credentials.

Affinity is deliberately not persisted across gateway restarts. This prevents a routing optimization from becoming a conversation-history store.

### 6. Glassmorphic Mission Control Dashboard
Sleek dark-mode dashboard at `http://127.0.0.1:4000/admin`:
* Live SSE log stream with per-request latency and provider metrics.
* Real-time account health badges (Active, Cooldown, Expired).
* Interactive plugin toggle and combo management.

### 7. Consentful Account Import
Lattice never reads a hardcoded local path. To bring accounts in from an export:
1. `POST /api/accounts/import/preview` with `{ "source": "jsonAccounts", "path": "<your file>" }`. The response contains only the provider list, account count, and a short-lived token—no tokens, emails, or raw account IDs.
2. `POST /api/accounts/import/confirm` with `{ "token": "..." }`. Imported accounts receive opaque random IDs, and their secrets live separately in `data/lattice-secrets.json` (0600).
3. `GET /api/secrets/availability` reports the real storage backend. The default is `file-fallback`; no keychain claim is made without a working OS backend.

An OS-backed secret store is available as an opt-in. Set `LATTICE_SECRET_BACKEND=keychain` before starting the gateway:
- **Windows** — DPAPI (`ProtectedData`, CurrentUser) via PowerShell; availability reports `os-dpapi`. Secrets are encrypted by the OS for the current user account.
- **macOS** — Keychain via the `security` CLI; availability reports `keychain`.
- **Linux** — libsecret via `secret-tool`; availability reports `keychain`.

Selection happens lazily on first use and is probe-gated: if the tool or DPAPI round-trip fails, the gateway silently falls back to the 0600 file and reports `file-fallback`. No OS command runs at import time.

Confirmation tokens are bound to the preview digest, expire after 60 seconds, and are single-use. The old one-click `sync-local` endpoint is gone.

Imported accounts are live. Provider plugins resolve credentials through the secret store for accounts with the `acc_import_` prefix, so the stored secret reaches the outbound Authorization header. The account record itself stays free of the secret, which means `data/lattice-store.json` never re-absorbs imported credentials. Accounts added normally keep using their own credentials unchanged.

### 8. Passive Capability Learning
Model passports learn from traffic instead of guesses. A real tool call, thinking block, accepted stream, or context-overflow error upgrades the matching claim from `declared` to `measured` in the signed record. No extra provider call is made, no negative claim is ever emitted, and identical observations are deduplicated so hot routes don't rewrite the passport file. A catalogue refresh cannot downgrade a measured claim.

### 9. Public Dialect Conformance
Run `bun run conformance` to execute network-free public fixtures through the real normalizers, serializers, and supported stream adapters. Results are written deterministically to `conformance/results.json`. OpenAI Chat covers tools and SSE, Anthropic Messages covers thinking/tools/SSE, and OpenAI Responses covers JSON while honestly reporting streaming as unsupported.

---

## 🚀 Quickstart

### Method A: Windows Turnkey Launchers (Recommended)
Simply double click:
👉 **`start.bat`** (or run `.\start.ps1` in PowerShell)

### Method B: Standalone Binary
```bash
./bin/lattice.exe
```

### Method C: Run from Source with Bun
```bash
bun install
bun test
bun run src/index.ts
```

---

## ⚙️ Connecting Your Coding Tools

### 1. Claude Code
In `~/.claude/settings.json`:
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4000"
  }
}
```

### 2. Cursor / Windsurf / Roo-Cline
* **Base URL:** `http://127.0.0.1:4000/v1`
* **API Key:** any string (e.g. `sk-lattice-local`)
* **Model:** pick any model from `/v1/models` (e.g., `kilo/claude-3-7-sonnet`, `nous/hermes-3-llama3`, `lattice/code-flagship`).

---

## 🧪 Testing & Verification

Project Lattice is tested by **662 automated tests** spanning 81 test files:
```bash
bun test
```
* **Tier 1:** 111 individual feature and dialect normalizer tests.
* **Tier 2:** 35 boundary and error edge case tests.
* **Tier 3:** 25 multi-feature concurrency and race condition tests.
* **Tier 4:** Real-world IDE simulation loops (Cursor refactoring, Claude Code thinking + tool chains, Roo-Cline XML tool-calling recovery, 429 failover marathon).

---

## 📜 License
MIT License. Built for Aditya (@aa-humaaan) by Micee.
