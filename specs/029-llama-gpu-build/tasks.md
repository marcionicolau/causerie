# Tasks: Portable CPU/GPU Inference Build

**Input**: Design documents from `/specs/029-llama-gpu-build/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ffi.md, contracts/rpc.md, quickstart.md

**Tests**: Included — constitution mandates automated tests for FFI-boundary changes; tasks are grouped inside each story phase.

**Organization**: Tasks grouped by user story (US1/US2/US3) for independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 = GPU auto-acceleration, US2 = CPU-only unaffected, US3 = inspect/override
- File paths are repo-root-relative

---

## Phase 1: Setup (native build & staging)

- [x] T001 Extend `src/native/shim/CMakeLists.txt`: set `GGML_VULKAN ON` for `UNIX AND NOT APPLE` and `WIN32` (env `CAUSERIE_GPU=off` forces OFF so CPU-only dev builds still work); add `lls_probe` executable target linking `ggml` with `$ORIGIN`/`@loader_path` rpath so it resolves `libggml` beside itself
- [x] T002 Create `src/native/shim/gpu_probe.c`: arg = backend dir → `ggml_backend_load_all_from_path(dir)`, iterate **registries** (`ggml_backend_reg_count`/`_reg_get` → `ggml_backend_reg_dev_count`/`_dev_get`) so each device's `backend` is `ggml_backend_reg_name` verbatim, keep `GGML_BACKEND_DEVICE_TYPE_GPU`/`IGPU` devices, print one stdout JSON line `{"devices":[{"name","backend","freeBytes","totalBytes"}]}` (schema per contracts/ffi.md); exit 0 always on success incl. empty devices
- [x] T003 Update `scripts/build-native.sh` and `scripts/build-native.ps1`: extend the FR-004 missing-prerequisite check to name `glslc`/Vulkan SDK when `CAUSERIE_GPU` is unset/not `off`; pass `-DGGML_VULKAN=OFF` when `CAUSERIE_GPU=off`
- [x] T004 [P] Update `scripts/stage-native.ts`: route `*ggml-vulkan*`/`*ggml-metal*`/`*ggml-opencl*` artifacts into `<outDir>/gpu/` (non-recursive dir scan keeps them invisible to `lls_backend_init`); stage `lls_probe`/`lls_probe.exe` at `<outDir>` root

**Checkpoint**: `bun run build:native` produces `native/out/<plat>/gpu/libggml-vulkan.*` + `lls_probe`; `./lls_probe native/out/<plat>/gpu` prints device JSON (quickstart S1–S2).

---

## Phase 2: Foundational (shim ABI + shared types + probe/fit module)

- [x] T005 Extend `src/native/shim/llama_shim.h` + `llama_shim.c` per contracts/ffi.md: `lls_backend_init_gpu(dir)` (idempotent, probes GPU backends from `gpu/` subdir only), `lls_model_load2(path, n_gpu_layers, err)` (`0`=CPU, `N>0`=partial, `-1`=all; `lls_model_load` delegates with `0`), `lls_model_gpu_info(model)` → JSON `{"gpuLayers","layersTotal","device"}`; extend `lls_gguf_meta` JSON with additive `"nLayer"` (`<arch>.block_count`) and `"fileBytes"` fields
- [x] T006 Extend `src/bun/llama/ffi.ts`: typed optional symbols `lls_backend_init_gpu`, `lls_model_load2`, `lls_model_gpu_info` — same try-full-then-fallback stale-shim pattern as `lls_state_*` (feature 010)
- [x] T007 Add shared types in `src/shared/types.ts`: `ComputeMode = "auto" | "cpu"`, `GpuDeviceInfo`, `GpuProbeResult` (status `"available"|"unavailable"|"error"|"timeout"|"disabled"` + `reason?`), `ComputePath` (mode `"cpu"|"gpu-full"|"gpu-partial"`); add optional `compute`/`device` fields to `MetricEntry`; add optional `computeMode?: ComputeMode` to `Settings`
- [x] T008 Update `src/bun/store/json-store.ts`: default `computeMode: "auto"` in `DEFAULT_SETTINGS`; merge rule identical to other optional fields (parsed value wins, absent → default)
- [x] T009 Create `src/bun/llama/gpu.ts`: `probeGpu()` — resolve native dir via the same candidates as `ffi.ts` (+`gpu/` subdir), `Bun.spawn` `lls_probe`, **900 ms spawn-kill timeout**, JSON-validate stdout (unknown `backend` strings tolerated), memoized per app run, `reportRuntimeFault()` latch → `{status:"error", reason:"runtime fault"}`; `fitGpuLayers(fileBytes, nLayer, freeBytes)` — `min(nLayer, floor(freeBytes*0.8/(fileBytes/nLayer)))` clamped `[0,nLayer]`, **`nLayer == null` → `-1`** (llama clamps; retry-halve still governs failure); `resolveMode(computeMode, probeResult)` — pure

**Checkpoint**: shim compiles with new symbols; `gpu.ts` pure functions unit-testable; `lls_probe` output parses into `GpuProbeResult`.

---

## Phase 3: [US1] GPU machine gets accelerated inference automatically (P1)

**Goal**: on a GPU-equipped deployed machine, model load offloads to GPU with zero user action; partial offload when the model exceeds free VRAM; active path recorded.

**Independent test**: `bun run dev` on a GPU machine → load model → send message → streams normally, `compute.status` reports `available`, model progress shows `gpu-full`/`gpu-partial` (quickstart S4).

- [x] T010 [US1] Write `tests/llama/gpu-fit.test.ts`: `fitGpuLayers` clamping (0 when `freeBytes<=0`, `nLayer` cap, conservative per-layer estimate), retry-halve sequence decisions, `resolveMode` truth table (auto+available→gpu, auto+unavailable/error/timeout→cpu, cpu→cpu regardless)
- [x] T011 [P] [US1] Write `tests/llama/gpu-probe.test.ts`: probe JSON parse + schema validation (malformed/extra fields → error), fake-probe timeout → `"timeout"`, nonzero exit → `"error"`, `reportRuntimeFault` latch behavior
- [x] T012 [US1] Extend `src/bun/llama/engine.ts`: `loadModel(path, opts?: {computeMode?: ComputeMode})` — `cpu` → today's `lls_model_load`; auto+GPU → `lls_backend_init_gpu(gpuDir)` once + `lls_model_load2(fitGpuLayers(...))` using `lls_gguf_meta` `nLayer`/`fileBytes` and probe `freeBytes`; on alloc/memory-class load failure halve `nGpuLayers` and retry (≤4 attempts, terminal `0`); record `ComputePath` from `lls_model_gpu_info`; GPU-path `lls_step` failure calls `gpu.reportRuntimeFault()` so next load resolves CPU (FR-012)
- [x] T013 [US1] Extend `src/bun/models/registry.ts`: forward `computeMode` into each slot's `engine.loadModel` — every resident model (main/planner/executor) resolves the policy independently against shared VRAM (FR-003)
- [x] T014 [US1] Update `src/bun/rpc/handlers.ts`: kick `probeGpu()` at handler init (app start, non-blocking); read `settings.computeMode` at load time and pass resolved mode into engine/registry loads; stamp `compute: ComputePath` onto `model.progress` `detail:"ready"` payloads (contract rpc.md)
- [x] T015 [US1] Update `src/bun/metrics/` `recordCall` path in `rpc/handlers.ts`: stamp `compute`/`device` from the serving slot's `ComputePath` on `MetricEntry` (FR-006 — which path served a conversation)

**Checkpoint**: US1 acceptance — GPU load + chat works, path reported as GPU; partial offload observed with a model larger than free VRAM.

---

## Phase 4: [US2] CPU-only machine is unaffected (P1)

**Goal**: identical experience on machines with no usable GPU — including probe crash/hang and stale-shim cases.

**Independent test**: run on CPU-only machine (or empty/absent `gpu/` dir) → normal chat turn, `compute.status` = `unavailable`, zero GPU errors surfaced (quickstart S5).

- [x] T016 [US2] Write `tests/rpc/compute.test.ts`: `compute.status` response shape for each `GpuProbeResult.status`; `settings.set {computeMode}` persists + validates (`"gpu"`/`junk` → `INVALID_PARAMS`); `model.load` with `computeMode:"cpu"` never touches GPU symbols
- [x] T017 [US2] Harden `src/bun/llama/gpu.ts` + `engine.ts` degrade paths: missing `gpu/` dir / absent `lls_probe` binary → `{status:"unavailable"}` without throwing; stale shim lacking `lls_model_load2` → `"unavailable"` reason `"stale shim"`; `lls_backend_init_gpu` with no GPU libs → `n_gpu_layers` no-op so load still succeeds on CPU (FR-004/FR-005)
- [x] T018 [US2] Verify no GPU probe spawn when `computeMode:"cpu"` (`GpuProbeResult.status:"disabled"`) and that the resolved CPU path is byte-identical to today (same `lls_model_load` call, same error mapping `OUT_OF_MEMORY`/`MODEL_INVALID`)

**Checkpoint**: US2 acceptance — probe kill/crash simulation yields a clean `unavailable` status; chat unaffected.

---

## Phase 5: [US3] User can inspect and override the compute path (P2)

**Goal**: persisted preference + visible active path.

**Independent test**: GPU machine → Settings → "CPU only" → next `model.load` reports `cpu` without restart (quickstart S6, SC-005).

- [x] T019 [US3] Add `compute.status` RPC handler in `src/bun/rpc/handlers.ts` + schema entry in `src/shared/rpc-contract.ts` (cached result only — never synchronously probes; `probed:false` until first result lands)
- [x] T020 [US3] Extend `settings.get`/`settings.set` in `rpc-contract.ts` + `handlers.ts`: `computeMode` read/write + validation; takes effect on next model load
- [x] T021 [US3] Create `src/renderer/src/features/settings/ComputeSettings.tsx` (shadcn select + badges): compute preference select (Auto / CPU only), detected device name + free VRAM, probe status/reason, last-load `ComputePath` — wired into the existing settings surface; hidden-GPU note when `unavailable`
- [x] T022 [P] [US3] Extend `src/renderer/src/features/metrics/OutputPanel.tsx`: `compute`/`device` badge per `MetricEntry` row (additive optional fields — omit when absent)

**Checkpoint**: US3 acceptance — preference toggle takes effect on next load; status visible in settings + metrics.

---

## Phase 6: Polish & cross-cutting

- [x] T023 Update `scripts/verify-artifact.sh`: require `gpu/` backend payload + `lls_probe` per platform (hard fail — FR-008 makes GPU coverage a release requirement); keep existing CPU-variant check
- [x] T024 Run quickstart S1–S7 end-to-end: native build, probe smoke, `bun test ./tests` (scoped), `bun run typecheck`, `bun run lint`, `vite build`; record artifact size delta vs. pre-feature build for the 150 MB budget (SC-006) in `specs/029-llama-gpu-build/checklists/`
- [x] T025 Measure decode throughput for SC-002 on a GPU-equipped machine: same model + prompt, compare `chat.done` stats tok/s (or `metrics` elapsedMs/outputTokens) under `compute:"gpu-*"` vs. `computeMode:"cpu"`; record the ratio in `specs/029-llama-gpu-build/checklists/` (target ≥2× on a mid-range discrete GPU; hardware-conditional manual validation)
- [x] T026 Update `AGENTS.md` module map: `llama/gpu.ts`, shim `lls_model_load2`/`gpu` staging, `compute.status` RPC, `ComputeSettings` renderer surface

---

## Dependencies

```text
Phase 1 (Setup)  ─►  Phase 2 (Foundational)  ─►  Phase 3 (US1)
                                            ─►  Phase 4 (US2, depends on T008/T012 plumbing)
                                            ─►  Phase 5 (US3, depends on T014/T019)
                                                     │
                                              Phase 6 (Polish)
```

- **US1** is the critical path — engine retry-halve (T012) needs the foundational shim/types.
- **US2** is mostly validation of degrade paths; can start once T008–T012 exist but delivers independently.
- **US3** depends on the RPC/status plumbing from US1.

## Parallel opportunities

- T002/T003/T004 (Setup, different files — T003 touches two scripts but is one change)
- T006/T007/T008 (Foundational, different files; T009 depends on T007)
- T010/T011 (US1 test files, parallel)
- T021/T022 (US3 renderer surfaces, parallel)

## Implementation strategy

**MVP = Phase 1 + 2 + 3 (US1)** — the packaged artifact auto-accelerates on GPU machines and safely degrades; US2's hardening rides along since the fallback paths land in the same files. US3 is a thin surface layer on top.

Feature-004 gotcha applies: `chat.send`/registry call sites must pass `computeMode` at *load* time, not cache it at handler init — a stale mode would ignore a mid-session preference change (SC-005).
