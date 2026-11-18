// issue #49: a persisted failed assistant turn must offer Retry — the
// transient-error banner only covers the live error path.
import { describe, expect, test } from "bun:test";
import { canRegenerateMessage } from "../../src/renderer/src/features/chat/message-rules";
import type { Message } from "../../src/shared/types";

const msg = (role: Message["role"], status: Message["status"]): Message =>
  ({
    id: "m1",
    conversationId: "c1",
    role,
    status,
    content: "x",
    createdAt: "2026-11-17T00:00:00Z",
    completedAt: null,
  }) as Message;

describe("canRegenerateMessage", () => {
  test("complete and partial last assistant messages regenerate", () => {
    expect(canRegenerateMessage(msg("assistant", "complete"), true)).toBe(true);
    expect(canRegenerateMessage(msg("assistant", "partial"), true)).toBe(true);
  });

  test("failed last assistant message offers Retry (issue #49)", () => {
    expect(canRegenerateMessage(msg("assistant", "failed"), true)).toBe(true);
  });

  test("non-last assistant never regenerates", () => {
    expect(canRegenerateMessage(msg("assistant", "failed"), false)).toBe(false);
    expect(canRegenerateMessage(msg("assistant", "complete"), false)).toBe(false);
  });

  test("user messages and in-flight turns never regenerate", () => {
    expect(canRegenerateMessage(msg("user", "complete"), true)).toBe(false);
    expect(canRegenerateMessage(msg("assistant", "generating"), true)).toBe(false);
  });
});
