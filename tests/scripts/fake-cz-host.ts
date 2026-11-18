// T008: protocol-v1 fake cz-host — NDJSON on stdin/stdout.
// Env: FAKE_LANG (ready-line language), FAKE_ABI (abi number),
// FAKE_DIE ("1" = exit 9 on first run), FAKE_HANG ("1" = never reply).
const lang = process.env.FAKE_LANG ?? "python";
const abi = Number(process.env.FAKE_ABI ?? "1");
process.stdout.write(
  JSON.stringify({ protocol: 1, abi, language: lang, ready: true }) + "\n",
);
let n = 0;
const dec = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  for (const line of dec.decode(chunk, { stream: true }).split("\n")) {
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (process.env.FAKE_DIE === "1" && n++ === 0) process.exit(9);
    if (process.env.FAKE_HANG === "1") continue;
    process.stdout.write(
      JSON.stringify({
        id: req.id,
        outcome: req.path?.includes("missing") ? "source_missing" : "ok",
        value: "42",
        stdout: `ran:${req.path}`,
        stderr: "",
        files: [],
        content_sha256: "abc123",
        duration_ms: 1,
      }) + "\n",
    );
  }
}
