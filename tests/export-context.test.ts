// feature 030 (T025): settings.context round-trips through the export
// envelope; invalid values are dropped on import (sanitize).
import { describe, expect, test } from "bun:test";
import { toExportedSettings } from "../src/bun/export/exporter";
import { toSettings } from "../src/bun/export/importer";
import type { ExportedSettings } from "../src/shared/export";
import type { Settings } from "../src/shared/types";
import { DEFAULT_GENERATION } from "../src/shared/types";

const base: Settings = {
  activeModelPath: null,
  contextLimitWarning: false,
  generation: DEFAULT_GENERATION,
  modelOverrides: {},
  outputPanel: false,
  tags: [],
};

describe("export/import context settings", () => {
  test("context settings round-trip", () => {
    const s: Settings = {
      ...base,
      context: { default: 8192, perModel: { "a.gguf": 16384 } },
    };
    const exported = toExportedSettings(s);
    expect(exported.context?.default).toBe(8192);
    const imported = toSettings(exported, s.tags, "/tmp/models", []);
    expect(imported.context).toEqual(s.context);
  });

  test("absent context (older export) imports as undefined", () => {
    const exported: ExportedSettings = {
      generation: DEFAULT_GENERATION,
      modelOverrides: {},
      contextLimitWarning: false,
      activeModel: null,
    };
    const imported = toSettings(exported, [], "/tmp/models", []);
    expect(imported.context).toBeUndefined();
  });

  test("invalid context values are dropped on import", () => {
    const exported: ExportedSettings = {
      generation: DEFAULT_GENERATION,
      modelOverrides: {},
      contextLimitWarning: false,
      activeModel: null,
      context: {
        default: -5,
        perModel: { "a.gguf": 8192, "b.gguf": 0 },
      } as never,
    };
    const imported = toSettings(exported, [], "/tmp/models", []);
    expect(imported.context).toEqual({ perModel: { "a.gguf": 8192 } });
  });
});
