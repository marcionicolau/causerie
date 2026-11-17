// feature 029 (T016): compute.status shape per probe status,
// settings.set {computeMode} validation + persistence, and the
// computeMode:"cpu" load path (GPU symbols never touched).
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRequestHandlers,
  type EngineLike,
  type StoreLike,
} from "../../src/bun/rpc/handlers";
import {
  resetProbeState,
  startProbe,
  reportRuntimeFault,
} from "../../src/bun/llama/gpu";
import type { Settings } from "../../src/shared/types";
import { DEFAULT_GENERATION } from "../../src/shared/types";

const dir = mkdtempSync(join(tmpdir(), "compute-rpc-"));
process.env.MODELS_DIR = dir;
writeFileSync(join(dir, "e.gguf"), "x");

beforeEach(() => resetProbeState());

function makeStore(settings?: Partial<Settings>) {
  const s: Settings = {
    activeModelPath: null,
    contextLimitWarning: false,
    generation: DEFAULT_GENERATION,
    modelOverrides: {},
    outputPanel: false,
    tags: [],
    ...settings,
  };
  const store: StoreLike = {
    getConversation: () => null,
    saveConversation: () => {},
    listConversations: () => [],
    deleteConversation: () => false,
    getSettings: () => s,
    saveSettings: (n) => Object.assign(s, n),
  };
  return { store, settings: s };
}

function fakeEngine(): EngineLike & {
  loadCalls: { path: string; opts?: { computeMode?: string } }[];
} {
  const loadCalls: { path: string; opts?: { computeMode?: string } }[] = [];
  return {
    loadCalls,
    status: () => ({ status: "unloaded" }),
    loadModel: async (path: string, opts?: { computeMode?: "auto" | "cpu" }) => {
      loadCalls.push({ path, opts });
      return { status: "ready", name: path, compute: { mode: "cpu" } };
    },
    unloadModel: () => {},
    isGenerating: () => false,
    contextSize: () => 4096,
    chatTemplate: () => null,
    tokenCount: (t: string) => t.length,
    generate: async () => ({
      status: "complete" as const,
      tokens: 1,
      elapsedMs: 1,
      warm: true,
    }),
    stop: () => {},
    computePath: () => ({ mode: "cpu" }),
  };
}

function makeDeps(settings?: Partial<Settings>) {
  const emitted: { method: string; payload: unknown }[] = [];
  const { store, settings: s } = makeStore(settings);
  const engine = fakeEngine();
  const deps = {
    engine,
    store,
    emit: (m: string, p: unknown) => emitted.push({ method: m, payload: p }),
  } as never;
  const call = (method: string, params: Record<string, unknown>) =>
    (createRequestHandlers(deps) as never)[method](params);
  return { call, emitted, settings: s, engine };
}

const kick = async (runner?: () => Promise<{
  code: number;
  stdout: string;
  timedOut: boolean;
}>) => {
  startProbe("/d", {
    exists: () => true,
    runner:
      runner ??
      (async () => ({
        code: 0,
        stdout: JSON.stringify({
          devices: [
            { name: "G", backend: "vulkan", freeBytes: 1, totalBytes: 2 },
          ],
        }),
        timedOut: false,
      })),
  });
  // let the in-flight promise settle into the cache
  await new Promise((r) => setTimeout(r, 10));
};

describe("compute.status", () => {
  test("no probe result yet → probed:false, unavailable", async () => {
    const { call } = makeDeps();
    const r = await call("compute.status", {});
    expect(r.probed).toBe(false);
    // lazy kick starts a probe but this call can't see it
    expect(["unavailable", "available"]).toContain(r.status);
    expect(r.mode).toBe("auto");
    expect(r.active).toEqual({ mode: "cpu" });
  });

  test("available → devices + active path", async () => {
    await kick();
    const { call } = makeDeps();
    const r = await call("compute.status", {});
    expect(r.probed).toBe(true);
    expect(r.status).toBe("available");
    expect(r.devices[0].name).toBe("G");
    expect(r.mode).toBe("auto");
  });

  test("timeout result propagates", async () => {
    await kick(async () => ({ code: -1, stdout: "", timedOut: true }));
    const { call } = makeDeps();
    const r = await call("compute.status", {});
    expect(r.status).toBe("timeout");
  });

  test("error result propagates", async () => {
    await kick(async () => ({ code: 7, stdout: "", timedOut: false }));
    const { call } = makeDeps();
    const r = await call("compute.status", {});
    expect(r.status).toBe("error");
    expect(r.reason).toContain("exit 7");
  });

  test("runtime fault → error status", async () => {
    await kick();
    reportRuntimeFault();
    const { call } = makeDeps();
    const r = await call("compute.status", {});
    expect(r.status).toBe("error");
    expect(r.reason).toContain("runtime fault");
  });

  test("computeMode:cpu → disabled, devices []", async () => {
    await kick();
    const { call } = makeDeps({ computeMode: "cpu" });
    const r = await call("compute.status", {});
    expect(r.status).toBe("disabled");
    expect(r.devices).toEqual([]);
    expect(r.mode).toBe("cpu");
  });
});

describe("settings.set computeMode", () => {
  test("roundtrips + defaults to auto", async () => {
    const { call, settings } = makeDeps();
    expect((await call("settings.get", {})).computeMode).toBe("auto");
    await call("settings.set", { computeMode: "cpu" });
    expect(settings.computeMode).toBe("cpu");
    expect((await call("settings.get", {})).computeMode).toBe("cpu");
    await call("settings.set", { computeMode: "auto" });
    expect(settings.computeMode).toBe("auto");
  });

  test("invalid values rejected", async () => {
    const { call } = makeDeps();
    for (const bad of ["gpu", "junk", 1]) {
      try {
        await call("settings.set", { computeMode: bad });
        expect.unreachable(`computeMode=${bad} accepted`);
      } catch (e) {
        expect((e as { code?: string }).code).toBe("INVALID_PARAMS");
      }
    }
  });
});

describe("model.load compute path", () => {
  test("loadModel receives resolved computeMode at call time", async () => {
    const { call, engine, settings } = makeDeps({ computeMode: "cpu" });
    await call("model.load", { path: join(dir, "e.gguf") });
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.loadCalls[0]?.opts?.computeMode).toBe("cpu");
    // mid-session preference change is honored by the NEXT load
    settings.computeMode = "auto";
    await call("model.load", { path: join(dir, "e.gguf") });
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.loadCalls[1]?.opts?.computeMode).toBe("auto");
  });
});
