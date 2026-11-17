// feature 030 (T006): persisted settings.context survives a round-trip;
// out-of-range / non-integer entries are dropped on read (sanitize).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ctx-store-"));
process.env.APP_DATA_DIR = dir;

const { getSettings, saveSettings } = await import(
  "../src/bun/store/json-store"
);
const { settingsFile } = await import("../src/bun/store/paths");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("settings.context persistence", () => {
  test("valid context settings round-trip", () => {
    const s = getSettings();
    saveSettings({
      ...s,
      context: { default: 8192, perModel: { "a.gguf": 16384 } },
    });
    const r = getSettings();
    expect(r.context?.default).toBe(8192);
    expect(r.context?.perModel?.["a.gguf"]).toBe(16384);
  });

  test("hand-edited invalid values are dropped on read", () => {
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        context: {
          default: -1, // below 512
          perModel: { "a.gguf": 8192, "b.gguf": "big", "c.gguf": 2_000_000 },
        },
      }),
    );
    const s = getSettings();
    expect(s.context?.default).toBeUndefined();
    expect(s.context?.perModel).toEqual({ "a.gguf": 8192 });
  });
});
