// SC-002 scratch benchmark: same model+prompt on gpu vs cpu path.
import { startProbe, awaitProbe } from "../src/bun/llama/gpu";
import { resolveNativeDir } from "../src/bun/llama/ffi";
import { LlamaEngine } from "../src/bun/llama/engine";
import { render } from "../src/bun/llama/prompt";

startProbe(resolveNativeDir()!);
await awaitProbe(2000);
const e = new LlamaEngine();
const model = process.argv[2] ?? "models/smollm2-1.7b-instruct-q4_k_m.gguf";
// instruct models EOS instantly on bare prompts — build the real ChatML
// turn so genuine decode happens on both paths
const prompt = render(
  [{ role: "user", content: "Explain photosynthesis in one short paragraph." }],
  true,
);

async function run(mode: "auto" | "cpu") {
  const r = await e.loadModel(model, { computeMode: mode });
  await e.generate(prompt, () => {}, null); // warmup
  const res = await e.generate(prompt, () => {}, null); // measured
  const tps = res.tokens / (res.elapsedMs / 1000);
  console.log(
    `RESULT ${mode}: compute=${JSON.stringify(r.compute)} ` +
      `tok=${res.tokens} ms=${res.elapsedMs.toFixed(0)} -> ${tps.toFixed(1)} tok/s`,
  );
  e.unloadModel();
}

await run("auto");
await run("cpu");
e.dispose();
