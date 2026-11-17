// feature 030 (T019): pre-send oversize check — a single message whose
// tokens + reserve exceed the effective context returns the typed
// "message_exceeds_context" union and stores nothing; force:true bypasses.
// A settings.context change mid-response succeeds and applies at next load.
import { describe, expect, test } from "bun:test";
import {
  createRequestHandlers,
  type EngineLike,
  type HandlerDeps,
  type StoreLike,
} from "../src/bun/rpc/handlers";
import type { Conversation, Settings } from "../src/shared/types";
import { DEFAULT_GENERATION } from "../src/shared/types";

function makeDeps(opts: { ctxSize?: number; generating?: boolean } = {}) {
  const emitted: { method: string; payload: unknown }[] = [];
  const convs = new Map<string, Conversation>();
  const settings: Settings = {
    activeModelPath: null,
    contextLimitWarning: false,
    generation: DEFAULT_GENERATION,
    modelOverrides: {},
    outputPanel: false,
    tags: [],
  };
  const engine: EngineLike = {
    status: () => ({ status: "ready", name: "fake.gguf" }),
    loadModel: async () => ({ status: "ready" as const, name: "fake.gguf" }),
    unloadModel: () => {},
    isGenerating: () => opts.generating ?? false,
    contextSize: () => opts.ctxSize ?? 4096,
    chatTemplate: () => null,
    tokenCount: (t: string) => Math.ceil(t.length / 4),
    stop: () => {},
    generate: async (_p, onToken) => {
      onToken("ok");
      return { status: "complete", tokens: 1, elapsedMs: 1, warm: false };
    },
  };
  const store: StoreLike = {
    getConversation: (id) => convs.get(id) ?? null,
    saveConversation: (c) => void convs.set(c.id, c),
    listConversations: () =>
      [...convs.values()].map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
      })),
    deleteConversation: (id) => convs.delete(id),
    getSettings: () => settings,
    saveSettings: (n) => Object.assign(settings, n),
  };
  const deps: HandlerDeps = {
    engine,
    store,
    emit: (m, p) => emitted.push({ method: m, payload: p }),
  };
  const h = createRequestHandlers(deps);
  return { h, convs, emitted, settings };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe("chat.send oversize preflight", () => {
  test("message exceeding effective context returns typed error", async () => {
    const { h, convs, emitted } = makeDeps({ ctxSize: 128 });
    const res = await h["chat.send"]({
      conversationId: "c1",
      content: "x".repeat(600), // ~150 tok + 64 reserve > 128
    });
    expect(res).toMatchObject({ error: "message_exceeds_context" });
    if ("error" in res) {
      expect(res.effective).toBe(128);
      expect(res.neededTokens).toBeGreaterThan(128);
    }
    // nothing was stored, nothing generated
    expect(convs.get("c1")?.messages ?? []).toHaveLength(0);
    expect(emitted.some((e) => e.method === "chat.token")).toBe(false);
  });

  test("message just under the limit is accepted", async () => {
    const { h } = makeDeps({ ctxSize: 128 });
    const res = await h["chat.send"]({
      conversationId: "c1",
      content: "x".repeat(250), // ~63 tok + 64 reserve = 127 <= 128
    });
    expect(res).toHaveProperty("messageId");
    await flush();
  });

  test("force:true bypasses the check", async () => {
    const { h } = makeDeps({ ctxSize: 128 });
    const res = await h["chat.send"]({
      conversationId: "c1",
      content: "x".repeat(600),
      force: true,
    });
    expect(res).toHaveProperty("messageId");
    await flush();
  });

  test("context change while generating applies next load, not mid-turn", async () => {
    const { h, settings } = makeDeps({ generating: true });
    // a settings.set during an active turn is allowed — it never aborts
    // or mutates the in-flight context
    await h["settings.set"]({ context: { default: 8192 } });
    expect(settings.context?.default).toBe(8192);
  });
});
