// T018: conformance suite for the real cz-host + libcz_python / libcz_r
// artifacts in native/build|out. Skips cleanly when artifacts or
// interpreters are absent (CI/dev boxes without cmake or libpython).
import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nativeDirs } from "../../src/bun/llama/ffi";

const dirs = nativeDirs();
const HOST = dirs.map((d) => join(d, "cz-host")).find(existsSync) ?? null;
const PYMOD = dirs.map((d) => join(d, "libcz_python.so")).find(existsSync);
const RMOD = dirs.map((d) => join(d, "libcz_r.so")).find(existsSync);
const PYLIB = ["/usr/lib64/libpython3.14.so.1.0", "/usr/lib64/libpython3.14.so"]
  .find(existsSync);
const RLIB = ["/usr/lib64/R/lib/libR.so"].find(existsSync);
const PYBIN = Bun.which("python3.14") ?? Bun.which("python3");

const tmp = mkdtempSync(join(tmpdir(), "cz-conf-"));

function run(
  mod: string,
  lib: string,
  lang: string,
  requests: object[],
): Promise<{ code: number; lines: any[]; stderr: string }> {
  const args = [HOST!, "--module", mod, "--lib", lib, "--language", lang];
  const proc = Bun.spawn(args, {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const payload = requests.map((r) => JSON.stringify(r)).join("\n") + "\n";
  proc.stdin.write(payload);
  proc.stdin.end();
  return Promise.all([
    proc.exited,
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]).then(([code, out, stderr]) => ({
    code,
    lines: out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    stderr,
  }));
}

const py = (path: string, code: string) => {
  const p = join(tmp, path);
  writeFileSync(p, code);
  return p;
};

const canPy = HOST && PYMOD && PYLIB && PYBIN;
const canR = HOST && RMOD && RLIB;

describe("conformance: cz-host + libcz_python", () => {
  beforeAll(() => { if (!canPy) console.log("skipped — no host/python artifacts"); });
  const ready = (lines: any[]) => lines[0];
  const resp = (lines: any[]) => lines[1];

  test("ready line + run by path + result shape", async () => {
    if (!canPy) return;
    const script = py("c1.py", "print('hi')\n_result = 7\n");
    const { lines } = await run(PYMOD!, PYLIB!, "python", [
      { id: 1, op: "run", path: script, cwd: tmp },
    ]);
    expect(ready(lines)).toMatchObject({ protocol: 1, abi: 1, language: "python", ready: true });
    expect(resp(lines)).toMatchObject({ id: 1, outcome: "ok", value: "7" });
    expect(resp(lines).content_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("session state persists across calls", async () => {
    if (!canPy) return;
    const s1 = py("c2.py", "acc = 1\n");
    const s2 = py("c3.py", "acc = acc + 1\n_result = acc\n");
    const { lines } = await run(PYMOD!, PYLIB!, "python", [
      { id: 1, op: "run", path: s1, cwd: tmp },
      { id: 2, op: "run", path: s2, cwd: tmp },
    ]);
    expect(lines[2].value).toBe("2");
  });

  test("sibling import + __file__ (venv-style module dir)", async () => {
    if (!canPy) return;
    py("helper_mod.py", "def double(x): return x*2\n");
    const script = py("c4.py", "import os, helper_mod\nassert os.path.isfile(__file__)\n_result = helper_mod.double(4)\n");
    const { lines } = await run(PYMOD!, PYLIB!, "python", [
      { id: 1, op: "run", path: script, cwd: tmp },
    ]);
    expect(resp(lines).outcome).toBe("ok");
    expect(resp(lines).value).toBe("8");
  });

  test("fingerprint: content_changed blocks execution", async () => {
    if (!canPy) return;
    const script = py("c5.py", "_result = open('/tmp/cz-ran','w').write('x')\n");
    const { lines } = await run(PYMOD!, PYLIB!, "python", [
      { id: 1, op: "run", path: script, expected_sha256: "0".repeat(64), cwd: tmp },
    ]);
    expect(resp(lines).outcome).toBe("content_changed");
    expect(existsSync("/tmp/cz-ran")).toBe(false);
  });

  test("source_missing for absent path", async () => {
    if (!canPy) return;
    const { lines } = await run(PYMOD!, PYLIB!, "python", [
      { id: 1, op: "run", path: join(tmp, "nope.py"), cwd: tmp },
    ]);
    expect(resp(lines).outcome).toBe("source_missing");
  });

  test("structured error: type/file/line", async () => {
    if (!canPy) return;
    const script = py("c6.py", "x = 1\nboom()\n");
    const { lines } = await run(PYMOD!, PYLIB!, "python", [
      { id: 1, op: "run", path: script, cwd: tmp },
    ]);
    const r = resp(lines);
    expect(r.outcome).toBe("error");
    expect(r.error.type).toBe("NameError");
    expect(r.error.file).toBe(script);
    expect(r.error.line).toBe(2);
  });

  test("new files in cwd are reported", async () => {
    if (!canPy) return;
    const d = mkdtempSync(join(tmpdir(), "cz-files-"));
    const script = py("c7.py", "open('made.txt','w').write('y')\n");
    const { lines } = await run(PYMOD!, PYLIB!, "python", [
      { id: 1, op: "run", path: script, cwd: d },
    ]);
    expect(resp(lines).files).toContain("made.txt");
  });
});

describe("conformance: cz-host + libcz_r", () => {
  test("run + error + missing", async () => {
    if (!canR) return;
    const ok = py("r1.R", "40 + 2\n");
    const bad = py("r2.R", "stop('nope')\n");
    const { lines } = await run(RMOD!, RLIB!, "r", [
      { id: 1, op: "run", path: ok, cwd: tmp },
      { id: 2, op: "run", path: bad, cwd: tmp },
      { id: 3, op: "run", path: join(tmp, "no.R"), cwd: tmp },
    ]);
    expect(lines[0].language).toBe("r");
    expect(lines[1].outcome).toBe("ok");
    expect(lines[2].outcome).toBe("error");
    expect(lines[3].outcome).toBe("source_missing");
  });
});

describe("conformance: broken module", () => {
  test("unloadable module → nonzero exit + diagnostic", async () => {
    if (!HOST) return;
    const { code, stderr } = await run("/tmp/does-not-exist.so", "x", "python", []);
    expect(code).not.toBe(0);
    expect(stderr).toContain("dlopen");
  });
});
