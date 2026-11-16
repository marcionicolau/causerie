# Contract: RPC additions for compute path

Additive changes to `src/shared/rpc-contract.ts` — no existing method
signature changes except optional fields.

## New request

```ts
"compute.status": {
  params: Record<string, never>;
  response: {
    probed: boolean;                    // probe has completed this run
    status: "available" | "unavailable" | "error" | "timeout" | "disabled";
    devices: { name: string; backend: string;   // registry name verbatim:
               // "vulkan"|"metal" today, "other" values tolerated
               freeBytes: number; totalBytes: number }[];
    reason?: string;
    mode: "auto" | "cpu";               // persisted preference
    active?: ComputePath;               // last model-load result
  };
}
```

## Extended requests/events

- `settings.get` response gains `computeMode: "auto" | "cpu"`
  (default `"auto"`).
- `settings.set` params gain `computeMode?: "auto" | "cpu"` — persisted;
  takes effect on the **next** model load (SC-005). Unknown value →
  `INVALID_PARAMS`. Note: the preference applies at load boundaries
  only — already-resident models (incl. fusion slots) keep the path
  they loaded with until evicted or explicitly reloaded; no migration
  or eviction is triggered by the toggle.
- `model.progress` event payload with `detail:"ready"` gains
  `compute?: ComputePath` — the path that served that specific load.
- `metrics.entry` / `metrics.list` `MetricEntry` gains optional
  `compute?: "cpu" | "gpu-full" | "gpu-partial"` and `device?: string`.

```ts
interface ComputePath {
  mode: "cpu" | "gpu-full" | "gpu-partial";
  device?: string;
  gpuLayers?: number;
  layersTotal?: number;
}
```

## Behaviour notes

- `model.load` params are unchanged — the mode is resolved main-side
  from `Settings.computeMode` + cached `GpuProbeResult` at load time
  (the registry forwards it into each slot, so fusion planner/executor
  resolve independently per FR-003).
- No GPU-specific error codes are added: a probe failure is data
  (`compute.status`), never an RPC error; GPU load failures degrade to
  retry-halve → CPU inside the load path, so `model.load` keeps today's
  error shape (MODEL_INVALID/OUT_OF_MEMORY/ENGINE_ERROR) for true
  failures.
- `compute.status` never triggers a probe synchronously — it reports
  the cached state (`probed:false` until the first result lands).
