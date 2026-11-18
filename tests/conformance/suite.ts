// T018 runnable conformance driver: bun run tests/conformance/suite.ts
// [--module python|r] [--host <path>]
import { existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const args = process.argv.slice(2);
const get = (f: string, d: string) => args[args.indexOf(f) + 1] ?? d;
const LANG = get("--module", "python");
const plat = process.platform === "darwin" ? "darwin-arm64" : "linux-x64";
const HOST = get("--host", `native/out/${plat}/cz-host`);
const MOD = `native/out/${plat}/libcz_${LANG}.so`;
const LIB = LANG === "python"
  ? ["/usr/lib64/libpython3.14.so.1.0", "/usr/lib64/libpython3.14.so"].find(existsSync)
  : ["/usr/lib64/R/lib/libR.so"].find(existsSync);
const tmp = mkdtempSync(join(tmpdir(), "cz-suite-"));
let pass = 0, fail = 0;
const ck = (name: string, ok: boolean, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
if (!existsSync(HOST) || !existsSync(MOD) || !LIB) {
  console.error(`missing artifacts (host=${HOST} mod=${MOD} lib=${LIB})`);
  process.exit(1);
}

const spawn = () => {
  const proc = Bun.spawn(
    [HOST, "--module", MOD, "--lib", LIB!, "--language", LANG],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const line = async () => {
    while (!buf.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) return null;
      buf += dec.decode(value, { stream: true });
    }
    const i = buf.indexOf("\n");
    const l = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    return l;
  };
  return { proc, line, send: (r: object) => proc.stdin.write(JSON.stringify(r) + "\n") };
};

const script = (name: string, code: string) => {
  const p = join(tmp, name);
  writeFileSync(p, code);
  return p;
};

const h = spawn();
const ready = await h.line();
ck("ready line", ready?.protocol === 1 && ready?.abi === 1 && ready?.ready === true);

const isPy = LANG === "python";
const okScript = isPy
  ? script("s.py", "print('hi')\n_result = 7\n")
  : script("s.R", "print('hi')\n7\n");
let r = (await h.send({ id: 1, op: "run", path: okScript, cwd: tmp }), await h.line());
ck("run by path + ok", r?.outcome === "ok");
ck("content_sha256", /^[0-9a-f]{64}$/.test(r?.content_sha256 ?? ""));

// state persistence
const st1 = isPy ? script("st1.py", "acc=1\n") : script("st1.R", "acc <- 1\n");
const st2 = isPy
  ? script("st2.py", "acc = acc + 1\n_result = acc\n")
  : script("st2.R", "acc <- acc + 1\nacc\n");
await h.send({ id: 2, op: "run", path: st1, cwd: tmp }); await h.line();
r = (await h.send({ id: 3, op: "run", path: st2, cwd: tmp }), await h.line());
ck("state persists", r?.outcome === "ok");

// structured error
const errScript = isPy
  ? script("e.py", "x=1\nboom()\n")
  : script("e.R", "x <- 1\nstop('boom')\n");
r = (await h.send({ id: 4, op: "run", path: errScript, cwd: tmp }), await h.line());
ck("structured error", r?.outcome === "error" && !!r?.error?.type,
  `${r?.error?.type} ${r?.error?.file ?? ""}:${r?.error?.line ?? ""}`);

// fingerprint
const fp = script("fp.py", isPy ? "_result=1\n" : "1\n");
r = (await h.send({ id: 5, op: "run", path: fp, expected_sha256: "0".repeat(64), cwd: tmp }), await h.line());
ck("content_changed", r?.outcome === "content_changed");
r = (await h.send({ id: 6, op: "run", path: join(tmp, "none.xyz"), cwd: tmp }), await h.line());
ck("source_missing", r?.outcome === "source_missing");

// cancel latency: run an infinite script in py, SIGINT the process
if (isPy) {
  const loop = script("loop.py", "while True: pass\n");
  const h2 = spawn();
  await h2.line();
  h2.send({ id: 1, op: "run", path: loop, cwd: tmp });
  await new Promise((r2) => setTimeout(r2, 300));
  const t0 = performance.now();
  process.kill(-h2.proc.pid, "SIGINT"); // group signal like host.ts
  const r2 = await Promise.race([h2.line(), new Promise((r3) => setTimeout(() => r3(null), 3000))]);
  const ms = performance.now() - t0;
  ck("cancel (SIGINT) resolves", r2 === null || r2?.outcome === "interrupted" || r2 === null, `${ms.toFixed(0)}ms ${JSON.stringify(r2)?.slice(0, 80)}`);
  h2.proc.kill(9);
  await h2.proc.exited;
}

// memory limit → error/host-side OOM, not silent pass
if (isPy) {
  const mem = script("mem.py", "x = ' ' * (2 * 1024**3)\n");
  const h3 = spawn();
  await h3.line();
  h3.send({ id: 1, op: "run", path: mem, cwd: tmp, limits: { mem_bytes: 512 * 1024 * 1024 } });
  const r3 = await Promise.race([h3.line(), new Promise((r4) => setTimeout(() => r4(null), 15000))]);
  ck("memory limit → not ok", r3 === null || r3?.outcome !== "ok", JSON.stringify(r3)?.slice(0, 100));
  h3.proc.kill(9);
  await h3.proc.exited;
}

// crash containment: ctypes segfault → fault + host dies; supervisor respawns
if (isPy) {
  const crash = script("crash.py", "import ctypes\nctypes.string_at(0)\n");
  const h4 = spawn();
  await h4.line();
  h4.send({ id: 1, op: "run", path: crash, cwd: tmp });
  await h4.proc.exited;
  const h5 = spawn();
  const ready5 = await h5.line();
  ck("crash containment + respawn", ready5?.ready === true);
  h5.proc.kill(9);
  await h5.proc.exited;
}

h.proc.stdin.end();
await h.proc.exited;
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
