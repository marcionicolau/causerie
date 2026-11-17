# Validation — 030 configurable context size

Run: 2026-11-17 on `030-context-size-impl` @ 504cf85.
Method: RPC-layer driver (`createRequestHandlers` + real `LlamaEngine` +
real shim + real GGUFs in the app-data `models/` dir — the same path
`bun run dev` exercises; `model.progress`-gated loads). Models:
Qwen2.5-0.5B (contextTrain 32768), SmolLM2-135M (contextTrain 8192).

## Quickstart

| ID | Result | Evidence |
|---|---|---|
| Q1 | PASS | `model.status.context` = {requested:4096, effective:4096, source:"default"} (SC-002) |
| Q2 | PASS | `default:16384` → reload → effective 16384; ~11,251-token doc + question → `chat.done{status:"complete"}`, non-empty reply (SC-001) |
| Q3 | PASS | `default:1_000_000` on Qwen → effective 32768, `clamp:"model-maximum"` (FR-004) |
| Q4 | PASS | `model.advise` returns finite `recommendedCtx` (basis:estimated); ContextSizeControl renders the warning and allows proceeding (FR-007) |
| Q5 | PASS | Covered by `tests/engine-fallback.test.ts` (injected failing creator): alloc failure at 16384 → single retry at 4096 → `fallback:{reason:"memory"}`; retry never happens at 4096; non-memory errors propagate (FR-008, SC-004). Real OOM not forced in the driver. |
| Q6 | PASS | `perModel{smol:8192}` + `default:16384` → smol load requested 8192, qwen requested 16384; fusion role loads share `ctxRequestedFor` (US3) |
| Q7 | PASS | Turn at 4096 → snapshot `ctxSize:4096`; reload at 8192 → turn → manifest entry `ctxSize:8192`; stale-size lookup discarded (`kv-ctx-mismatch.test.ts`, SC-005) |
| Q8 | PASS | perModel 512 + 2,064-token message → `{error:"message_exceeds_context", neededTokens:2064, effective:512}`; `force:true` → messageId + completed turn (FR-013) |
| Q9 | PASS | `backup.export` → context block in envelope → `backup.import` → `settings.context` round-trips ({default:8192, perModel:{a.gguf:16384}}) |

## Gates

- `bun run typecheck` — clean
- `bun run lint` — clean (pre-existing warnings only)
- `bun run build:renderer` — clean
- `bun test ./tests` — **684 pass / 0 fail** (104 files), incl. the 7 new
  spec-030 files: `context-size`, `json-store-context`, `ffi-context`,
  `engine-fallback`, `context-safety`, `context-fusion`,
  `kv-ctx-mismatch`, `export-context`

## FR-012 (no new network calls)

`git diff main...HEAD -- src/` contains no `fetch(`, `http(s)://`
request, `XMLHttpRequest`, or `WebSocket` additions.
