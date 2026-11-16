# Research — spec 030

## D1 Where the value enters the shim
- **Decision**: add `lls_ctx_create_ex(model, n_ctx, err)`; keep `lls_ctx_create(model, err)` as a wrapper calling it with 4096. `n_ctx == 0` means default 4096. The shim clamps to `llama_model_n_ctx_train` (replacing the current `min(train, 4096)` logic at `llama_shim.c:195-196`).
- **Rationale**: backward compatible ABI; existing tests and callers keep working; only the loader uses the new entry.
- **Alternatives**: change the existing signature (rejected: breaks any prebuilt shim/tests); environment variable (rejected: not a user setting).

## D2 Setting shape
- **Decision**: `Settings.context?: { default?: number; perModel?: Record<string, number> }`, keyed by model file basename like `modelOverrides`. Not part of `GenerationParams`.
- **Rationale**: `GenerationParams` packs into a 32-byte FFI struct for sampling; context size is a load-time property, not a per-request one.
- **Alternatives**: put it in `modelOverrides` (rejected: wrong lifecycle, forces struct changes).

## D3 Resolution rule
- **Decision**: `resolveContextSize({ perModel, global, trainCtx })` → `{ requested, effective, source: "default"|"global"|"model", clampReason: null|"model-maximum" }`; default 4096; effective = min(requested, trainCtx ?? requested); invalid inputs → default.
- **Rationale**: pure and unit-testable; shared by engine, handlers and UI.

## D4 Memory failure recovery
- **Decision**: if `lls_ctx_create_ex` returns an allocation failure at a non-default size, `engine.loadModel` retries once at 4096 and returns `fallback: { requested, effective: 4096, reason: "memory" }`. Never retry when already at 4096.
- **Rationale**: FR-008; one retry bounds load time.

## D5 Warning and recommendation
- **Decision**: reuse `recommendedCtx` (`src/bun/advisor/verdicts.ts`, already surfaced by `handlers.ts` around the advisor response and `ModelLibrary.tsx`). The control compares the chosen size with the recommendation and warns when above; "Apply recommendation" writes it to settings.
- **Rationale**: spec 011 already estimates fit; no new memory model.

## D6 Saved context
- **Decision**: rely on the existing KV snapshot check (`src/bun/kv/store.ts` `lookup(key, fingerprint, ctxSize)` discards a mismatch); add a regression test; make history budgeting read `engine.contextSize()` (the effective value).
- **Rationale**: FR-006 largely holds already; tests lock it in.

## D7 Oversize single message (FR-013)
- **Decision**: before `chat.send`, the main process measures the newest message with `engine.tokenCount` and, if it exceeds the effective size minus a small reserve, returns a typed `message_exceeds_context` result with `neededTokens`; the renderer shows the choice (raise size / send anyway). `send anyway` repeats the call with `force: true`.
- **Rationale**: no silent truncation; uses the existing tokenizer count.

## D8 Export/import
- **Decision**: include `context` in the settings export/import (spec 008 includes `contextLimitWarning` similarly); import validates values.
- **Rationale**: settings parity across machines.
