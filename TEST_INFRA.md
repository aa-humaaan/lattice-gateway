# E2E Test Infra: Project Lattice (`lattice-gateway`)

## Test Philosophy
- **Opaque-Box & Requirement-Driven**: Tests interact with Lattice Gateway strictly via external network interfaces (HTTP REST, SSE streams, Admin API, CLI). No private module internals or white-box shortcuts.
- **Hermetic & Deterministic**: The test harness provides controllable mock upstreams (simulating Kilo, Nous, Cline, OpenCode, DeepSeek, and custom LLM servers) with full fidelity over latency, SSE chunks, HTTP status codes (200, 429, 500, 502), and connection drops.
- **Methodology**: 4-Tier Test Matrix derived from `ORIGINAL_REQUEST.md`:
  - **Tier 1**: Feature Coverage (>=5 test cases per feature covering happy paths and equivalence partitions).
  - **Tier 2**: Boundary & Corner Cases (>=5 test cases per feature covering empty inputs, max lengths, malformed JSON, truncated SSE, Unicode, network interruptions).
  - **Tier 3**: Cross-Feature Combinations (Pairwise interactions: streaming + tools, thinking + tools, 429 failover under load, multi-dialect concurrent routing).
  - **Tier 4**: Real-World Application Scenarios (End-to-end agentic workflows simulating real IDEs and agents: Cursor loop, Claude Code loop, Roo-Cline XML tool recovery, 429 failover marathon).

---

## Feature Inventory (Requirement-Driven)
| # | Feature | Requirement Source | Tier 1 Target | Tier 2 Target | Tier 3 Target |
|---|---------|-------------------|:-------------:|:-------------:|:-------------:|
| F1 | OpenAI `/v1/chat/completions` (JSON & SSE) | ORIGINAL_REQUEST § R1 | 5 | 5 | ✓ |
| F2 | Anthropic `/v1/messages` (JSON, SSE & Thinking) | ORIGINAL_REQUEST § R1 | 5 | 5 | ✓ |
| F3 | OpenAI `/v1/responses` Endpoint | ORIGINAL_REQUEST § R1 | 5 | 5 | ✓ |
| F4 | Aggregated `/v1/models` Catalog | ORIGINAL_REQUEST § R1 | 5 | 5 | ✓ |
| F5 | XML Tool-Calling Interceptor | ORIGINAL_REQUEST § R1 & Master Plan | 5 | 5 | ✓ |
| F6 | Universal Error Normalizer (400, 401, 404, 429, 500, 502) | ORIGINAL_REQUEST § R1 | 5 | 5 | ✓ |
| F7 | Plugin: Kilo Code Upstream & Free Models | ORIGINAL_REQUEST § R3 | 5 | 5 | ✓ |
| F8 | Plugin: Nous Research Upstream & Hermes | ORIGINAL_REQUEST § R3 | 5 | 5 | ✓ |
| F9 | Plugin: Cline Pool Upstream & Token Rotation | ORIGINAL_REQUEST § R3 | 5 | 5 | ✓ |
| F10 | Plugin: OpenCode Zen Upstream & Gate Tools | ORIGINAL_REQUEST § R3 | 5 | 5 | ✓ |
| F11 | Plugin: DeepSeek Web Pool Upstream & Sessions | ORIGINAL_REQUEST § R3 | 5 | 5 | ✓ |
| F12 | Multi-Account Round-Robin & Least-Connections Pool | ORIGINAL_REQUEST § R4 | 5 | 5 | ✓ |
| F13 | 429 Rate-Limit Cooldown & Pre-Stream Transparent Failover | ORIGINAL_REQUEST § R4 | 5 | 5 | ✓ |
| F14 | Virtual Model Combos & Hierarchical Fallbacks | ORIGINAL_REQUEST § R4 | 5 | 5 | ✓ |
| F15 | Egress Proxy Rotation (HTTP & SOCKS5) | ORIGINAL_REQUEST § R4 | 5 | 5 | ✓ |
| F16 | Standalone Packaging & Turnkey Launchers | ORIGINAL_REQUEST § R5 | 5 | 5 | ✓ |
| F17 | Admin Dashboard WebUI & REST API | ORIGINAL_REQUEST § R6 | 5 | 5 | ✓ |
| F18 | Real-Time SSE Log Streaming & Playground | ORIGINAL_REQUEST § R6 | 5 | 5 | ✓ |

---

## Test Architecture & Directory Layout
```text
tests/
├── harness/
│   ├── mock-upstream.ts        # Controllable upstream mock server (OpenAI & Anthropic & Custom)
│   ├── test-client.ts          # Dialect client helpers (OpenAI & Anthropic SSE streaming parsers)
│   ├── gateway-runner.ts       # Manages in-process or sub-process Lattice Gateway lifecycle for tests
│   └── assertions.ts           # Dialect and SSE event assertion helpers
└── e2e/
    ├── tier1-feature/
    │   ├── f1-openai-chat.test.ts
    │   ├── f2-anthropic-messages.test.ts
    │   ├── f3-openai-responses.test.ts
    │   ├── f4-models-catalog.test.ts
    │   ├── f5-xml-tool-interceptor.test.ts
    │   ├── f6-error-normalizer.test.ts
    │   ├── f7-plugin-kilo.test.ts
    │   ├── f8-plugin-nous.test.ts
    │   ├── f9-plugin-cline.test.ts
    │   ├── f10-plugin-opencode.test.ts
    │   ├── f11-plugin-deepseek.test.ts
    │   ├── f12-account-pool.test.ts
    │   ├── f13-rate-limit-failover.test.ts
    │   ├── f14-virtual-combos.test.ts
    │   ├── f15-proxy-rotation.test.ts
    │   ├── f16-packaging-launchers.test.ts
    │   ├── f17-admin-api.test.ts
    │   └── f18-log-streaming.test.ts
    ├── tier2-boundary/
    │   ├── boundary-openai.test.ts
    │   ├── boundary-anthropic.test.ts
    │   ├── boundary-xml-split.test.ts
    │   ├── boundary-error-payloads.test.ts
    │   ├── boundary-pool-exhaustion.test.ts
    │   └── boundary-network-abort.test.ts
    ├── tier3-combination/
    │   ├── combo-streaming-tools.test.ts
    │   ├── combo-thinking-tools.test.ts
    │   ├── combo-failover-under-load.test.ts
    │   ├── combo-multidialect-concurrency.test.ts
    │   └── combo-proxy-with-failover.test.ts
    └── tier4-scenarios/
        ├── scenario-cursor-loop.test.ts
        ├── scenario-claude-code-loop.test.ts
        ├── scenario-roo-cline-xml-recovery.test.ts
        ├── scenario-429-failover-marathon.test.ts
        └── scenario-multi-provider-switchboard.test.ts
```

---

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity | Description |
|---|----------|--------------------|------------|-------------|
| S1 | Cursor / Windsurf Multi-Turn Agent Loop | F1, F4, F6, F12, F14 | High | Multi-turn agent executing file edits with tool calling, streaming completions, context expansion, and model combo fallback. |
| S2 | Claude Code Thinking + Tool Use Loop | F2, F4, F6, F12, F13 | High | Authentic Anthropic client protocol invoking multi-turn reasoning with `thinking_delta`, followed by `tool_use` content blocks and `tool_result` handling. |
| S3 | Roo-Cline XML Tool-Calling Recovery | F1, F5, F10 | High | Model streaming raw `<tool_call><function=run_terminal_command>...</tool_call>` chunks; gateway intercepts and converts them cleanly into standard OpenAI `tool_calls` with `finish_reason: "tool_calls"`. |
| S4 | 429 Rate-Limit Failover Marathon | F1, F2, F12, F13, F14 | Critical | Simulates burst load where primary account hits 429 with `Retry-After`; gateway automatically rotates to secondary account, then fallback provider in virtual combo without failing client turns. |
| S5 | Multi-Provider Dynamic Switchboard | F1, F2, F4, F7, F8, F9, F11, F17 | High | Client queries `/v1/models`, switches between Kilo, Nous, Cline, DeepSeek, while Admin API inspects live account pool health and logs. |

---

## Test Runner & Execution
- **Command**: `bun test`
- **Options**:
  - Full suite: `bun test`
  - Tier 1 only: `bun test tests/e2e/tier1-feature`
  - Tier 2 only: `bun test tests/e2e/tier2-boundary`
  - Tier 3 only: `bun test tests/e2e/tier3-combination`
  - Tier 4 only: `bun test tests/e2e/tier4-scenarios`
- **Environment**: Standalone hermetic environment using local mock upstreams and temporary SQLite in-memory or `.tmp` databases.
