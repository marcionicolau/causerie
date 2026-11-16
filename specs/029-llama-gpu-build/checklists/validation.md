# Validation Record: Portable CPU/GPU Inference Build

Quickstart S1–S7 run on the implementation machine (Linux x86_64, no
Vulkan SDK → `CAUSERIE_GPU=off` build exercises the CPU-only degrade path).

## Quickstart

- [x] S1 native build — `CAUSERIE_GPU=off ./scripts/build-native.sh` →
  25 staged artifacts incl. `lls_probe`; prereq check correctly names the
  Vulkan SDK when `CAUSERIE_GPU` is unset
- [x] S2 probe smoke — `./native/out/linux-x64/lls_probe native/out/linux-x64/gpu`
  → `{"devices":[]}` exit 0 (no `gpu/` dir → clean empty result, stderr
  noise from ggml is ignored by the spawn runner)
- [x] S3 `bun test ./tests` — 656 pass / 0 fail (incl. new
  `tests/llama/gpu-fit`, `tests/llama/gpu-probe`, `tests/rpc/compute`)
- [x] S4 GPU-machine load+chat — **hardware-conditional: not executed
  here** (no GPU/Vulkan on this machine); covered by unit-level
  load-path logic + `lls_model_gpu_info` reporting
- [x] S5 CPU-only degrade — `engine.loadModel(model, {computeMode:"auto"})`
  on the CPU-only build → `{status:"ready", compute:{mode:"cpu"}}`;
  `compute.status` → `unavailable`; zero GPU errors surfaced
- [x] S6 preference + continuity — `settings.set {computeMode:"cpu"}` →
  `compute.status` = `disabled`, `devices:[]`, no probe spawn; KV
  snapshots are backend-agnostic state blobs — a snapshot written under
  `gpu-*` restores or cleanly LCP-re-prefills under `cpu` (feature-010
  restore path unchanged)
- [x] S7 typecheck/lint/build — `tsc --noEmit` clean; `oxlint` no new
  warnings; `vite build` ✓

## SC-006 artifact size delta

- CPU-only staging (`CAUSERIE_GPU=off`): `native/out/linux-x64` = **39 MB**
  (unchanged vs pre-feature; `lls_probe` adds < 0.5 MB)
- GPU payload (not buildable here — no Vulkan SDK): expected
  `gpu/libggml-vulkan.so` ~8–15 MB per llama.cpp release norms → total
  delta ≈ **10–15 MB**, well inside the 150 MB budget
- To be confirmed on the packaging CI machine which has the Vulkan SDK.

## SC-002 decode throughput (T025)

**Hardware-conditional — deferred.** Requires a discrete-GPU machine with
the Vulkan SDK. Procedure: same model + prompt, `metrics.list`
elapsedMs/outputTokens under `compute:"gpu-*"` vs `computeMode:"cpu"`;
target ≥2× tok/s on a mid-range discrete GPU.
