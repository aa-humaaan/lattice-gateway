# Crush Model Report

Snapshot taken: 2026-11-17. Read-only audit, no config or code changes were made.

## Short answers

| Question | Answer |
| --- | --- |
| Are there only 6 one-million-token models from the provider? | **No.** Crush's config declares **8** entries at >=1M context, but 5 of them are synthetic aliases (`auto`, `fusion`, and the three Claude slots) that route to whatever is free. The real 1M models declared in Crush are only **3** (`nemotron-3.5-lightning`, `nemotron-3-ultra-550b`, `nemotron-3.5-super-vl` at exactly 1,000,000). The upstream FreeLLMAPI app actually serves **44 routes reporting >=1M**, of which **8 are currently `available: true`**. The Lattice gateway exposes **15 models >=1M** (12 free, 3 with unknown pricing). The "6" that appears in the admin UI is a hardcoded, stale number. |
| Are all free models from the providers present? | **No.** Crush config lists **79 of the 355** models the FreeLLMAPI provider serves, so **276 are missing** (including 36 unavailable 1M routes). The Lattice gateway catalog lists 64 models, but **6 of them are phantom** entries with no serving plugin, and **5 providers' models are only partly represented** (see gaps below). Also the admin UI counts **all 64** models as "Free" even though **21 are non-free or unknown**. |

## Where the numbers come from

| Source | Location | What it is |
| --- | --- | --- |
| Crush config | `C:\Users\adity\.config\crush\crush.json` | Provider registry Crush reads at startup (2 providers) |
| FreeLLMAPI upstream | `http://127.0.0.1:31415/v1/models` (PID 18872, `FreeLLMAPI.exe`) | The `freellmapi` provider backend: **355 models** |
| Lattice gateway | `http://127.0.0.1:4000/api/models`, `/v1/models` (PID 41432) | The `lattice` provider backend: **64 catalog / 58 served** |

Active Crush selection: `large = lattice/1m-free (lattice)`, `small = auto (freellmapi)`.

## 1. The 1M story

### Crush config (`freellmapi`, 79 declared entries)

Entries with `context_window >= 1_000_000`:

| Context | Model id | Real model or alias |
| --- | --- | --- |
| 1,048,576 | `auto` | alias, router picks any free model |
| 1,048,576 | `fusion` | alias, panel + judge |
| 1,048,576 | `claude-opus-4-5` | alias, "Opus slot (auto-routed to a free model)" |
| 1,048,576 | `claude-sonnet-4-5` | alias, "Sonnet slot (auto-routed to a free model)" |
| 1,048,576 | `claude-haiku-4-5` | alias, "Haiku slot (auto-routed to a free model)" |
| 1,048,576 | `nemotron-3.5-lightning` | real |
| 1,048,576 | `nemotron-3-ultra-550b` | real |
| 1,000,000 | `nemotron-3.5-super-vl` | real |

So the claim "1M models are only 6" does not hold anywhere: 8 declared in Crush, 3 real ones in Crush, 8 available upstream, 15 in the gateway catalog, 12 of them free.

### Upstream provider (FreeLLMAPI, 355 models)

- **44 routes report >=1M context.**
- Only **8 are `available: true`**: the 5 aliases above plus `nemotron-3.5-lightning` (1,048,576), `nemotron-3-ultra-550b` (1,048,576), `nemotron-3.5-super-vl` (1,000,000).
- The other **36 are `available: false`** right now, e.g. `glm-5.3`, `qwen3.8-max`, `gemini-3.8-flash`, `gpt-5.6-luna`, `deepseek-v4-pro`, `minimax-m3`, `gemini-2.5-flash`, `gpt-4.1`.
- **36 of the 79 Crush entries carry `context_window: null` upstream** (Adnes, Ernie, Gemma, Llama RP customs, etc.). Crush masks this by hardcoding `128000` for them, so the displayed context is a guess, not provider data.

### Lattice gateway catalog (15 models >=1M)

| Context | Model | Provider | Free? |
| --- | --- | --- | --- |
| 1,048,576 | `kilo/particle-ai/particle-1:free` | kilo | yes |
| 1,048,576 | `kilo/inclusionai/ling-3.2-flash:free` | kilo | yes |
| 1,024,000 | `kilo/baidu/ernie-5.5-flash-preview:free` | kilo | yes |
| 1,000,000 | `kilo/nvidia/nemotron-3.5-lightning:free` | kilo | yes |
| 1,000,000 | `cline-free/step-5-preview` | cline | yes |
| 1,048,576 | `reflection/beam-free` | cline | yes |
| 1,048,576 | `muse-spark-1.3-contributor-free` | opencode | yes |
| 1,048,576 | `muse-spark-1.2-contributor-free` | opencode | yes |
| 1,000,000 | `nemotron-3-ultra-free` | opencode | yes |
| 1,048,576 | `gemini-2.0-flash` | gemini | claimed free, **no plugin serves it** |
| 1,048,576 | `gemini-2.0-flash-thinking-exp` | gemini | claimed free, **no plugin serves it** |
| 1,048,576 | `lattice/1m-free` | lattice | yes (combo) |
| 1,000,000 | `nous/qwen/qwen4-max` | nous | unknown (`isFree: false`) |
| 1,048,576 | `nous/google/gemini-4-hydrogen` | nous | unknown |
| 1,048,576 | `nous/google/gemini-3.8-flash` | nous | unknown |

The `lattice/1m-free` combo has 7 failover targets, and one of them (`kilo/kilo-auto/free`) is only 128k, so "1M combo" fails over below 1M (the combo engine skips it when the prompt does not fit).

## 2. The free-model story

### Crush config

All 79 `freellmapi` entries declare `pricing: {input:0, output:0}` and the 2 `lattice` entries are $0 combos, so Crush treats every configured model as free. That is a declaration, not a liveliness check: nothing in the config reflects upstream `available: false`.

**Coverage is 79 / 355 = 22%.** 276 upstream models are absent from `crush.json`, including:
`glm-5.3`, `glm-5.3-flash`, `glm-5.2`, `qwen3.8-max`, `qwen3.8-flash`, `qwen3.8-omni-flash`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.7-flash`, `qwen3.6-plus`, `qwen3.5-plus`, `qwen3.5-flash`, `gemini-3.x/2.5` family, `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4.1-flash`, `gpt-5.6-luna`, `gpt-4.1`, `minimax-m3`, `tencent-hy4-preview`, `xiaomi-mimo-v2.6-flash`, `gemini-flash`, `gemma-3-*`, `gemma-4-26b-a4b-it`, `nex-n2.5-pro`, and many RP/hobby models.

Conversely, 36 configured entries report `context_window: null` upstream, so the Crush-side 128k values are fabricated defaults.

### Lattice gateway (`/api/models`)

- **64 catalog entries, 43 flagged `isFree: true`, 21 non-free or unknown.**
- Free by provider: kilo 16, opencode 8, cline 5, deepseek 4, nous 3, groq 3, gemini 2, lattice 2.
- The 21 non-free/unknown entries: `kilo/claude-3-7-sonnet`, `kilo/claude-3-5-sonnet`, `kilo/gpt-4o`, `kilo/stealth/glyph-cluster`, 11 `nous/*` (`hermes-3-*`, `deepseek-v3`, `qwen4-max`, `gemini-4-hydrogen`, `gemini-3.8-flash`, `claude-sonnet-5.5`, `deepseek-v4.1-flash`, `hermes-2-*`), `cline/claude-3-7-sonnet`, `cline/sonnet-agent`, `lattice/code-flagship`.
- `deepseek/*` is hardcoded `isFree: true` in the DeepSeek plugin, which is a claim about the providers rather than a measured price.

### Gateway catalog integrity problems

1. **6 phantom models.** Present in `/api/models` but absent from `/v1/models`, because they exist only in the hardcoded `CANONICAL_FREE_MODELS` list and have no serving plugin (no gemini or groq plugin is registered in `src/index.ts`):
   `kilo/stepfun/step-3.7-flash:free`, `groq/llama-3.3-70b-versatile`, `groq/llama-3.1-8b-instant`, `groq/deepseek-r1-distill-llama-70b`, `gemini-2.0-flash`, `gemini-2.0-flash-thinking-exp`.
2. **The catalog is entirely hardcoded.** Disabling all 6 plugins still returns all 64 entries (verified via `/api/plugins/:id/toggle`), so discovery never removes stale models.
3. **Admin UI numbers are stale literals**, not derived from the API:
   - `dashboard-ui.ts:1481` "6 with 1M context" (actual 15, 12 free)
   - `dashboard-ui.ts:1516` names 6 models, omits `reflection/beam-free`, both `muse-spark-*`, `nemotron-3-ultra-free`, and the gemini entries
   - `dashboard-ui.ts:1606` filter button "1M Context (6)"
   - `dashboard-ui.ts:1384,1480,2108` "31 Free" (actual 43)
   - `dashboard-ui.ts:2443,2928` sets the KPI to `allModels.length + ' Free'`, i.e. all 64 including the 21 non-free ones
   - `dashboard-ui.ts:1512` "31 zero-cost frontier models across 6 upstreams"
4. **One declared combo is missing from Crush.** The store has 3 combos (`lattice/1m-free`, `lattice/code-flagship`, `lattice/fast-free`) but `crush.json` lists only 2 of them; `lattice/fast-free` (200k) is unavailable to Crush.

## 3. Coverage comparison

| Layer | Models | Free | >=1M |
| --- | --- | --- | --- |
| FreeLLMAPI upstream (live) | 355 | 355 claimed, 8 of the 1M routes actually available | 44 routes reporting, 8 usable |
| Crush config `freellmapi` | 79 | 79 declared | 8 declared, 3 real |
| Crush config `lattice` | 2 | 2 | 1 |
| Gateway `/api/models` | 64 | 43 flagged | 15 |
| Gateway `/v1/models` (routable) | 58 | 43 flagged | 13 (2 of the 15 are phantom) |

## Summary

- "Only 6 one-million-token models" is inaccurate at every layer. The real count is 8 usable upstream routes (3 real models + 5 aliases), 3 real declared in Crush, 12 free and 15 total in the gateway catalog. The 6 is a stale hardcoded label in the dashboard.
- "All free models from the providers" is not satisfied. Crush sees 22% of the FreeLLMAPI catalog, the gateway's free list includes 6 models nothing can serve, 21 entries are counted as free when they are not, and 36 Crush context windows are invented defaults rather than provider values.
