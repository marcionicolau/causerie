// GPU availability probe + offload fit math (feature 029).
//
// Design (research.md R2/R5): device enumeration happens in the lls_probe
// CHILD PROCESS so a broken GPU driver can only kill the probe. The probe
// starts at app init; the model-load path awaits the shared result only
// for a bounded budget (PROBE_TIMEOUT_MS) — SC-004's <1 s is guaranteed
// by construction. Result is cached per app run, never persisted.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ComputeMode,
  GpuDeviceInfo,
  GpuProbeResult,
} from "../../shared/types";

export const PROBE_TIMEOUT_MS = 900;
const FIT_SAFETY = 0.8; // leave room for KV cache + compute buffers

export interface ProbeSpawnResult {
  code: number; // process exit code (-1 when killed/spawn failed)
  stdout: string;
  timedOut: boolean;
}

export type ProbeRunner = (
  exe: string,
  gpuDir: string,
  timeoutMs: number,
) => Promise<ProbeSpawnResult>;

// default runner: spawn lls_probe, kill on timeout
const bunRunner: ProbeRunner = async (exe, gpuDir, timeoutMs) => {
  let timedOut = false;
  const proc = Bun.spawn([exe, gpuDir], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [code, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as ReadableStream).text(),
    ]);
    return { code, stdout, timedOut };
  } finally {
    clearTimeout(timer);
  }
};

export interface ProbeDeps {
  runner?: ProbeRunner;
  exists?: (p: string) => boolean;
  timeoutMs?: number;
}

// parse + validate one line of lls_probe stdout; unknown backend strings
// are tolerated (contract: registry name verbatim)
export function parseProbeStdout(text: string): GpuDeviceInfo[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { devices?: unknown }).devices)
  ) {
    return null;
  }
  const out: GpuDeviceInfo[] = [];
  for (const d of (parsed as { devices: unknown[] }).devices) {
    if (typeof d !== "object" || d === null) return null;
    const dev = d as Record<string, unknown>;
    if (
      typeof dev.name !== "string" ||
      typeof dev.backend !== "string" ||
      typeof dev.freeBytes !== "number" ||
      typeof dev.totalBytes !== "number"
    ) {
      return null;
    }
    out.push({
      name: dev.name,
      backend: dev.backend,
      freeBytes: dev.freeBytes,
      totalBytes: dev.totalBytes,
    });
  }
  return out;
}

export async function runProbe(
  shimDir: string,
  deps: ProbeDeps = {},
): Promise<GpuProbeResult> {
  const exists = deps.exists ?? existsSync;
  const runner = deps.runner ?? bunRunner;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const exe = join(
    shimDir,
    process.platform === "win32" ? "lls_probe.exe" : "lls_probe",
  );
  const gpuDir = join(shimDir, "gpu");
  if (!exists(exe)) {
    return {
      status: "unavailable",
      devices: [],
      reason: "probe binary missing",
    };
  }
  if (!exists(gpuDir)) {
    return {
      status: "unavailable",
      devices: [],
      reason: "no gpu backends staged",
    };
  }
  let res: ProbeSpawnResult;
  try {
    res = await runner(exe, gpuDir, timeoutMs);
  } catch (e) {
    return { status: "error", devices: [], reason: `probe spawn: ${e}` };
  }
  if (res.timedOut) {
    return { status: "timeout", devices: [], reason: "probe killed" };
  }
  if (res.code !== 0) {
    return {
      status: "error",
      devices: [],
      reason: `probe exit ${res.code}`,
    };
  }
  const devices = parseProbeStdout(res.stdout);
  if (devices === null) {
    return {
      status: "error",
      devices: [],
      reason: "probe output invalid",
    };
  }
  return devices.length > 0
    ? { status: "available", devices }
    : { status: "unavailable", devices: [], reason: "no devices" };
}

// ---- per-run cache + fault latch ----

let inFlight: Promise<GpuProbeResult> | null = null;
let settled: GpuProbeResult | null = null;
let faulted = false;

// kick the probe at app init — fire-and-forget, result cached
export function startProbe(shimDir: string, deps: ProbeDeps = {}): void {
  if (inFlight !== null || settled !== null) return;
  inFlight = runProbe(shimDir, deps).then((r) => {
    if (!faulted) settled = r;
    inFlight = null;
    return r;
  });
}

// await the cached result for at most budgetMs; a still-pending probe
// yields a bounded "timeout" result for THIS call while the real result
// keeps landing in the background for later loads
export async function awaitProbe(
  budgetMs = PROBE_TIMEOUT_MS,
): Promise<GpuProbeResult> {
  if (settled !== null) return settled;
  if (inFlight === null) {
    return {
      status: "unavailable",
      devices: [],
      reason: "probe not started",
    };
  }
  const pending: Promise<GpuProbeResult> = new Promise((resolve) => {
    const t = setTimeout(
      () =>
        resolve({
          status: "timeout",
          devices: [],
          reason: "probe budget exceeded",
        }),
      budgetMs,
    );
    void t;
  });
  return Promise.race([inFlight, pending]);
}

// FR-012: a GPU-path decode failure latches the probe result to faulted
// so the next load resolves CPU without user intervention
export function reportRuntimeFault(): void {
  faulted = true;
  settled = { status: "error", devices: [], reason: "runtime fault" };
}

// a shim built before this feature lacks the GPU symbols — GPU is
// unusable regardless of what the probe saw (FR-005 degrade)
export function noteStaleShim(): void {
  faulted = true;
  settled = { status: "unavailable", devices: [], reason: "stale shim" };
}

export function probeResult(): GpuProbeResult | null {
  return settled;
}

// test hook: reset module state
export function resetProbeState(): void {
  inFlight = null;
  settled = null;
  faulted = false;
}

// ---- fit + mode resolution (pure) ----

// how many layers fit in freeBytes of VRAM. perLayer overestimates
// slightly (file includes non-layer tensors) → conservative.
// nLayer == null (architectures without block_count) → -1: attempt all,
// llama clamps to the real count and retry-halve governs failure.
export function fitGpuLayers(
  fileBytes: number,
  nLayer: number | null,
  freeBytes: number,
): number {
  if (nLayer === null) return -1;
  if (freeBytes <= 0 || fileBytes <= 0 || nLayer <= 0) return 0;
  const perLayer = fileBytes / nLayer;
  const fit = Math.floor((freeBytes * FIT_SAFETY) / perLayer);
  return Math.max(0, Math.min(nLayer, fit));
}

// next n_gpu_layers after an alloc-class load failure (retry-halve).
// -1 (unknown layer count) can't be halved → retry from a midpoint
// guess of 32, which then halves normally toward 0.
export function halveLayers(n: number): number {
  return n < 0 ? 32 : Math.floor(n / 2);
}

export function resolveMode(
  computeMode: ComputeMode,
  probe: GpuProbeResult,
): "cpu" | "gpu" {
  if (computeMode === "cpu") return "cpu";
  return probe.status === "available" && probe.devices.length > 0
    ? "gpu"
    : "cpu";
}
