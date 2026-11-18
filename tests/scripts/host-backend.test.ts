// T008/T013/T017: HostBackend + RoutedSessions over a fake cz-host.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { HostBackend } from "../../src/bun/scripts/backends/host";
import { RoutedSessions } from "../../src/bun/scripts/router";
import { BackendUnavailable } from "../../src/bun/scripts/backend";
import type { ScriptCallRequest } from "../../src/bun/scripts/backend";

import { writeFileSync } from "node:fs";

const FAKE = new URL("./fake-cz-host.ts", import.meta.url).pathname;
const MOD = "/tmp/fake-mod.so"; // path only needs to exist on disk

const req = (over: Partial<ScriptCallRequest> = {}): ScriptCallRequest => ({
  runId: "r1",
  path: "/tmp/fake.py",
  args: {},
  cwd: "/tmp",
  timeoutMs: 5000,
  ...over,
});

// HostBackend spawns [bin, --module, mod, ...] — we point bin at a
// shim shell script that execs bun on the fake host.
function mk(env: Record<string, string> = {}) {
  const shim = `/tmp/fake-cz-host-${Math.random().toString(36).slice(2)}.sh`;
  const envs = Object.entries(env)
    .map(([k, v]) => `${k}=${v} `)
    .join("");
  writeFileSync(
    shim,
    `#!/bin/sh\nexec env ${envs}${Bun.which("bun")} ${FAKE} "$@"\n`,
    { mode: 0o755 },
  );
  return new HostBackend({
    hostPath: () => shim,
    modulePathFor: () => MOD,
    libPath: () => "/tmp/fake-lib.so",
  });
}

beforeAll(() => { writeFileSync(MOD, "x"); writeFileSync("/tmp/fake-lib.so", "x"); });

describe("HostBackend", () => {
  test("ready handshake + run returns outcome/sha", async () => {
    const b = mk();
    await b.ensure("python", "/usr/bin/python3.14");
    const r = await b.call("python", req());
    expect(r.outcome).toBe("ok");
    expect(r.contentSha256).toBe("abc123");
    expect(r.method).toBe("host");
    expect(r.stdout).toContain("ran:/tmp/fake.py");
    await b.dispose();
  });

  test("source_missing maps through", async () => {
    const b = mk();
    await b.ensure("python", "/usr/bin/python3.14");
    const r = await b.call("python", req({ path: "/tmp/missing-x.py" }));
    expect(r.outcome).toBe("source_missing");
    await b.dispose();
  });

  test("ABI mismatch → BackendUnavailable at ensure (T009)", async () => {
    const b = mk({ FAKE_ABI: "99" });
    await expect(b.ensure("python", "/usr/bin/python3.14")).rejects.toBeInstanceOf(
      BackendUnavailable,
    );
  });

  test("language mismatch → BackendUnavailable", async () => {
    const b = mk({ FAKE_LANG: "r" });
    await expect(b.ensure("python", "/usr/bin/python3.14")).rejects.toBeInstanceOf(
      BackendUnavailable,
    );
  });

  test("host crash → host_fault, next call respawns (T011)", async () => {
    const b = mk({ FAKE_DIE: "1" });
    await b.ensure("python", "/usr/bin/python3.14");
    const r = await b.call("python", req());
    expect(r.outcome).toBe("host_fault");
    // session is dead — ensure respawns a fresh host
    await b.ensure("python", "/usr/bin/python3.14");
    const r2 = await b.call("python", req());
    // fresh fake host dies again on ITS first call — still host_fault
    expect(r2.outcome).toBe("host_fault");
    await b.dispose();
  });

  test("timeout → kill escalation resolves promptly (T011)", async () => {
    const b = mk({ FAKE_HANG: "1" });
    await b.ensure("python", "/usr/bin/python3.14");
    const t0 = performance.now();
    const r = await b.call("python", req({ timeoutMs: 300 }));
    expect(["timeout", "interrupted", "host_fault"]).toContain(r.outcome);
    expect(performance.now() - t0).toBeLessThan(5000);
    await b.dispose();
  });
});
