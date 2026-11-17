# Quickstart: validating the CPU/GPU build

Validation scenarios proving the feature end-to-end. Prereqs assume the
repo root as cwd.

## Prerequisites

- Bun + cmake + C toolchain (as today).
- **GPU lane (Linux/Windows)**: Vulkan SDK — `vulkan-headers`, `glslc`
  (shaderc), `SPIRV-Headers` on the *build* machine only. Check:
  `command -v glslc`. Missing → `build-native.sh` fails fast naming it
  (or opt out with `CAUSERIE_GPU=off`).
- macOS: nothing extra — `libggml-metal.dylib` is already produced.
- A GGUF model in `models/` (existing model library flow).

## S1 — Native build produces the GPU payload

```sh
bun run build:native          # cmake + stage
ls native/out/linux-x64/      # libllama_shim.so, libllama.so,
                              # libggml*.so, lls_probe
ls native/out/linux-x64/gpu/  # libggml-vulkan.so (metal on macOS)
```

Expected: `lls_probe` at the out-dir root; GPU backend lib(s) under
`gpu/` — **not** in the flat dir.

## S2 — Probe smoke (US1/US2 core)

```sh
./native/out/linux-x64/lls_probe native/out/linux-x64/gpu
```

Expected: one line of JSON on stdout. GPU machine →
`{"devices":[{"name":"…","backend":"vulkan","freeBytes":…}]}`. No GPU →
`{"devices":[]}`. A broken driver must exit nonzero or be killable —
the app never sees it.

## S3 — Automated coverage

```sh
bun test ./tests/llama ./tests/rpc
bun run typecheck && bun run lint
```

Expected: fit-math, probe-parse/timeout/fault-latch, and
compute.status/settings contract tests pass; strict TS + lint clean.

## S4 — Dev run, GPU path (US1)

```sh
bun run dev    # on a GPU-equipped machine
```

1. Load a model, send a chat message.
2. Settings → Compute shows the detected device + "auto" preference;
   `compute.status` reports `status:"available"`.
3. The model progress / metrics entry shows `compute:"gpu-full"` (or
   `"gpu-partial"` with `gpuLayers < layersTotal` when VRAM-bound).

Expected: response streams normally; visibly faster than CPU baseline.

## S5 — CPU-only machine is unaffected (US2)

Run S4 on a machine with no usable GPU (or `CAUSERIE_GPU=off` build /
empty `gpu/` dir to simulate).

Expected: chat works identically to today; `compute.status` shows
`status:"unavailable"` (or `"disabled"` under `computeMode:"cpu"`);
zero GPU-related errors surfaced anywhere.

## S6 — Override + partial offload (US3, FR-009)

1. Settings → Compute → "CPU only" → next `model.load` reports
   `compute:"cpu"` without restart (SC-005).
2. On a GPU machine, load a model larger than free VRAM: progress shows
   `gpu-partial` with reduced `gpuLayers`; output remains coherent
   (FR-011 — parity is *structural*: GPU and CPU paths share the same
   prompt assembly, decode loop, and stop handling; only the compute
   backend differs, so coherence checks are manual smoke, not a
   dedicated suite). Load never fails for VRAM reasons — retry-halve
   lands on CPU only when nothing fits.
3. Continuity check: after a GPU-backed turn completes, toggle
   `computeMode` to "cpu", reload the model, and continue the same
   conversation — a feature-010 KV snapshot saved under `gpu-*` must
   either restore or cleanly fall back to re-prefill (never corrupt or
   hang).

## S7 — Package verification

```sh
bun run build   # canary package
bash scripts/verify-artifact.sh build/canary-linux-x64
```

Expected: PASS — shim + llama + ggml-cpu variants + `gpu/` payload +
`lls_probe` all staged. Size delta vs. a pre-feature build stays under
the 150 MB budget (SC-006); record the number for release notes.
