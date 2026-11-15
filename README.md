# 🚀 Project Lattice (`lattice-gateway`)

> **The Universal Plugin-Driven LLM Gateway & Account Pooling Harness**  
> Consolidating Cline, OpenCode, Kilo Code, Nous Research, and DeepSeek into one zero-maintenance, extensible gateway.

---

## 🌟 The Philosophy: Everything is a Plugin
Instead of running 4 separate fragmented daemons on different ports (`3457`, `20128`, `9655`, `8080`), **Project Lattice** implements the **DeepSeek Harness Architecture**:
* **Immutable Core:** High-throughput HTTP/SSE streaming, universal dialect translation (OpenAI ⇄ Anthropic ⇄ Responses), 429 auto-failover, egress proxy rotation, and SQLite/JSON state persistence.
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
│  │  Virtual Model Combos │  │  Egress Proxy Manager │  │  Real-Time Admin Dashboard │  │
│  └───────────────────────┘  └───────────────────────┘  └────────────────────────────┘  │
└────────────────────────────────────────────┬───────────────────────────────────────────┘
                                             │  Unified Plugin Interface
        ┌───────────────────┬────────────────┼───────────────────┬───────────────────┐
        ▼                   ▼                ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐ ┌─────────────┐   ┌─────────────────┐ ┌────────────────┐
│   KILO CODE   │   │ NOUS RESEARCH │ │ CLINE POOL  │   │  OPENCODE ZEN   │ │ DEEPSEEK POOL  │
│  (OAuth/BYOK) │   │ (Portal/OAuth)│ │ (WorkOS RR) │   │ (uTLS Bun / 0$) │ │ (Cookie Pool)  │
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
| **OpenCode Zen** | Keyless Anonymous, API Key | `big-pickle`, `mimo-v2.6-flash-free`, `deepseek-v4.1-flash-free` | uTLS Bun ClientHello & gate tools injection |
| **DeepSeek Web** | Chrome Session / Cookies | `deepseek/deepseek-reasoner`, `deepseek/deepseek-chat` | Thinking token (`<think>`) preservation |

### 3. Virtual Model Combos (Intelligent 429 Fallback)
Define virtual models like `lattice/code-flagship` that route to your favorite model, and if it hits a rate limit or goes down, automatically and transparently fail over to the next provider without breaking your IDE session.

### 4. Glassmorphic Mission Control Dashboard
Sleek dark-mode dashboard at `http://127.0.0.1:4000/admin`:
* Live SSE log stream with per-request latency and provider metrics.
* Real-time account health badges (Active, Cooldown, Expired).
* Interactive plugin toggle and combo management.

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

Project Lattice is battle-tested across **382 automated test suites** spanning 49 test files:
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
