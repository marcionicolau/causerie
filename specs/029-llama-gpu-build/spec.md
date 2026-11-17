# Feature Specification: Portable CPU/GPU Inference Build

**Feature Branch**: `029-llama-gpu-build`

**Created**: 2026-11-16

**Status**: Draft

**Input**: User description: "plan a complete spec to extent llama.cpp to work both CPU/GPU and to enable the build at deployed PC based on simple gpu availability check"

## Clarifications

### Session 2026-11-16

- Q: When a model doesn't fully fit in GPU memory, what should the system do? → A: Partial GPU offload — place as much of the model on GPU as fits, run the rest on CPU; no fit at all falls back to pure CPU.
- Q: When multiple models are resident at once (fusion mode), should the GPU path apply to each model independently? → A: Per-model policy — every loaded model (default, planner, executor) offloads to the GPU independently; all share GPU memory, each degrades per its own fit.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - GPU Machine Gets Accelerated Inference Automatically (Priority: P1)

A user installs the packaged app on a PC that has a usable GPU. The app detects
the GPU and accelerates model inference with it — no separate download, no
manual configuration. Chat responses arrive noticeably faster than on a
CPU-only machine running the same model.

**Why this priority**: This is the core value of the feature. GPU offload is
the single biggest speedup available for local inference; making it automatic
on capable hardware means every eligible user benefits without knowing
anything about compute backends.

**Independent Test**: Can be fully tested by installing the same artifact on a
GPU-equipped machine, loading a model, sending a message, and confirming the
active compute path is the GPU and token throughput exceeds the CPU baseline
for the same model.

**Acceptance Scenarios**:

1. **Given** a deployed machine with a working, supported GPU, **When** the
   user loads a model and sends a chat message, **Then** inference runs on the
   GPU and the response streams normally.
2. **Given** a deployed machine with a working, supported GPU, **When** the
   user opens the model/performance surface, **Then** the active compute path
   is visibly identified as GPU.

---

### User Story 2 - CPU-Only Machine Is Unaffected (Priority: P1)

A user installs the same package on a PC with no usable GPU (no discrete or
integrated GPU support, missing/broken drivers, or GPU support deliberately
unavailable). The app works exactly as it does today: model loads, inference
runs on the CPU, and the user never sees GPU-related errors.

**Why this priority**: Equally critical — GPU support must be strictly
additive. A regression where a CPU-only user hits a missing-library failure or
a failed GPU probe would break the existing baseline experience.

**Independent Test**: Can be fully tested by installing the same artifact on a
machine without a usable GPU, loading a model, and verifying a normal chat
turn with the compute path shown as CPU.

**Acceptance Scenarios**:

1. **Given** a deployed machine with no usable GPU, **When** the user loads a
   model and chats, **Then** inference runs on the CPU with no GPU-related
   error surfaced.
2. **Given** a machine where the GPU probe itself fails (drivers absent or
   corrupted), **When** the app runs the availability check, **Then** it
   records "GPU unavailable" and proceeds on CPU without user intervention.

---

### User Story 3 - User Can Inspect and Override the Compute Path (Priority: P2)

A user wants to know which compute path is in use — or needs to force CPU
because the GPU path misbehaves on their machine (driver bugs, shared-memory
pressure, thermal concerns). The app exposes the active backend and honors a
persisted user override.

**Why this priority**: Important for trust and for recovery from edge-case
driver failures, but not required for the primary value — most users should
never need it.

**Independent Test**: Can be tested by toggling the compute preference to
"force CPU" on a GPU machine and confirming the next model load reports CPU
as the active path.

**Acceptance Scenarios**:

1. **Given** a GPU-equipped machine using GPU inference, **When** the user
   sets the compute preference to "CPU only", **Then** subsequent model loads
   use the CPU path and the UI reports CPU.
2. **Given** any machine, **When** the user views the model or settings area,
   **Then** the currently selected compute preference and the detected GPU
   availability result are visible.

---

### Edge Cases

- GPU is present but its driver/runtime is missing, outdated, or broken →
  the availability check fails cleanly and CPU is used.
- GPU probe succeeds but model cannot fully reside in GPU memory → system
  uses partial offload (as much of the model on GPU as fits, remainder on
  CPU); when nothing fits, it runs purely on CPU — never a crash or
  corrupted output.
- GPU becomes unavailable between check and model load (driver reset, device
  unplugged on external GPUs) → the load error path reports the failure and
  the next attempt can succeed on CPU.
- Availability check on a machine where the probe itself crashes or hangs →
  check is isolated/bounded so the app still reaches the CPU path.
- The packaged artifact is deployed to a machine with a GPU of an
  unsupported vendor/API → treated identically to "no usable GPU".
- A GPU becomes available only after app start (driver finishes
  installing, eGPU plugged in) → availability is evaluated once per app
  run; the device is picked up on the next app launch.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A single packaged artifact per platform MUST run correctly on
  machines with and without a usable GPU; no separate GPU/CPU build variants
  may be required from the user.
- **FR-002**: The system MUST perform a bounded GPU availability check on the
  deployed machine and record its result before or during model load.
- **FR-003**: When a usable GPU is detected, the system MUST route model
  inference through the GPU path by default. The policy applies per model
  load — every resident model (single-mode default and fusion
  planner/executor alike) offloads to shared GPU memory independently and
  degrades per its own fit; no role is hard-pinned to CPU.
- **FR-004**: When no usable GPU is detected — including when the probe fails,
  errors, or reports an unsupported device — the system MUST transparently
  fall back to the existing CPU path.
- **FR-005**: GPU availability failure MUST NOT prevent app startup, model
  loading, or inference on the CPU.
- **FR-006**: The system MUST surface the active compute path (GPU or CPU) in
  the UI so the user can tell which path served a conversation.
- **FR-007**: The system MUST provide a persisted user preference to override
  the automatic selection (at minimum: automatic, CPU-only).
- **FR-008**: GPU acceleration coverage MUST include a cross-vendor
  Vulkan-class backend (NVIDIA/AMD/Intel on Linux and Windows) and the Apple
  GPU backend on macOS. Vendor-toolkit stacks (e.g., CUDA-class NVIDIA
  runtimes) are out of scope for the first release.
- **FR-009**: When a model exceeds GPU memory, the system MUST use partial
  offload — placing as much of the model on the GPU as fits and executing
  the remainder on CPU — rather than failing the load or silently degrading
  to pure CPU while capacity remains.
- **FR-010**: The GPU availability check MUST be "simple" in the user's sense:
  presence-of-capable-device plus probe-load, not a lengthy benchmark; it MUST
  not materially delay startup.
- **FR-011**: Output produced through the GPU path MUST be usable and coherent
  — token streams, stop conditions, and tool/persona/prompt assembly MUST
  behave identically to the CPU path (small numeric divergence in sampled
  tokens is acceptable; broken output is not).
- **FR-012**: If GPU initialization or inference fails mid-run, the system
  MUST surface an error state to the user rather than corrupting output or
  hanging the turn; a subsequent turn MUST be able to succeed on CPU.

### Key Entities

- **Compute path**: The execution route used for inference — CPU or GPU —
  including which device/backend served a model load, and the reason recorded
  when GPU is unavailable (absent, unsupported, probe failure).
- **Compute preference**: A persisted user setting selecting automatic
  detection or a forced path; default is automatic.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The same package installs and completes a chat turn on 100% of
  test machines — GPU-equipped and CPU-only alike — with zero
  user intervention.
- **SC-002**: On a representative discrete-GPU machine, the same model's
  token-generation throughput is measurably higher than the CPU path
  (target: ≥2× decode speedup on mid-range discrete GPUs).
- **SC-003**: On a machine with no usable GPU, a chat turn completes with no
  GPU-related errors shown to the user.
- **SC-004**: The GPU availability check adds less than 1 second to model
  load time in the worst case.
- **SC-005**: Switching the compute preference to "CPU only" takes effect on
  the next model load without reinstalling or restarting the machine —
  verifiable via the reported active path.
- **SC-006**: Installer/package size increase attributable to GPU support is
  bounded (target: under 150 MB added per platform) and documented in the
  release notes.

## Assumptions

- The inference layer already supports pluggable compute backends loaded at
  runtime; this feature ships additional backend payload and a selection
  policy, not a new inference engine.
- "Deployed PC" means an end user's machine at run time — the availability
  check runs on that machine when the app starts or when a model loads, not
  at build time on the packaging machine.
- Automatic detection is the default behavior; the CPU-only override exists
  for recovery, not as a required step for normal users.
- Model-fit concerns (whether a model fits GPU memory) remain the job of the
  existing model advisor; the GPU path must degrade gracefully when memory is
  insufficient.
- Supported platforms for this feature are the same as the existing packaged
  release (Linux x64 first, others as already supported); macOS GPU coverage
  uses the vendor framework that ships with the OS, so it adds no external
  runtime requirement.
- External/eGPU hot-unplug during a live session is out of scope beyond a
  clean error path.
- The availability check is purely local — device enumeration makes no
  network calls and emits no telemetry.
