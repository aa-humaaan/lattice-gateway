# Project Lattice (`lattice-gateway`)

Universal, extensible LLM Gateway and Harness where all upstream providers are standalone plugins.

## Features
- Core Gateway Engine & Dialect Translation:
  - OpenAI `/v1/chat/completions` (JSON & SSE)
  - Anthropic `/v1/messages` (JSON, SSE & Thinking Blocks)
  - OpenAI `/v1/responses`
  - Aggregated `/v1/models` catalog
  - XML Tool-Calling Interceptor
  - 15s keepalive ping heartbeat
  - Dialect-compliant error normalization

## Quickstart
```bash
bun install
bun test
bun run src/index.ts
```
