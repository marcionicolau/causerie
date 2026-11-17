# Data model — spec 030

## ContextSizeSettings (persisted, in `settings.json` → `context`)
| Field | Type | Rule |
|---|---|---|
| `default` | integer, optional | 512 ≤ value ≤ 1,048,576; absent → 4096 |
| `perModel` | map basename → integer, optional | same range; takes precedence over `default` |
Invalid or out-of-range values are dropped on load (fallback to the next level, then 4096). Unknown keys ignored.

## EffectiveContext (runtime, returned by model load and shown in the UI)
| Field | Type | Meaning |
|---|---|---|
| `requested` | integer | value resolved from settings |
| `effective` | integer | value the context was created with |
| `source` | `"default" \| "global" \| "model"` | which setting won |
| `clamp` | `null \| "model-maximum"` | present when requested > trained maximum |
| `fallback` | `null \| { reason: "memory" }` | present when the load retried at 4096 |

## KV snapshot index entry (existing)
`ctxSize` already stored; lookups with a different value return null (discard). No schema change.

## Preflight result (chat send)
`{ ok: true } | { ok: false, error: "message_exceeds_context", neededTokens: integer, effective: integer }`
