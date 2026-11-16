// stage-native.ts <buildDir> <outDir>
// Copies the shim and its runtime deps from the CMake build tree into the
// flat staging dir that electrobun.config.ts maps into app resources.
// feature 029: GPU-class backend libs (vulkan/metal/opencl) go into a
// gpu/ SUBDIRECTORY — the flat dir is scanned unconditionally by
// lls_backend_init and must stay CPU-only so a broken GPU driver can't
// be dlopen'd on the CPU path. lls_probe stages at the out root.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const [buildDir, outDir] = process.argv.slice(2);
if (!buildDir || !outDir) {
  console.error("usage: bun scripts/stage-native.ts <buildDir> <outDir>");
  process.exit(1);
}

const gpuPattern = /ggml-(vulkan|metal|opencl|sycl|cuda|hip|rpc)[^/\\]*\.(so|dylib|dll)/i;
const probePattern = /^lls_probe(\.exe)?$/;

const patterns = [
  /^libllama_shim\.(so|dylib|dll)$/,
  /^llama_shim\.dll$/,
  /^libllama\.(so|dylib|dll)(?:\..*)?$/,
  /^llama\.dll$/,
  /^libggml[^/\\]*\.(so|dylib|dll)(?:\..*)?$/,
  /^ggml[^/\\]*\.dll$/,
];

function scan(dir: string): string[] {
  let found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // skip cmake internals and test trees
      if (!/CMakeFiles|Testing|examples|tools|tests|_deps/i.test(entry.name)) {
        found = found.concat(scan(full));
      }
    } else if (
      patterns.some((re) => re.test(entry.name)) ||
      gpuPattern.test(entry.name) ||
      probePattern.test(entry.name)
    ) {
      found.push(full);
    }
  }
  return found;
}

mkdirSync(outDir, { recursive: true });
const files = scan(buildDir);
if (files.length === 0) {
  console.error(`no native artifacts found under ${buildDir}`);
  process.exit(1);
}
let staged = 0;
for (const f of files) {
  const base = f.split("/").pop()!;
  const dest = gpuPattern.test(base)
    ? join(outDir, "gpu", base)
    : join(outDir, base);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(f, dest);
  console.log(`  ${dest}`);
  staged++;
}
console.log(`staged ${staged} artifacts`);
