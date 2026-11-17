// feature 030 (T016): memory failure at a non-default size retries once
// at 4096 and reports fallback {reason:"memory"}; a memory failure at
// 4096 never retries; a non-memory failure propagates without retry.
import { describe, expect, test } from "bun:test";
import { ptr, toArrayBuffer } from "bun:ffi";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineError, LlamaEngine } from "../src/bun/llama/engine";

let failWith: string | null = null;
let createCalls: number[] = [];
const keepAlive: Buffer[] = [];

// the engine passes the err slot as a numeric address — write a C
// string pointer into it so the real readErr sees the message
const setErr = (addr: number, m: string) => {
  const buf = Buffer.from(m + "\0", "utf8");
  keepAlive.push(buf);
  new BigUint64Array(toArrayBuffer(addr, 0, 8))[0] = BigInt(ptr(buf));
};

const symbols = {
  lls_model_load: () => 7,
  lls_ctx_create_ex: (_m: number, n: number, errAddr: number) => {
    createCalls.push(n);
    if (failWith !== null) {
      const w = failWith;
      failWith = null;
      setErr(errAddr, w);
      return null;
    }
    return 9;
  },
  lls_ctx_size: () => 4096,
  lls_ctx_free: () => {},
  lls_model_free: () => {},
  lls_free_string: () => {},
};

const fakeShim = { lib: null, path: "/tmp/fake-shim.so", symbols } as never;

const dir = mkdtempSync(join(tmpdir(), "ctx-fallback-"));
const MODEL = join(dir, "m.gguf");
writeFileSync(MODEL, "x");

describe("engine context fallback", () => {
  test("memory failure at 16384 retries at default and reports fallback", async () => {
    createCalls = [];
    failWith = "out of memory allocating ctx";
    const res = await new LlamaEngine(() => fakeShim).loadModel(MODEL, {
      computeMode: "cpu",
      contextSize: 16384,
    });
    expect(createCalls).toEqual([16384, 0]);
    expect(res.context).toEqual({
      requested: 16384,
      effective: 4096,
      fallback: { reason: "memory" },
    });
  });

  test("memory failure at the default never retries", async () => {
    createCalls = [];
    failWith = "out of memory allocating ctx";
    await expect(
      new LlamaEngine(() => fakeShim).loadModel(MODEL, {
        computeMode: "cpu",
        contextSize: 4096,
      }),
    ).rejects.toThrow(EngineError);
    expect(createCalls).toEqual([4096]);
  });

  test("non-memory failure at 16384 propagates without retry", async () => {
    createCalls = [];
    failWith = "tensor type unsupported";
    await expect(
      new LlamaEngine(() => fakeShim).loadModel(MODEL, {
        computeMode: "cpu",
        contextSize: 16384,
      }),
    ).rejects.toThrow(EngineError);
    expect(createCalls).toEqual([16384]);
  });
});
