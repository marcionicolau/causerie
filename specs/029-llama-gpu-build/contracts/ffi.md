# Contract: shim FFI additions + `lls_probe` output schema

Additive to the stable C11 ABI in `src/native/shim/llama_shim.h`. All
existing symbols keep their signatures — `lls_model_load` remains and now
delegates to `lls_model_load2(path, 0)`.

## New shim symbols

```c
// probes GPU-class ggml backends (vulkan/metal/…) from dir — the gpu/
// subdirectory beside the shim, NOT the flat dir lls_backend_init scans.
// Safe to call once after a successful external probe; later calls and
// NULL dirs are handled (no-op).
LLS_API void lls_backend_init_gpu(const char * dir);

// like lls_model_load but offloads n_gpu_layers layers to GPU devices.
// n_gpu_layers: 0 = CPU only (identical to lls_model_load);
//               N > 0 = first N layers on GPU, rest on CPU;
//               -1 = all layers on GPU (llama clamps to the real layer
//               count; used when GGUF block_count is unavailable).
// GPU layers land on whatever devices were registered by
// lls_backend_init_gpu (devices NULL → ggml picks best). With no GPU
// backend registered this still works — n_gpu_layers is a no-op.
// NULL on failure; err is set and must be freed via lls_free_string.
LLS_API lls_model * lls_model_load2(const char * path,
                                    int32_t n_gpu_layers, char ** err);

// shim-allocated JSON describing where the model landed:
//   {"gpuLayers":<int>, "layersTotal":<int>, "device":<string|null>}
// device is the ggml device name when gpuLayers > 0, else null.
// Free via lls_free_string either way. NULL on failure (err set).
LLS_API char * lls_model_gpu_info(lls_model * m, char ** err);
```

## Extended symbol

`lls_gguf_meta` JSON output gains two additive fields (older readers
ignore them):

```json
{"name":…, "architecture":…, "paramCount":…, "quantization":…,
 "contextTrain":…, "nLayer": <uint|null>, "fileBytes": <uint>}
```

- `nLayer` = `<architecture>.block_count` from GGUF metadata.
- `fileBytes` = model file size (`fstat`), used for per-layer fit math.

## `lls_probe` executable

Built by the same CMake target tree, staged to `native/out/<plat>/`.

```
lls_probe <backend-dir>
```

- `<backend-dir>` = the `gpu/` subdir containing `libggml-vulkan.*` /
  `libggml-metal.*`. Missing/empty arg → scans default paths.
- Calls `ggml_backend_load_all_from_path(dir)`, then iterates
  **registries** (`ggml_backend_reg_count`/`ggml_backend_reg_get` →
  `ggml_backend_reg_dev_count`/`_dev_get`) so each device's `backend`
  field comes from `ggml_backend_reg_name`. Keeps
  `GGML_BACKEND_DEVICE_TYPE_GPU` (and `IGPU`) devices, prints **one
  line of JSON** to stdout:

```json
{"devices":[{"name":"…","backend":"vulkan","freeBytes":…,"totalBytes":…}]}
```

- `backend` carries the registry name verbatim (`"vulkan"`, `"metal"`,
  …) — consumers MUST tolerate unknown values (treat as `"other"`),
  the enum in contracts/rpc.md is descriptive, not exhaustive.
- Exit 0 with `{"devices":[]}` = no usable GPU (not an error).
- Any crash/hang/nonzero exit is the *isolated* failure mode the Bun
  parent maps to `GpuProbeResult.status` `"error"`/`"timeout"`.
- The probe must not write to stderr in the success path; Bun reads
  stdout only and schema-validates before use.

## FFI typing (src/bun/llama/ffi.ts)

New symbols are optional on the shim handle — same stale-shim fallback
pattern as `lls_state_*` (feature 010): the loader first tries the full
symbol set, falls back to the base set, and the GPU layer reports
"unavailable (stale shim)" when `lls_model_load2` is absent. No `any`
at the boundary; `lls_model_gpu_info` JSON is parsed + validated.
