// spec 030 T005: resolveContextSize / sanitizeContextSettings unit tests
import { describe, expect, test } from "bun:test";
import {
  isValidContextSize,
  resolveContextSize,
  sanitizeContextSettings,
} from "../src/bun/llama/context-size";

describe("resolveContextSize", () => {
  test("unset settings → 4096 from default", () => {
    expect(resolveContextSize(undefined, "m.gguf", 32768)).toEqual({
      requested: 4096,
      effective: 4096,
      source: "default",
      clamp: null,
    });
  });

  test("global default applies to any model", () => {
    const r = resolveContextSize({ default: 16384 }, "m.gguf", 32768);
    expect(r.requested).toBe(16384);
    expect(r.effective).toBe(16384);
    expect(r.source).toBe("global");
  });

  test("per-model override wins over global", () => {
    const r = resolveContextSize(
      { default: 8192, perModel: { "m.gguf": 16384 } },
      "m.gguf",
      131072,
    );
    expect(r.source).toBe("model");
    expect(r.effective).toBe(16384);
  });

  test("per-model key only matches the basename", () => {
    const r = resolveContextSize(
      { perModel: { "other.gguf": 16384 } },
      "m.gguf",
      131072,
    );
    expect(r.source).toBe("default");
    expect(r.requested).toBe(4096);
  });

  test("request above trained maximum clamps with a notice", () => {
    const r = resolveContextSize({ default: 1_000_000 }, "m.gguf", 32768);
    expect(r.requested).toBe(1_000_000);
    expect(r.effective).toBe(32768);
    expect(r.clamp).toBe("model-maximum");
  });

  test("unknown trainCtx does not clamp", () => {
    const r = resolveContextSize({ default: 1_000_000 }, "m.gguf", null);
    expect(r.effective).toBe(1_000_000);
    expect(r.clamp).toBeNull();
  });

  test("model trained below 4096 still reports the smaller effective", () => {
    const r = resolveContextSize(undefined, "tiny.gguf", 2048);
    expect(r.effective).toBe(2048);
    expect(r.clamp).toBe("model-maximum");
  });
});

describe("isValidContextSize / sanitizeContextSettings", () => {
  test("accepts the documented range only", () => {
    expect(isValidContextSize(512)).toBe(true);
    expect(isValidContextSize(1_048_576)).toBe(true);
    expect(isValidContextSize(511)).toBe(false);
    expect(isValidContextSize(1_048_577)).toBe(false);
    expect(isValidContextSize(4096.5)).toBe(false);
    expect(isValidContextSize("4096")).toBe(false);
    expect(isValidContextSize(null)).toBe(false);
  });

  test("drops invalid persisted values, keeps valid ones", () => {
    const s = sanitizeContextSettings({
      default: 70000,
      perModel: { ok: 8192, bad: -1, junk: "x" },
      extra: "ignored",
    });
    expect(s).toEqual({ default: 70000, perModel: { ok: 8192 } });
  });

  test("all-invalid → undefined", () => {
    expect(sanitizeContextSettings({ default: 0, perModel: { a: "x" } })).toBeUndefined();
    expect(sanitizeContextSettings("nope")).toBeUndefined();
    expect(sanitizeContextSettings(null)).toBeUndefined();
  });
});
