// Synthetic long-text generator for context-size tests (spec 030 T002).
// Deterministic: same input → same output. The first line marks the text
// as synthetic so a generated document can never be mistaken for real data.
const WORDS =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua".split(
    " ",
  );

// ~4 chars per token is the chars/4 estimate engine.tokenCount() falls
// back to, so `approxTokens` is only approximate by design.
export function longText(approxTokens: number): string {
  const targetChars = approxTokens * 4;
  const parts: string[] = [`SYNTHETIC long-text fixture (~${approxTokens} tokens)`];
  let i = 0;
  while (parts.join("\n").length < targetChars) {
    const words: string[] = [];
    for (let w = 0; w < 12; w++) words.push(WORDS[(i + w) % WORDS.length]);
    parts.push(`P${Math.floor(i / 12)} ${words.join(" ")}.`);
    i += 12;
  }
  return parts.join("\n");
}
