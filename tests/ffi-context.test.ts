// feature 030 (T013): FFI boundary — lls_ctx_create_ex honoured by the
// engine: default path gives 4096; a request above the trained maximum
// clamps to it; an in-range request is used verbatim.
// Requires a real GGUF: MODEL_PATH env or ./models/SmolLM2-135M-Instruct-Q4_K_M.gguf
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { LlamaEngine } from "../src/bun/llama/engine";
import { readGgufMeta } from "../src/bun/models/library";

const MODEL =
  process.env.MODEL_PATH ??
  resolve(import.meta.dir, "../models/SmolLM2-135M-Instruct-Q4_K_M.gguf");
const hasModel = existsSync(MODEL);
const suite = hasModel ? describe : describe.skip;

suite("ffi context size", () => {
  test("default path creates a 4096 context", async () => {
    const engine = new LlamaEngine();
    const res = await engine.loadModel(MODEL, { computeMode: "cpu" });
    expect(res.context.requested).toBe(4096);
    expect(res.context.effective).toBe(4096);
    expect(res.context.fallback).toBeNull();
    engine.unloadModel();
  }, 120_000);

  test("request above trained maximum clamps", async () => {
    const trainCtx = readGgufMeta(MODEL)?.contextTrain ?? null;
    const engine = new LlamaEngine();
    const res = await engine.loadModel(MODEL, {
      computeMode: "cpu",
      contextSize: 16384,
    });
    expect(res.context.requested).toBe(16384);
    const want = trainCtx && trainCtx > 0 ? Math.min(16384, trainCtx) : 16384;
    expect(res.context.effective).toBe(want);
    expect(engine.contextSize()).toBe(want);
    engine.unloadModel();
  }, 120_000);

  test("in-range request is used verbatim", async () => {
    const engine = new LlamaEngine();
    const res = await engine.loadModel(MODEL, {
      computeMode: "cpu",
      contextSize: 4096,
    });
    expect(res.context.effective).toBe(4096);
    engine.unloadModel();
  }, 120_000);
});
