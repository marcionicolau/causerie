// feature 023: interpreter resolution (FR-002/FR-003). User-configured
// paths take precedence over auto-detection; missing interpreters
// report status "missing" — never throw.
import { existsSync } from "node:fs";
import type {
  RuntimeStatus,
  ScriptPolicy,
  ScriptRuntimeKind,
} from "../../shared/types";

const CANDIDATES: Record<ScriptRuntimeKind, readonly string[]> = {
  python: ["python3", "python"],
  r: ["Rscript"],
};

const FALLBACK_PATHS: Record<ScriptRuntimeKind, readonly string[]> = {
  python: [
    "/usr/bin/python3",
    "/usr/local/bin/python3",
    "/opt/homebrew/bin/python3",
    "/opt/homebrew/bin/python",
  ],
  r: ["/usr/bin/Rscript", "/usr/local/bin/Rscript"],
};

// first resolvable interpreter on PATH-ish locations; null when absent
export function detectInterpreter(kind: ScriptRuntimeKind): string | null {
  for (const c of CANDIDATES[kind]) {
    const p = Bun.which(c);
    if (p) return p;
  }
  for (const f of FALLBACK_PATHS[kind]) {
    if (existsSync(f)) return f;
  }
  return null;
}

// configured path wins when set and present; else detection
export function resolveInterpreter(
  kind: ScriptRuntimeKind,
  policy?: ScriptPolicy,
): { path: string | null; configured: string | null; detected: string | null } {
  const configured = policy?.runtimes?.[kind]?.path ?? null;
  const detected = detectInterpreter(kind);
  const path =
    configured && existsSync(configured) ? configured : detected;
  return { path, configured, detected };
}

// ---------- feature 028 (T015): host-mode runtime probe ----------
// One probe per interpreter path — the shared runtime lib (libpython≥3.14
// / libR) is what the embedded module dlopens. hostUsable=false carries a
// machine-readable reason ("python-3.11", "no-libpython", "no-libR").

export interface HostProbe {
  usable: boolean;
  libPath: string | null;
  reason?: string;
}

const probeCache = new Map<string, HostProbe>();

function probePythonLib(interpreter: string): HostProbe {
  const probe = Bun.spawnSync({
    cmd: [
      interpreter,
      "-c",
      "import sysconfig,sys,json;" +
        "print(json.dumps({'lib':sysconfig.get_config_var('LIBDIR')," +
        "'so':sysconfig.get_config_var('INSTSONAME')," +
        "'ver':list(sys.version_info[:2])}))",
    ],
    stdout: "pipe",
    stderr: "ignore",
  });
  if (probe.exitCode !== 0) return { usable: false, libPath: null, reason: "probe-failed" };
  try {
    const info = JSON.parse(new TextDecoder().decode(probe.stdout).trim()) as {
      lib?: string; so?: string; ver?: number[];
    };
    const maj = info.ver?.[0] ?? 0;
    const min = info.ver?.[1] ?? 0;
    if (maj < 3 || (maj === 3 && min < 14)) {
      return { usable: false, libPath: null, reason: `python-${maj}.${min}` };
    }
    const libPath = info.lib && info.so ? `${info.lib}/${info.so}` : null;
    if (!libPath || !existsSync(libPath)) {
      return { usable: false, libPath: null, reason: "no-libpython" };
    }
    return { usable: true, libPath };
  } catch {
    return { usable: false, libPath: null, reason: "probe-failed" };
  }
}

function probeRLib(): HostProbe {
  const script = Bun.which("Rscript");
  if (!script) return { usable: false, libPath: null, reason: "no-rscript" };
  const probe = Bun.spawnSync({
    cmd: [script, "-e", "cat(file.path(R.home('lib'),'libR.so'))"],
    stdout: "pipe",
    stderr: "ignore",
  });
  const libPath = new TextDecoder().decode(probe.stdout).trim();
  if (probe.exitCode !== 0 || !existsSync(libPath)) {
    return { usable: false, libPath: null, reason: "no-libR" };
  }
  return { usable: true, libPath };
}

export function probeHostRuntime(
  kind: ScriptRuntimeKind,
  interpreterPath: string,
): HostProbe {
  const key = `${kind}:${interpreterPath}`;
  let p = probeCache.get(key);
  if (!p) {
    p = kind === "python" ? probePythonLib(interpreterPath) : probeRLib();
    probeCache.set(key, p);
  }
  return p;
}

export function runtimeStatus(
  kind: ScriptRuntimeKind,
  policy?: ScriptPolicy,
  session?: RuntimeStatus["session"],
): RuntimeStatus {
  const r = resolveInterpreter(kind, policy);
  return {
    kind,
    configuredPath: r.configured,
    detectedPath: r.detected,
    status: r.path ? "ready" : "missing",
    session: session ?? null,
  };
}
