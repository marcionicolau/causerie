# Data Model: Portable CPU/GPU Inference Build

Entities added or extended by this feature. Nothing is persisted except
`Settings.computeMode`; the probe result is process-lifetime state.

## ComputePreference (persisted)

`Settings.computeMode?: "auto" | "cpu"`

- Optional on disk; absent → `"auto"` (merge rule identical to other
  optional Settings fields — parsed value spread over the default).
- `"auto"`: probe → GPU when a usable device exists, else CPU.
- `"cpu"`: skip GPU entirely — `lls_backend_init_gpu` is never called
  and the load path is byte-identical to today.
- Written via `settings.set { computeMode }`; read via `settings.get`.
- Validation: unknown strings → `INVALID_PARAMS`.

## GpuProbeResult (in-memory, per app run)

```ts
interface GpuDeviceInfo {
  name: string;        // e.g. "NVIDIA GeForce RTX 4060"
  backend: "vulkan" | "metal";
  freeBytes: number;   // ggml_backend_dev_memory free
  totalBytes: number;
}

interface GpuProbeResult {
  status: "available" | "unavailable" | "error" | "timeout" | "disabled";
  devices: GpuDeviceInfo[];      // [] unless status === "available"
  reason?: string;               // why not available ("no devices",
                                 // "probe exit 1", "probe killed",
                                 // "computeMode=cpu", "runtime fault")
}
```

- Produced once by `probeGpu()` (spawn `lls_probe <nativeDir>/gpu`,
  **900 ms spawn-kill timeout**, JSON-validate stdout). Shared promise —
  every model load in the run reuses it; a load that arrives before the
  probe lands awaits only the remaining budget (total added latency is
  bounded under SC-004's <1 s).
- `disabled`: `computeMode === "cpu"` (probe not even spawned).
- `"runtime fault"` latch: a GPU-path `lls_step` failure flips the
  cached result to `{status:"error", reason:"runtime fault"}` so the
  next load resolves CPU (FR-012).
- Not persisted — re-probed each launch (driver state is volatile).

## ComputePath (per model load, surfaced)

```ts
interface ComputePath {
  mode: "cpu" | "gpu-full" | "gpu-partial";
  device?: string;      // GPU device name when gpu-*
  gpuLayers?: number;   // layers resident on GPU
  layersTotal?: number; // model block_count
}
```

- Derived after a successful `lls_model_load2` via `lls_model_gpu_info`
  (`gpuLayers === layersTotal && layersTotal > 0` → `gpu-full`;
  `gpuLayers > 0` → `gpu-partial`; else `cpu`).
- Carried on: `model.progress {detail:"ready"}` payload, engine status,
  `metrics` entries (see below), `compute.status` response.
- Per resident model: planner/executor/main slots each hold their own
  `ComputePath` (FR-003) — fusion `chat.done` stats keep the existing
  per-phase shape, so no new field is needed there.

## MetricEntry (extended — feature 016 ring)

```ts
interface MetricEntry {
  // …existing fields…
  compute?: "cpu" | "gpu-full" | "gpu-partial";
  device?: string;
}
```

- Optional additive fields; stale entries and fakes omit them. Stamped
  in `recordCall` from the serving slot's `ComputePath` — this is the
  FR-006 "which path served a conversation" surface (with the settings
  panel badge).

## Shim-surface entities (C side)

- `lls_model` gains `gpuLayers: int32_t` + `gpuDevice: char[64]`
  recorded from `llama`'s device assignment after `load2` succeeds —
  read back by `lls_model_gpu_info`. No ABI break: struct is opaque.
- `lls_gguf_meta` JSON gains `"nLayer": <uint|null>` and
  `"fileBytes": <uint>` — additive fields; older consumers ignore them.
- `lls_probe` stdout schema: one line of JSON
  `{"devices":[{"name","backend","freeBytes","totalBytes"}]}`; empty
  devices + exit 0 means "no GPU"; nonzero exit / no output → probe
  failure (parent maps to `error`/`timeout`).

## Relationships

```text
Settings.computeMode ──┐
                       ├─► gpu.ts resolveMode() ─► engine.loadModel(path, mode)
GpuProbeResult ────────┘         │
                                 ├─ cpu  → lls_model_load (today's path)
                                 └─ auto → lls_backend_init_gpu +
                                           lls_model_load2(fitGpuLayers)
                                                    │ retry-halve
                                                    ▼
                                          ComputePath ─► model.progress,
                                                         metrics.entry,
                                                         compute.status
```

## Validation rules

- `computeMode` accepts exactly `"auto" | "cpu"`.
- `fitGpuLayers` output is clamped to `[0, nLayer]`; `freeBytes ≤ 0` → 0.
- `nLayer == null` (architectures without `block_count`) → return `-1`
  ("attempt all layers"; llama clamps to the real count) so the
  retry-halve loop still governs the failure path.
- Retry-halve bound: ≤4 attempts total; `n = 0` attempt uses today's
  `lls_model_load` semantics exactly (no GPU code path at all).
- `ComputePath` is informational only — never gates a load.
