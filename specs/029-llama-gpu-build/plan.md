# Implementation Plan: Portable CPU/GPU Inference Build

**Branch**: `029-llama-gpu-build` | **Date**: 2026-11-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/029-llama-gpu-build/spec.md`

## Summary

Ship GPU offload in the **same per-platform artifact** using llama.cpp's
existing dynamic-backend mechanism (`GGML_BACKEND_DL` is already on for CPU
ISA variants): build `libggml-vulkan.*` on Linux/Windows and rely on the
already-produced `libggml-metal.dylib` on macOS, staged into a `gpu/`
subdirectory beside the CPU variants so today's unconditional
`lls_backend_init` dir-scan never touches a GPU library. A tiny
**`lls_probe` executable** (links `libggml` only) runs the device
enumeration in a separate, killable process — a broken driver that crashes
or hangs the probe can never take the app down with it (spec edge case →
bounded, isolated check). On probe success the main process loads the GPU
backend via a new `lls_backend_init_gpu(dir)` symbol and routes each model
load through `lls_model_load2(path, nGpuLayers)`, with **partial offload**
computed in testable TypeScript (`n_gpu_layers` fitted to free VRAM via
GGUF `block_count`, retry-halving on alloc failure, `0` = pure CPU).
A persisted `Settings.computeMode` (`"auto" | "cpu"`, default auto) is the
user override; the active path (device + layers) rides `model.progress`,
`metrics` entries, and a new `compute.status` RPC so the UI can show which
path served a load. Every resident model — single-mode default and fusion
planner/executor alike — resolves the same policy independently against
shared GPU memory (FR-003). CUDA/HIP and other vendor-toolkit stacks stay
out of scope per FR-008.

## Technical Context

**Language/Version**: TypeScript strict (Bun) for probe orchestration, fit
math, settings, RPC, and renderer UI; C11 for the shim additions and the
`lls_probe` executable (same CMake tree).

**Primary Dependencies**: none added at runtime. Build-time-only
prerequisites: Vulkan SDK (`vulkan-headers` + `glslc` + `SPIRV-Headers`)
on Linux/Windows for `GGML_VULKAN`; macOS needs nothing extra (Metal
framework ships with the OS). No vendor GPU toolkit required on the
*deployed* machine — Vulkan support arrives with the user's display driver.

**Storage**: `settings.json` gains `computeMode`; probe result is
in-memory per app run (re-probed each launch; deliberately not persisted —
driver state changes between boots). No new files.

**Testing**: `bun test ./tests` (scoped) — pure-fit math, probe-JSON
parsing, settings cascade, engine retry-halve via fake shim, RPC contract;
plus a manual probe smoke run (`lls_probe <dir>` prints device JSON) and
`verify-artifact.sh` extended to require the GPU payload.

**Target Platform**: Linux x86_64 first (verified lane); the same code
path wires `ggml-vulkan` on Windows x64 and `ggml-metal` on macOS arm64
(already produced under `GGML_BACKEND_DL`).

**Project Type**: desktop app (Electrobun) — Bun main process + native
shim; the GPU backend travels as packaged payload, not a new engine.

**Performance Goals** (from SC-002/004): ≥2× decode speedup vs. CPU path
on a mid-range discrete GPU; GPU availability check adds <1 s to model
load worst case (probe starts at app init, awaited with a bounded budget
at first load, killed on timeout → CPU).

**Constraints**: single artifact per platform; zero GPU-related errors on
CPU-only machines; probe crash/hang MUST NOT affect the app process;
package growth <150 MB/platform; per-model independent offload with
shared VRAM; output coherence identical to CPU path (FR-011).

**Scale/Scope**: ~4 new shim symbols + ~80-line `lls_probe.c`, one new Bun
module (`llama/gpu.ts` probe + fit), small edits to engine/registry/
handlers/store, renderer settings surface + metrics badge, stage/verify
script updates. No renderer restructuring, no new dependencies.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Verdict |
|---|---|
| I. Local-first AI via FFI | PASS — inference stays in-process via llama.cpp through the same `bun:ffi` shim; the feature adds symbols to the existing FFI module rather than a second native surface. The `lls_probe` exe is a *process* boundary used only for the availability check (same pattern feature 028 established for crash containment), not an inference path. |
| II. Electrobun process boundaries | PASS — all logic lives in the Bun main process; renderer sees typed RPC additions (`compute.status`, `settings.set.computeMode`, `model.progress`/`metrics` fields) inside the existing contract file. |
| III. Strict TS & typed FFI | PASS — every new shim symbol gets a declared signature in `ffi.ts` and the C header; probe stdout JSON is schema-validated before use; all TS strict. |
| IV. Component standardization | PASS — compute preference/status UI reuses existing shadcn `select`/badge patterns in `features/settings` / `features/models`; no new component library. |
| V. Vite pipeline | PASS — renderer changes are ordinary components; `vite build`/HMR unaffected. |
| VI. Minimal dependencies | PASS — zero new npm/runtime packages. `libggml-vulkan`/`libggml-metal` are built from the already-vendored llama.cpp; the Vulkan SDK is a build-machine toolchain prerequisite, not an app dependency. |

No violations — no Complexity Tracking entries needed.

## Project Structure

### Documentation (this feature)

```text
specs/029-llama-gpu-build/
├── plan.md              # This file
├── research.md          # Phase 0 — backend pick, isolation, fit strategy
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── ffi.md           # new shim symbols + lls_probe stdout schema
│   └── rpc.md           # compute.status, settings/payload additions
└── tasks.md             # /speckit-tasks output (NOT created by this command)
```

### Source Code (repository root)

```text
src/native/shim/
├── llama_shim.h / .c        # + lls_backend_init_gpu(dir),
│                            #   lls_model_load2(path, nGpuLayers, err),
│                            #   lls_model_gpu_info(model) -> JSON,
│                            #   lls_gguf_meta + nLayer/fileBytes fields
├── gpu_probe.c              # NEW: lls_probe exe — loads backend libs from
│                            #   a dir arg, prints GPU device JSON, exits
└── CMakeLists.txt           # GGML_VULKAN on Linux/Windows (env off-switch);
│                            # lls_probe target; RPATH $ORIGIN covers gpu/

src/bun/llama/
├── gpu.ts                   # NEW: probeGpu() (spawn lls_probe, timeout,
│                            #   cached result, runtime-fault latch),
│                            #   fitGpuLayers() pure math, resolveMode()
├── engine.ts                # loadModel(path, opts.compute) →
│                            #   cpu: lls_model_load; gpu: init_gpu +
│                            #   load2 + retry-halve; records computePath
└── ffi.ts                   # typed surface for new symbols (graceful
│                            #   fallback on stale shims, like state syms)

src/bun/models/registry.ts   # forwards compute mode into each slot's
│                            #   loadModel — per-model policy (FR-003)
src/bun/rpc/handlers.ts      # + "compute.status"; settings.get/set gain
│                            #   computeMode; model.progress/done payload
│                            #   gains compute; metrics.recordCall stamps it
src/bun/store/json-store.ts  # Settings.computeMode default "auto"
src/shared/types.ts          # ComputeMode, GpuProbeResult, ComputePath;
│                            #   MetricEntry.compute/Device fields
src/shared/rpc-contract.ts   # compute.status + extended payloads

src/renderer/src/features/
├── settings/ComputeSettings.tsx  # preference select + probe/device display
└── metrics/OutputPanel.tsx       # compute badge per entry

scripts/
├── stage-native.ts          # routes libggml-vulkan/metal + lls_probe
│                            #   into outDir/gpu/ + outDir root
├── build-native.sh / .ps1   # prereq check names Vulkan SDK tools
└── verify-artifact.sh       # requires gpu/ payload + lls_probe per platform

tests/
├── llama/gpu-fit.test.ts    # fit math + retry-halve decisions
├── llama/gpu-probe.test.ts  # probe JSON parse, timeout/kill, fault latch
└── rpc/compute.test.ts      # compute.status + settings cascade contract
```

**Structure Decision**: all GPU logic hangs off the existing
`src/bun/llama/` + `src/native/shim/` pair — no new top-level module. The
probe executable shares the shim's CMake project so packaging stays one
pipeline (`build-native.sh` → `stage-native.ts` → `native/out/<plat>/`).

## Phase 0 — research

See `research.md`. All spec-level questions were resolved in the
2026-11-16 clarify session (partial offload; per-model policy). The
remaining engineering unknowns resolved there: crash-isolated probe design,
staging layout that keeps `lls_backend_init` CPU-only, layer-fit math in
the absence of upstream `params.fit`, and graceful-degrade handling for a
stale shim (mirror the feature-010 optional-symbol pattern).

## Phase 1 — design artifacts

- `data-model.md` — ComputePreference, GpuProbeResult, ComputePath,
  shim-surface entities, MetricEntry additions.
- `contracts/ffi.md` — `lls_backend_init_gpu`, `lls_model_load2`,
  `lls_model_gpu_info`, extended `lls_gguf_meta`, `lls_probe` stdout schema.
- `contracts/rpc.md` — `compute.status`, `settings.get/set.computeMode`,
  `model.progress`/`metrics.entry` compute fields.
- `quickstart.md` — build-with-Vulkan, probe smoke, GPU/CPU verification,
  packaging check.

## Constitution re-check (post-Phase-1)

All gates still PASS — the design adds no runtime dependency, keeps the
FFI boundary single and typed, puts GPU payload behind the same
probe-then-load boundary the spec's edge cases demand, and touches the
renderer only through existing component patterns.
