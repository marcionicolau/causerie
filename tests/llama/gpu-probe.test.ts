// feature 029 (T011): probe JSON parse/schema validation, runner fault
// mapping (timeout/exit/error), and the reportRuntimeFault latch — all
// through injected ProbeDeps so no real subprocess spawns.
import { describe, expect, test, beforeEach } from "bun:test";
import {
  awaitProbe,
  parseProbeStdout,
  probeResult,
  reportRuntimeFault,
  resetProbeState,
  runProbe,
  startProbe,
} from "../../src/bun/llama/gpu";

beforeEach(() => resetProbeState());

const DEV = {
  name: "Mock GPU",
  backend: "vulkan",
  freeBytes: 8 * 1024 ** 3,
  totalBytes: 12 * 1024 ** 3,
};
const okRunner = async () => ({
  code: 0,
  stdout: JSON.stringify({ devices: [DEV] }),
  timedOut: false,
});

describe("parseProbeStdout", () => {
  test("valid payload → device list", () => {
    expect(parseProbeStdout(JSON.stringify({ devices: [DEV] }))).toEqual([
      DEV,
    ]);
  });

  test("empty devices → []", () => {
    expect(parseProbeStdout('{"devices":[]}')).toEqual([]);
  });

  test("malformed JSON → null", () => {
    expect(parseProbeStdout("not json")).toBeNull();
    expect(parseProbeStdout("")).toBeNull();
  });

  test("missing/wrong-typed fields → null", () => {
    expect(parseProbeStdout("{}")).toBeNull();
    expect(parseProbeStdout('{"devices":42}')).toBeNull();
    expect(
      parseProbeStdout('{"devices":[{"name":"x"}]}'),
    ).toBeNull();
    expect(
      parseProbeStdout(
        '{"devices":[{"name":"x","backend":"v","freeBytes":"1","totalBytes":2}]}',
      ),
    ).toBeNull();
  });

  test("unknown backend string tolerated; extra fields ignored", () => {
    const d = { ...DEV, backend: "future-gpu", extra: true };
    const out = parseProbeStdout(JSON.stringify({ devices: [d] }));
    expect(out?.[0]?.backend).toBe("future-gpu");
  });
});

describe("runProbe", () => {
  const existsAll = () => true;

  test("missing probe binary → unavailable, no spawn", async () => {
    let spawned = false;
    const r = await runProbe("/nonexistent", {
      exists: () => false,
      runner: async () => {
        spawned = true;
        return { code: 0, stdout: "", timedOut: false };
      },
    });
    expect(r.status).toBe("unavailable");
    expect(r.reason).toContain("missing");
    expect(spawned).toBe(false);
  });

  test("absent gpu/ dir → unavailable, no spawn", async () => {
    const r = await runProbe("/d", {
      exists: (p) => p.endsWith("lls_probe"),
      runner: okRunner,
    });
    expect(r.status).toBe("unavailable");
    expect(r.reason).toContain("gpu backends");
  });

  test("device JSON → available", async () => {
    const r = await runProbe("/d", { exists: existsAll, runner: okRunner });
    expect(r.status).toBe("available");
    expect(r.devices).toEqual([DEV]);
  });

  test("empty devices → unavailable", async () => {
    const r = await runProbe("/d", {
      exists: existsAll,
      runner: async () => ({
        code: 0,
        stdout: '{"devices":[]}',
        timedOut: false,
      }),
    });
    expect(r.status).toBe("unavailable");
  });

  test("fake-probe timeout → timeout", async () => {
    const r = await runProbe("/d", {
      exists: existsAll,
      runner: async () => ({ code: -1, stdout: "", timedOut: true }),
    });
    expect(r.status).toBe("timeout");
    expect(r.reason).toContain("killed");
  });

  test("nonzero exit → error", async () => {
    const r = await runProbe("/d", {
      exists: existsAll,
      runner: async () => ({
        code: 3,
        stdout: '{"devices":[]}',
        timedOut: false,
      }),
    });
    expect(r.status).toBe("error");
    expect(r.reason).toContain("exit 3");
  });

  test("runner throw → error (spawn failure)", async () => {
    const r = await runProbe("/d", {
      exists: existsAll,
      runner: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(r.status).toBe("error");
  });

  test("invalid stdout → error", async () => {
    const r = await runProbe("/d", {
      exists: existsAll,
      runner: async () => ({ code: 0, stdout: "garbage", timedOut: false }),
    });
    expect(r.status).toBe("error");
    expect(r.reason).toContain("invalid");
  });
});

describe("probe cache + fault latch", () => {
  test("startProbe caches the settled result; probeResult() reads it", async () => {
    expect(probeResult()).toBeNull();
    startProbe("/d", { exists: () => true, runner: okRunner });
    const r = await awaitProbe(1000);
    expect(r.status).toBe("available");
    expect(probeResult()?.status).toBe("available");
  });

  test("awaitProbe before start → unavailable, no throw", async () => {
    const r = await awaitProbe(50);
    expect(r.status).toBe("unavailable");
    expect(r.reason).toContain("not started");
  });

  test("slow probe → bounded timeout result for this call only", async () => {
    startProbe("/d", {
      exists: () => true,
      runner: () =>
        new Promise((res) =>
          setTimeout(
            () =>
              res({ code: 0, stdout: '{"devices":[]}', timedOut: false }),
            500,
          ),
        ),
    });
    const r = await awaitProbe(30);
    expect(r.status).toBe("timeout");
    // the real result still lands for later loads
    const late = await awaitProbe(1000);
    expect(late.status).toBe("unavailable"); // empty devices
  });

  test("reportRuntimeFault latches error over a settled result", async () => {
    startProbe("/d", { exists: () => true, runner: okRunner });
    await awaitProbe(1000);
    expect(probeResult()?.status).toBe("available");
    reportRuntimeFault();
    const r = await awaitProbe(1000);
    expect(r.status).toBe("error");
    expect(r.reason).toContain("runtime fault");
  });

  test("fault before settle overrides the landing result", async () => {
    startProbe("/d", { exists: () => true, runner: okRunner });
    reportRuntimeFault();
    const r = await awaitProbe(1000);
    expect(r.status).toBe("error");
  });
});
