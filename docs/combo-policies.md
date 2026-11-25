# Combo policies

A combo is a data definition, not source code. Drop a JSON file into
`src/pool/combo-policies/` and the gateway registers a new virtual model at
startup. No core file, entrypoint or registry edit is needed.

## Format

```json
{
  "id": "lattice/my-combo",
  "name": "Display name",
  "description": "Optional description",
  "useProxies": false,
  "contextWindow": 1048576,
  "policy": {
    "version": 1,
    "strategy": "tier-failover",
    "tiers": ["free", "paid"],
    "maxFailuresPerTier": 2
  },
  "targets": [
    { "model": "kilo/code-fast:free", "tier": "free" },
    { "model": "openai/gpt-4o", "tier": "paid" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Virtual model ID clients request (normally `lattice/<name>`). |
| `name`, `description` | Dashboard metadata. |
| `useProxies` | Optional proxy usage flag, same as legacy combos. |
| `contextWindow` | Optional **verified** context claim. Omit it when unverified; the gateway never infers a window from the model name. |
| `policy.version` | Format version (currently `1`). |
| `policy.strategy` | `tier-failover`: try tiers in declared order, then fall through after a tier's failure budget is spent. |
| `policy.tiers` | Ordered tier names. Targets are grouped by this order, preserving their order within a tier. |
| `policy.maxFailuresPerTier` | Number of failed upstream attempts allowed in a tier before its remaining targets are skipped for that request. Counts execution failures, not context/quota skips. |
| `targets[].model` | Provider model ID passed to the resolver. |
| `targets[].tier` | Must be one of `policy.tiers`. |

## "Free first, after two failures fall back to paid"

Use `tiers: ["free", "paid"]`, `maxFailuresPerTier: 2`, tag the free targets
`free` and the paid targets `paid`. The two free targets are tried first;
once the second free failure occurs, every remaining free target is skipped
for that request and the paid targets are tried in declaration order.

## Context windows

Context windows come only from a verified passport claim or an explicit
`contextWindow` in this file. A model name such as `...1m...` is not evidence.
When no verified claim exists the window is absent, and the combo will not
reject a prompt on context grounds.

## Migration

Legacy `VirtualCombo` definitions and policy files coexist. `lattice/fast-free`
is migrated to `src/pool/combo-policies/fast-free.json`; its targets and order
are unchanged. A policy with a single tier and a very large failure budget
preserves the legacy "try every target" behavior.
