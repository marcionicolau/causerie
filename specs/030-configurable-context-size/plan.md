# Implementation Plan: Configurable Context Size

**Branch**: `030-configurable-context-size` | **Date**: 2026-11-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/030-configurable-context-size/spec.md`

## Summary

Let users raise the context size above the shim's fixed 4,096 cap. A new load-time value flows from settings
through the existing typed RPC to the model load, into a new shim entry point that creates the llama context with a
requested `n_ctx` (clamped to the model's trained maximum). Default stays 4,096. The renderer adds a size control to the
model settings, a reload-needed indicator with "Reload now", a memory warning driven by the existing advisor, and a
pre-send warning when a single message exceeds the effective size. A load that fails for memory falls back to 4,096.

## Technical Context

**Language/Version**: TypeScript (strict) on Bun; C (shim `src/native/shim/llama_shim.{c,h}`); React + Tailwind v4 + shadcn (renderer)

**Primary Dependencies**: none new (Principle: no dependency without justification). Uses vendored llama.cpp, Bun FFI, existing RPC

**Storage**: `settings.json` via `src/bun/store/json-store.ts` (new optional `context` block); KV snapshot index already stores `ctxSize`

**Testing**: `bun test ./tests` (scoped); typecheck `bun run typecheck`; lint `bun run lint`; FFI boundary tests per constitution

**Target Platform**: Linux, macOS, Windows desktop (same as the app)

**Project Type**: Electrobun desktop app (main process + renderer)

**Performance Goals**: no change at default size; size change takes effect after one model reload (SC-003)

**Constraints**: offline; in-process inference through Bun FFI (Constitution I); typed RPC only; validate values before the FFI boundary; default 4,096

**Scale/Scope**: settings + one shim function + load path + 3 renderer surfaces; ~20 tasks

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.* Causerie constitution (`.specify/memory/constitution.md`).

| Principle | Status | Note |
|---|---|---|
| Local inference via llama.cpp through Bun FFI | PASS | adds a shim function, keeps in-process FFI |
| Electrobun shell, typed RPC/IPC | PASS | extends `rpc-contract.ts`; no new channel |
| FFI boundary typed and validated | PASS | `contextSize` validated (range, integer) before the call; boundary tests added |
| UI composed from shadcn/ui + Tailwind | PASS | uses existing components |
| No new dependency without justification | PASS | none added |
| Tests, typecheck, lint | PASS | tasks include them |

No violations; Complexity Tracking not needed.

## Project Structure

### Documentation (this feature)

```text
specs/030-configurable-context-size/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── ffi.md          # shim entry point
│   └── rpc.md          # RPC additions
└── tasks.md
```

### Source Code (repository root)

```text
src/native/shim/llama_shim.{c,h}        # lls_ctx_create_ex(model, n_ctx, err); old lls_ctx_create wraps it with 4096
src/bun/llama/ffi.ts                    # symbol + type
src/bun/llama/context-size.ts           # NEW pure resolver: requested → effective + reason
src/bun/llama/engine.ts                 # loadModel(path, {contextSize}); memory-failure retry at default
src/bun/store/json-store.ts             # settings.context { default?, perModel? } + validation
src/shared/types.ts, rpc-contract.ts    # types: ContextSizeSettings, EffectiveContext; load result
src/bun/rpc/handlers.ts                 # load wiring, advisor recommendation apply, preflight check
src/bun/export/{exporter,importer}.ts   # include the new settings block
src/renderer/src/features/models/       # ContextSizeControl, reload-needed, memory warning, effective size display
src/renderer/src/features/chat/         # pre-send oversize message warning
tests/                                  # resolver, store, handlers, FFI boundary, KV-mismatch
```

**Structure Decision**: extend the existing main-process / shared / renderer layout; the only new module is `context-size.ts`.

## Phases
P0 research.md → P1 data-model, contracts, quickstart → tasks.md. Re-check of the Constitution Check after design: unchanged (PASS).
