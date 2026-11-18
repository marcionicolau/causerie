import type { Message } from "@shared/types";

// issue #49: a failed last assistant message must offer Retry — the
// banner only covers transient errors; after reload/conversation switch
// the persisted "failed" status was the only place Retry could live.
export function canRegenerateMessage(m: Message, isLast: boolean): boolean {
  return (
    m.role === "assistant" &&
    isLast &&
    (m.status === "complete" ||
      m.status === "partial" ||
      m.status === "failed")
  );
}
