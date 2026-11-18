// T017: RoutedSessions selection + fallback semantics.
import { describe, expect, test } from "bun:test";
import { RoutedSessions } from "../../src/bun/scripts/router";
import { BackendUnavailable } from "../../src/bun/scripts/backend";
import type {
  ScriptBackend,
  ScriptCallRequest,
  ScriptCallResult,
} from "../../src/bun/scripts/backend";
import type { ScriptPolicy, ScriptRuntimeKind } from "../../src/shared/types";
import type { HostProbe } from "../../src/bun/scripts/runtimes";

const req = (): ScriptCallRequest => ({
  runId: "r1", path: "/tmp/x.py", args: {}, cwd: "/tmp", timeoutMs: 1000,
});

const ok = (method: "host" | "subprocess"): ScriptCallResult => ({
  outcome: "ok", exitStatus: 0, stdout: "", stderr: "",
  durationMs: 1, files: [], sessionRestarted: false, method,
});

const backend = (kind: "host" | "subprocess", fail = false): ScriptBackend => ({
  kind,
  async ensure() {},
  async call(): Promise<ScriptCallResult> {
    if (fail) throw new BackendUnavailable("host-dead", "boom");
    return ok(kind);
  },
  async reset() {},
  status() { return { state: "live" as const, calls: 0, restartCount: 0 }; },
  async dispose() {},
});

const mk = (
  backendKind: string,
  probe: HostProbe,
  opts: { hostFail?: boolean; notify?: (r: string) => void } = {},
) => {
  const notices: string[] = [];
  const r = new RoutedSessions({
    getPolicy: () => ({ mode: "allow-session", backend: backendKind } as ScriptPolicy),
    emit: () => {},
    notifyFallback: (x) => (opts.notify?.(x), notices.push(x)),
    probe: () => probe,
    makeHost: () => backend("host", opts.hostFail ?? false),
    makeSub: () => backend("subprocess"),
  });
  return { r, notices };
};

describe("RoutedSessions", () => {
  test("auto + usable host → method host", async () => {
    const { r } = mk("auto", { usable: true, libPath: "/x.so" });
    const res = await r.call("python", "/usr/bin/python3.14", req());
    expect(res.method).toBe("host");
  });

  test("auto + unusable host → subprocess + reason recorded", async () => {
    const { r } = mk("auto", { usable: false, libPath: null, reason: "python-3.11" });
    const res = await r.call("python", "/usr/bin/python3", req());
    expect(res.method).toBe("subprocess");
    expect(res.methodReason).toBe("python-3.11");
  });

  test("auto + host fault → subprocess retry + one-time notice (FR-019)", async () => {
    const { r, notices } = mk(
      "auto",
      { usable: true, libPath: "/x.so" },
      { hostFail: true },
    );
    const res = await r.call("python", "/usr/bin/python3.14", req());
    expect(res.method).toBe("subprocess");
    expect(res.methodReason).toContain("host-failed");
    expect(notices).toHaveLength(1);
    // second call: notice suppressed (one-time)
    await r.call("python", "/usr/bin/python3.14", req());
    expect(notices).toHaveLength(1);
  });

  test("pinned subprocess → never probes host", async () => {
    const { r } = mk("subprocess", { usable: true, libPath: "/x.so" });
    const res = await r.call("python", "/usr/bin/python3.14", req());
    expect(res.method).toBe("subprocess");
    expect(res.methodReason).toBe("pinned");
  });

  test("pinned host + unusable → clear error, no fallback", async () => {
    const { r } = mk("host", { usable: false, libPath: null, reason: "no-libpython" });
    await expect(r.call("python", "/usr/bin/python3", req())).rejects.toBeInstanceOf(
      BackendUnavailable,
    );
  });

  test("stored 'embedded' migrates to auto semantics", async () => {
    const { r } = mk("embedded", { usable: false, libPath: null, reason: "no-libR" });
    const res = await r.call("r", "/usr/bin/Rscript", req());
    expect(res.method).toBe("subprocess");
    expect(res.methodReason).toBe("no-libR");
  });
});
