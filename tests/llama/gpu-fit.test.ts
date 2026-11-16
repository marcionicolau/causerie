// feature 029 (T010): fitGpuLayers clamping, retry-halve sequence, and
// the resolveMode truth table — all pure, no probe spawn.
import { describe, expect, test } from "bun:test";
import {
  fitGpuLayers,
  halveLayers,
  resolveMode,
} from "../../src/bun/llama/gpu";
import type { ComputeMode, GpuProbeResult } from "../../src/shared/types";

const GiB = 1024 ** 3;

describe("fitGpuLayers", () => {
  test("zero/negative free VRAM → 0 layers (CPU)", () => {
    expect(fitGpuLayers(4 * GiB, 32, 0)).toBe(0);
    expect(fitGpuLayers(4 * GiB, 32, -1)).toBe(0);
  });

  test("fit is capped by the model's layer count", () => {
    // tiny per-layer cost → everything fits
    expect(fitGpuLayers(1000, 32, 100 * GiB)).toBe(32);
  });

  test("conservative per-layer estimate: file includes non-layer tensors", () => {
    // 4 GiB file / 32 layers = 128 MiB/layer; 1 GiB free × 0.8 = 838 MiB
    // → floor(838/128) = 6 layers
    expect(fitGpuLayers(4 * GiB, 32, 1 * GiB)).toBe(6);
  });

  test("exact-boundary fit uses the 0.8 safety headroom", () => {
    // perLayer = 1 GiB; free = 10 GiB → floor(8/1) = 8, not 10
    expect(fitGpuLayers(32 * GiB, 32, 10 * GiB)).toBe(8);
  });

  test("degenerate inputs → 0", () => {
    expect(fitGpuLayers(0, 32, 4 * GiB)).toBe(0); // no file size
    expect(fitGpuLayers(4 * GiB, 0, 4 * GiB)).toBe(0); // no layers
  });

  test("nLayer == null → -1 (attempt all; llama clamps)", () => {
    expect(fitGpuLayers(4 * GiB, null, 8 * GiB)).toBe(-1);
    expect(fitGpuLayers(4 * GiB, null, 0)).toBe(-1);
  });
});

describe("halveLayers (retry-halve sequence)", () => {
  test("halves toward zero", () => {
    expect(halveLayers(32)).toBe(16);
    expect(halveLayers(16)).toBe(8);
    expect(halveLayers(1)).toBe(0);
  });

  test("-1 (unknown count) retries from midpoint guess 32", () => {
    expect(halveLayers(-1)).toBe(32);
  });

  test("typical sequence terminates at CPU", () => {
    let n = 24;
    const seq = [n];
    for (let i = 0; i < 10 && n > 0; i++) {
      n = halveLayers(n);
      seq.push(n);
    }
    expect(seq).toEqual([24, 12, 6, 3, 1, 0]);
  });
});

describe("resolveMode truth table", () => {
  const gpu: GpuProbeResult = {
    status: "available",
    devices: [
      { name: "RTX", backend: "vulkan", freeBytes: 8 * GiB, totalBytes: 12 * GiB },
    ],
  };
  const cases: Array<
    [ComputeMode, GpuProbeResult["status"], "cpu" | "gpu"]
  > = [
    ["auto", "available", "gpu"],
    ["auto", "unavailable", "cpu"],
    ["auto", "error", "cpu"],
    ["auto", "timeout", "cpu"],
    ["cpu", "available", "cpu"],
    ["cpu", "unavailable", "cpu"],
  ];
  for (const [mode, status, want] of cases) {
    test(`${mode} + ${status} → ${want}`, () => {
      const probe: GpuProbeResult =
        status === "available"
          ? gpu
          : { status, devices: [], reason: "x" };
      expect(resolveMode(mode, probe)).toBe(want);
    });
  }

  test("auto + available-but-empty-devices → cpu", () => {
    expect(
      resolveMode("auto", { status: "available", devices: [] }),
    ).toBe("cpu");
  });
});
