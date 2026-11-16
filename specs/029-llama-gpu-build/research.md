# Research: Portable CPU/GPU Inference Build

All spec-level unknowns were resolved in the 2026-11-16 clarify session
(partial offload when a model doesn't fit; per-model GPU policy under
fusion). This file resolves the remaining engineering questions against
the vendored llama.cpp tree and the existing shim/packaging pipeline.

## R1 — Which GPU backends?

**Decision**: `ggml-vulkan` on Linux + Windows; `ggml-metal` on macOS.

**Rationale**: FR-008 mandates a cross-vendor Vulkan-class backend
(NVIDIA/AMD/Intel on Linux and Windows) plus the Apple GPU backend. Both
are present in the vendored tree
(`src/native/vendor/llama.cpp/ggml/src/ggml-vulkan`, `…/ggml-metal`) and
both build as `GGML_BACKEND_DL` loadable modules — the exact mechanism
already used for `libggml-cpu-<isa>` variants. On the *deployed* machine
Vulkan needs only the ICD the display driver already installs; Metal
ships with the OS. Neither requires a vendor toolkit (CUDA) or runtime
download on the user's PC.

**Alternatives considered**:
- `ggml-cuda`/`ggml-hip`: higher peak perf on NVIDIA but requires a
  CUDA-class runtime on the deployed machine and explodes artifact size —
  explicitly out of scope (FR-008).
- `ggml-opencl`/`ggml-sycl`: narrower driver coverage on consumer
  desktops; Vulkan is the broader cross-vendor lowest common denominator.
- `ggml-webgpu`/`ggml-virtgpu`: experimental in-tree, immature.

## R2 — Crash isolation for the availability check

**Decision**: a dedicated `lls_probe` executable performs device
enumeration in a child process; the app spawns it with a timeout and
treats nonzero exit / kill / unparseable output as "GPU unavailable".

**Rationale**: `ggml_backend_load_all_from_path` registers backend
libraries **eagerly** — `ggml_backend_load_best("vulkan", …)` dlopens
`libggml-vulkan*.so` and its `ggml_backend_vk_reg()` runs
`vkCreateInstance`/`vkEnumeratePhysicalDevices` inside the caller. A
broken/absent-driver corner case (corrupt ICD manifest, mismatched loader)
can segfault or hang *inside that call*. Doing this in the app process
violates the spec edge case ("probe itself crashes or hangs → check is
isolated/bounded so the app still reaches the CPU path"). A subprocess is
the only boundary that survives a SIGSEGV in driver code. `lls_probe` is
~80 lines of C linking `libggml` only — it calls
`ggml_backend_load_all_from_path(argv[1])`, then prints one JSON object of
GPU-type devices (`ggml_backend_dev_count/get/type/name/memory`) to
stdout. Same containment pattern feature 028 established (`cz-host`).
Spawn via `Bun.spawn` with ~1 s budget → `proc.kill()` on timeout.

**Alternatives considered**:
- In-process probe: zero isolation — a driver crash kills the app.
  Rejected by spec.
- Spawn `bun -e` / `process.execPath` with a probe script: works in dev
  but `process.execPath` in a packaged Electrobun bundle is the *app
  binary* — spawning it launches a second app instance, not a script.
- Persist probe result to disk: stale across driver updates/crashes;
  the probe is cheap enough to run fresh each launch (~100–300 ms).

## R3 — Staging layout that keeps the CPU path untouched

**Decision**: GPU backend libs stage into `native/out/<plat>/gpu/`, beside
(not inside) the flat dir that `lls_backend_init` scans. `lls_probe` also
lands in `native/out/<plat>/` root.

**Rationale**: `ffi.ts` already calls `lls_backend_init(dirname(shim))` at
dlopen, and `ggml_backend_load_all_from_path` scans that dir
non-recursively for `[lib]ggml-<name>-*.{so,dylib,dll}`. If
`libggml-vulkan.so` sat next to the CPU variants, the *unconditional*
startup scan would enumerate Vulkan devices in-process — defeating R2's
isolation on every launch. A `gpu/` subdir is invisible to the scan
(directory iteration only touches regular files), so GPU libraries load
in-process only after a probe pass, via the new
`lls_backend_init_gpu(gpuDir)` → `ggml_backend_load_all_from_path(gpuDir)`.
`stage-native.ts` routes `*ggml-vulkan*` / `*ggml-metal*` / `*ggml-opencl*`
into `outDir/gpu/`; everything else keeps the flat layout.

**Alternatives considered**: separate probe-dir naming per backend —
unneeded, one subdir covers all GPU-class backends.

## R4 — Partial-offload fit without upstream `params.fit`

**Decision**: fit `n_gpu_layers` in TypeScript (`fitGpuLayers`) and hand
the shim an explicit count via `lls_model_load2(path, nGpuLayers, err)`;
retry-halve on alloc-class load failures.

**Rationale**: this vendored `llama.h` has no `fit` field in
`llama_model_params` (checked — the tree predates upstream's `--fit`
work). Setting `n_gpu_layers = -1` ("all") makes llama allocate every
layer's device buffer up front; an over-budget attempt fails the whole
load instead of degrading. The workable inputs we already have:
`block_count` (layers) and file size from the GGUF header, and
per-device `free`/`total` VRAM from the probe. So:

- `lls_gguf_meta` gains `nLayer` (`<arch>.block_count`) and `fileBytes`.
- `fitGpuLayers(fileBytes, nLayer, freeBytes)` = `min(nLayer,
  floor(freeBytes × SAFETY / perLayer))` where `perLayer ≈ fileBytes /
  nLayer` (overestimates per-layer cost slightly since embeddings/output
  aren't per-layer → conservative, good) and `SAFETY ≈ 0.8` leaves room
  for the KV cache + compute buffers llama allocates on-device at ctx
  init (`offload_kqv` default).
- Load attempts: `n = fit`; on failure whose message matches
  /alloc|memory|vulkan|device/i → `n = floor(n/2)`, up to 4 attempts;
  terminal `n = 0` is the pure-CPU load (never an error unless CPU also
  fails — FR-004).
- `lls_model_gpu_info(model)` reports `{device, gpuLayers, layersTotal}`
  after a successful load so the true path is surfaced regardless of
  which retry won (FR-006).

**Alternatives considered**:
- `mparams.no_alloc` dry-run sizing: `no_alloc` only skips *host*
  metadata allocation; it doesn't report device-buffer feasibility —
  wrong tool.
- Vendor backport of upstream `params.fit`: large, moving-target patch to
  vendored code; the TS-side fit is ~30 lines and unit-testable.
- Fixed `-1` + llama auto-fallback: llama does **not** shrink
  `n_gpu_layers` on alloc failure — the load errors out. Rejected.

## R5 — Probe timing vs. the <1 s budget (SC-004 / FR-010)

**Decision**: kick `probeGpu()` at RPC-handler init (app start); the
spawn carries a **900 ms kill timeout** and the model-load path awaits
the shared promise only for whatever budget remains — never longer, so
the added latency stays under SC-004's <1 s bound by construction.

**Rationale**: probe spawn + `dlopen` + `vkEnumeratePhysicalDevices` is
typically 100–300 ms; starting it at app init means the result is
already cached by the first `model.load` in every normal session, so the
added latency is ~0. Worst case (app opens → immediate model load on a
cold disk) is bounded by the await budget, then the load proceeds on CPU
*for that load only*; a late-landing probe result is cached and the next
load uses GPU. This keeps FR-003's "route through GPU by default"
semantics while honoring the hard bound.

**Alternatives considered**: probing synchronously inside `model.load`
(always pays latency); probing at OS login / install time (stale,
infrastructure we don't have).

## R6 — Selection policy plumbing

**Decision**: `Settings.computeMode: "auto" | "cpu"` (default `"auto"`,
optional on disk); `engine.loadModel(path, {computeMode})`; registry
slots forward the same resolved mode (per-model policy, FR-003).

**Rationale**: the engine must not read the settings store directly —
handlers/`ModelRegistry` already own that dependency direction
(`EngineLike` is an interface; fake engines in tests ignore the option).
A mid-run GPU fault (`lls_step` −1 while `computePath.mode` is
GPU-class) latches the cached probe result to `{status:"fault"}` so the
*next* load resolves to CPU without user intervention (FR-012's
"subsequent turn MUST be able to succeed on CPU").

**Alternatives considered**: a `"gpu"` force-mode — YAGNI; spec requires
only automatic + CPU-only.

## R7 — Build-time gating

**Decision**: `GGML_VULKAN` ON unconditionally in `CMakeLists.txt` for
`UNIX AND NOT APPLE` and Windows; `build-native.sh`/`.ps1` extend the
existing FR-004 missing-prerequisite check to name `Vulkan SDK`
(headers + `glslc` + `SPIRV-Headers`). An env escape
`CAUSERIE_GPU=off` → `-DGGML_VULKAN=OFF` keeps CPU-only dev builds
possible. macOS: `GGML_METAL` already defaults ON → `libggml-metal.dylib`
is produced today under `GGML_BACKEND_DL`; staging just routes it.

**Rationale**: the spec makes GPU coverage a release requirement
(FR-008, SC-006) — a silent "SDK missing → CPU-only artifact" would ship
a non-compliant package. Fail loud at build; verify at package
(`verify-artifact.sh` gains gpu/-payload + `lls_probe` presence checks).

**Alternatives considered**: `find_package(Vulkan)` soft-fallback —
produces compliant-or-not artifacts depending on builder state; rejected
for release ambiguity (kept as the documented env escape instead).
