// feature 030 (T022): each loaded model resolves its own context size
// (per-model basename key > global > 4096) through the same ctxRequestedFor
// the fusion planner/executor loads use.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRequestHandlers,
  type EngineLike,
  type StoreLike,
} from "../src/bun/rpc/handlers";
import type { Settings } from "../src/shared/types";
import { DEFAULT_GENERATION } from "../src/shared/types";

const dir = mkdtempSync(join(tmpdir(), "ctx-fusion-"));
process.env.MODELS_DIR = dir;
const P = join(dir, "p.gguf");
const E = join(dir, "e.gguf");
const O = join(dir, "o.gguf");
writeFileSync(P, "x");
writeFileSync(E, "x");
writeFileSync(O, "x");

function makeDeps(context: Settings["context"]) {
  const settings: Settings = {
    activeModelPath: null,
    contextLimitWarning: false,
    generation: DEFAULT_GENERATION,
    modelOverrides: {},
    outputPanel: false,
    tags: [],
    context,
  };
  const loads: { path: string; contextSize?: number }[] = [];
  const engine: EngineLike = {
    status: () => ({ status: "ready", name: "x.gguf" }),
    loadModel: async (path: string, opts?: { contextSize?: number }) => {
      loads.push({ path, contextSize: opts?.contextSize });
      return { status: "ready" as const, name: path };
    },
    unloadModel: () => {},
    isGenerating: () => false,
    contextSize: () => 4096,
    chatTemplate: () => null,
    tokenCount: (t: string) => t.length,
    stop: () => {},
    generate: async () => ({
      status: "complete",
      tokens: 0,
      elapsedMs: 1,
      warm: false,
    }),
  };
  const store: StoreLike = {
    getConversation: () => null,
    saveConversation: () => {},
    listConversations: () => [],
    deleteConversation: () => false,
    getSettings: () => settings,
    saveSettings: (n) => Object.assign(settings, n),
  };
  const h = createRequestHandlers({
    engine,
    store,
    emit: () => {},
  });
  return { h, loads };
}

describe("per-model context resolution", () => {
  test("each file basename resolves its own size", async () => {
    const { h, loads } = makeDeps({
      default: 16384,
      perModel: { "p.gguf": 8192 },
    });
    await h["model.load"]({ path: P });
    await h["model.load"]({ path: E });
    await h["model.load"]({ path: O });
    expect(loads.map((l) => l.contextSize)).toEqual([8192, 16384, 16384]);
  });

  test("no settings -> every model gets the 4096 default", async () => {
    const { h, loads } = makeDeps(undefined);
    await h["model.load"]({ path: P });
    expect(loads[0].contextSize).toBe(4096);
  });
});
