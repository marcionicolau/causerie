// feature 030 (T024): a KV snapshot saved at one context size is
// discarded when the model is later run at another (lookup gates on
// ctxSize — US4).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryKey, SnapshotStore } from "../src/bun/kv/store";

const dir = mkdtempSync(join(tmpdir(), "kv-ctx-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("snapshot ctxSize gate", () => {
  test("lookup at a different ctxSize misses; same ctxSize hits", () => {
    const store = new SnapshotStore(dir);
    const key = entryKey("conv-1", "main");
    // save() stats the blob the shim would have written via .tmp -> rename
    writeFileSync(join(dir, "conv-1_main.kv"), "blob");
    store.save({
      key,
      convId: "conv-1",
      roleKey: "main",
      modelPath: "/models/m.gguf",
      fingerprint: "fp-1",
      ctxSize: 4096,
    });
    expect(store.lookup(key, "fp-1", 4096)).not.toBeNull();
    expect(store.lookup(key, "fp-1", 8192)).toBeNull();
    expect(store.lookup(key, "fp-1", 16384)).toBeNull();
  });
});
