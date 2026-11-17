# Validation Record: Portable CPU/GPU Inference Build

Quickstart S1–S7 run on the implementation machine (Fedora 44, RTX 3060
12 GB, driver 620.70.06, Vulkan ICD 1.4.357 + `vulkan-loader`).

## Quickstart

- [x] S1 native build — `./scripts/build-native.sh` (glslc + vulkan-headers
  + spirv-headers installed) → 26 staged artifacts incl. `lls_probe` and
  `gpu/libggml-vulkan.so` (40 MB); prereq check names the Vulkan SDK when
  `CAUSERIE_GPU` is unset; `CAUSERIE_GPU=off` builds CPU-only (25 artifacts)
- [x] S2 probe smoke — `./native/out/linux-x64/lls_probe native/out/linux-x64/gpu`
  → `{"devices":[{"name":"Vulkan0","backend":"Vulkan","freeBytes":12273516544,"totalBytes":13142851584}]}`
  in **0.72 s** (< 900 ms cap, SC-004)
- [x] S3 `bun test ./tests` — 656 pass / 0 fail (incl.
  `tests/llama/gpu-fit`, `tests/llama/gpu-probe`, `tests/rpc/compute`)
- [x] S4 GPU load + chat — `loadModel(..., {computeMode:"auto"})` →
  `compute:{mode:"gpu-full",device:"Vulkan0",gpuLayers:24,layersTotal:24}`
  (SmolLM2-1.7B); ChatML-wrapped generation streams coherent output
  (FR-011: "Photosynthesis is the process by which plants...")
- [x] S5 CPU-only degrade — verified on the earlier `CAUSERIE_GPU=off`
  staging: `unavailable` status, zero GPU errors, `{mode:"cpu"}` loads
- [x] S6 preference + continuity — `settings.set {computeMode:"cpu"}` →
  `compute.status` = `disabled`, `devices:[]`, no probe spawn; KV
  snapshots are backend-agnostic state blobs — a snapshot written under
  `gpu-*` restores or cleanly LCP-re-prefills under `cpu` (feature-010
  restore path unchanged)
- [x] S7 typecheck/lint/build — `tsc --noEmit` clean; `oxlint` no new
  warnings; `vite build` ✓

## SC-002 decode throughput — MEASURED (T025)

Same model + prompt on both paths, warmup + measured run
(`scripts/bench-gpu.ts`):

| Model | CPU | GPU (Vulkan, RTX 3060) | Speedup |
|---|---|---|---|
| SmolLM2-135M Q4_K_M | 216.0 tok/s | 328.5 tok/s (gpu-full, 30/30 layers) | 1.52× |
| **SmolLM2-1.7B Q4_K_M** | **34.0 tok/s** | **146.9 tok/s (gpu-full, 24/24 layers)** | **4.3×** |

The ≥2× target holds on the representative model — the 135M dev fixture
understates GPU scaling (host loop dominates at tiny sizes). GPU output
verified coherent (FR-011).

## SC-006 artifact size delta — MEASURED

- CPU-only staging (`CAUSERIE_GPU=off`): 39 MB (unchanged baseline)
- GPU staging: 79 MB — `gpu/libggml-vulkan.so` = **40 MB** + `lls_probe`
- **Delta ≈ +40 MB per platform — inside the 150 MB budget (SC-006)**
  (Vulkan embeds all generated shaders; Metal on macOS will differ)
