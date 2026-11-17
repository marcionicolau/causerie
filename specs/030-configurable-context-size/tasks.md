---
description: "Task list for spec 030 — configurable context size"
---

# Tasks: Configurable Context Size

**Input**: `specs/030-configurable-context-size/` — plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md
**Tests**: included where the constitution requires them (FFI boundary) and where a regression must be locked (default 4096, KV mismatch).
**Format**: `- [ ] T### [P?] [US#?] Description with path`

## Phase 1: Setup

- [ ] T001 Confirm a green baseline on a clean checkout: `bun install`, `bun run typecheck`, `bun run lint`, `bun test ./tests`
- [ ] T002 [P] Add a synthetic long-text generator for tests in `tests/fixtures/long-text.ts` (deterministic; header line marks it synthetic; sizes by approximate token count)

## Phase 2: Foundational (blocks all stories)

- [ ] T003 Add `lls_ctx_create_ex(model, n_ctx, err)` to `src/native/shim/llama_shim.c` and `llama_shim.h` per `contracts/ffi.md` (`n_ctx == 0` → 4096; clamp to trained maximum; `lls_ctx_create` calls it with 0); rebuild shim with `bun run build:native`
- [ ] T004 [P] Declare the new symbol in `src/bun/llama/ffi.ts` (`lls_ctx_create_ex: { args: [ptr, u32, ptr], returns: ptr }`) and its TypeScript type
- [ ] T005 [P] Implement the pure resolver `resolveContextSize()` in `src/bun/llama/context-size.ts` (default 4096; effective = min(requested, trainCtx); sources default/global/model; invalid → default) with unit tests in `tests/context-size.test.ts`
- [ ] T006 Add `ContextSizeSettings` to `src/shared/types.ts` and `Settings.context?`; validate (integer, 512 ≤ v ≤ 1,048,576, drop invalid) in `src/bun/store/json-store.ts`; tests in `tests/json-store-context.test.ts`
- [ ] T007 [P] Add `EffectiveContext` and the `model.load` result field to `src/shared/types.ts` and `src/shared/rpc-contract.ts` per `contracts/rpc.md`

---

## Phase 3: User Story 1 — Work with long documents (P1) 🎯 MVP

**Goal**: choose a larger size, reload, and long content is accepted.
**Independent test**: Q1, Q2, Q3.

- [ ] T008 [US1] `engine.loadModel(path, { contextSize })` in `src/bun/llama/engine.ts`: call `lls_ctx_create_ex` with the validated value and report the effective size via `contextSize()`
- [ ] T009 [US1] Wire resolution into the load path in `src/bun/rpc/handlers.ts` (`model.load` returns `context: EffectiveContext` using `resolveContextSize` and the model's trained context from `readGgufMeta`)
- [ ] T010 [P] [US1] `ContextSizeControl` with presets (4096, 8192, 16384, 32768) and a custom value, validation messages, in `src/renderer/src/features/models/ContextSizeControl.tsx`
- [ ] T011 [US1] Reload-needed indicator and "Reload now" button next to the changed value (no automatic reload) in `src/renderer/src/features/models/ContextSizeControl.tsx` and `ModelLibrary.tsx`
- [ ] T012 [US1] Clamp notice when requested > model maximum, shown after load in the model view (`ModelLibrary.tsx`)
- [ ] T013 [US1] FFI boundary tests in `tests/ffi-context.test.ts`: default path gives 4096; 16384 on a model trained ≥ that; request above trained clamps; invalid values rejected before the call
- [ ] T014 [US1] Run quickstart Q1–Q3 and record the results in the PR description

---

## Phase 4: User Story 2 — Safe choices on limited hardware (P1)

**Goal**: warnings and recovery; no silent truncation of a single huge message.
**Independent test**: Q4, Q5, Q8.

- [ ] T015 [US2] Memory warning when the chosen size exceeds the advisor's `recommendedCtx` for the model (`ContextSizeControl.tsx`, data from the existing advisor response in `handlers.ts`); the user may proceed
- [ ] T016 [US2] Memory-failure recovery in `src/bun/llama/engine.ts`: on allocation failure at a non-default size retry once at 4096 and return `fallback: { reason: "memory" }`; never retry at 4096; test with an injected failing creator in `tests/engine-fallback.test.ts`
- [ ] T017 [US2] Pre-send check in `src/bun/rpc/handlers.ts` (`chat.send`): if the newest message's `engine.tokenCount` exceeds the effective size minus a small reserve, return `message_exceeds_context` with `neededTokens`; accept `force: true`
- [ ] T018 [P] [US2] Renderer dialog for the oversize message (raise size / send anyway) in `src/renderer/src/features/chat/` and RPC client use in `src/shared/rpc-contract.ts`
- [ ] T019 [US2] Tests for warning thresholds, fallback and the preflight result in `tests/context-safety.test.ts`; also cover a size change requested while a response is generating (applies at next load, nothing changes mid-response); run quickstart Q4, Q5, Q8

---

## Phase 5: User Story 3 — Per-model sizes and one-click recommendation (P2)

**Independent test**: Q6.

- [ ] T020 [P] [US3] Per-model override editing (basename key) in `ContextSizeControl.tsx`; precedence per-model > global > default shown with the source label
- [ ] T021 [US3] "Apply recommendation" action in the advisor view (`ModelLibrary.tsx`) writing the model's size via `settings.update` and showing the reload requirement
- [ ] T022 [US3] Fusion: each bound model resolves its own size; the memory warning sums both (`src/bun/models/roles.ts`, `ContextSizeControl.tsx`); test in `tests/context-fusion.test.ts`

---

## Phase 6: User Story 4 — Saved context stays correct (P3)

**Independent test**: Q7, Q9.

- [ ] T023 [US4] Confirm history budgeting reads the effective size (`src/bun/llama/prompt.ts` callers use `engine.contextSize()`); fix any hard-coded 4096
- [ ] T024 [US4] Regression test that a KV snapshot created at another size is discarded (`src/bun/kv/store.ts` `lookup`) in `tests/kv-ctx-mismatch.test.ts`
- [ ] T025 [US4] Include `context` in settings export/import with validation (`src/bun/export/exporter.ts`, `importer.ts`, `src/shared/export.ts`); round-trip test in `tests/export-context.test.ts`

---

## Phase 7: Polish

- [ ] T026 [P] Show the effective size of each loaded model in the model/performance view (`src/renderer/src/features/metrics/` or `models/`) (FR-009)
- [ ] T027 [P] Add the module to the `AGENTS.md` module map and a short note in the model settings docs
- [ ] T028 Run `bun run typecheck`, `bun run lint`, `bun test ./tests`, and quickstart Q1–Q9; confirm no network calls were added (FR-012); link results in the PR

---

## Dependencies & order
Setup → Foundational (T003–T007) → US1 → US2 (needs T008–T009) → US3 (needs T010) → US4 (needs T008) → Polish. US2/US3/US4 can run in parallel after US1.
MVP = US1 (T001–T014). Counts: 28 tasks — Setup 2, Foundational 5, US1 7, US2 5, US3 3, US4 3, Polish 3.
