// feature 028 (T012): cz-host backend — one isolated host process per
// runtime, NDJSON protocol v1 over pipes (contracts/protocol.md).
// The host dlopens the language module (libcz_python/libcz_r); script
// faults kill only the host, never the app (SC-002/FR-010).
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ScriptRuntimeKind, SessionInfo } from "../../../shared/types";
import type {
  ScriptBackend,
  ScriptCallRequest,
  ScriptCallResult,
} from "../backend";
import { BackendUnavailable } from "../backend";
import { nativeDirs } from "../../llama/ffi";
import { scriptRunsDir } from "../../store/paths";

const ABI_VERSION = 1;
const READY_TIMEOUT_MS = 10_000;
const CANCEL_GRACE_MS = 2_000;

const MODULES: Record<ScriptRuntimeKind, { file: string; language: string }> = {
  python: { file: "libcz_python.so", language: "python" },
  r: { file: "libcz_r.so", language: "r" },
};

function hostBin(): string | null {
  for (const d of nativeDirs()) {
    const p = join(d, "cz-host");
    if (existsSync(p)) return p;
  }
  return null;
}

function modulePath(rt: ScriptRuntimeKind): string | null {
  for (const d of nativeDirs()) {
    const p = join(d, MODULES[rt].file);
    if (existsSync(p)) return p;
  }
  return null;
}

// T015 probe seam — libpython/libR resolution for the --lib flag; the
// runtimes.ts probe feeds this from sysconfig (None → host unavailable)
export interface HostDeps {
  libPath?: (rt: ScriptRuntimeKind, interpreterPath: string) => string | null;
}

interface Waiter {
  resolve: (r: HostResponse) => void;
  reject: (e: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  killTiers?: ReturnType<typeof setTimeout>[];
}

interface HostResponse {
  id: string;
  outcome?: string;
  value?: string | null;
  error?: {
    type?: string;
    message?: string;
    traceback?: string;
    file?: string;
    line?: number;
  } | null;
  stdout?: string;
  stderr?: string;
  files?: string[];
  truncated?: boolean;
  content_sha256?: string;
  duration_ms?: number;
}

interface Session {
  proc: Bun.Subprocess;
  buf: string;
  waiters: Map<string, Waiter>;
  stderrTail: string;
  dead: Promise<unknown>;
}

export class HostBackend implements ScriptBackend {
  readonly kind = "host" as const;
  private sessions = new Map<ScriptRuntimeKind, Session>();
  private info = new Map<ScriptRuntimeKind, SessionInfo>();
  private seq = 0;

  constructor(private deps: HostDeps = {}) {}

  private setInfo(rt: ScriptRuntimeKind, patch: Partial<SessionInfo>): void {
    const cur = this.info.get(rt) ?? {
      state: "cold" as const,
      calls: 0,
      restartCount: 0,
    };
    this.info.set(rt, { ...cur, ...patch });
  }

  status(rt: ScriptRuntimeKind): SessionInfo | null {
    return this.info.get(rt) ?? null;
  }

  private pump(session: Session): void {
    const proc = session.proc;
    (async () => {
      const dec = new TextDecoder();
      try {
        for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
          session.buf += dec.decode(chunk, { stream: true });
          let idx: number;
          while ((idx = session.buf.indexOf("\n")) >= 0) {
            const line = session.buf.slice(0, idx);
            session.buf = session.buf.slice(idx + 1);
            if (!line.trim()) continue;
            let resp: HostResponse;
            try {
              resp = JSON.parse(line) as HostResponse;
            } catch {
              continue; // stray module output — diagnostics, not protocol
            }
            const w = session.waiters.get(
              (resp as { ready?: boolean }).ready === true
                ? "__ready__"
                : resp.id,
            );
            if (w) {
              session.waiters.delete(resp.id);
              w.killTiers?.forEach(clearTimeout);
              clearTimeout(w.timeout);
              w.resolve(resp);
            }
          }
        }
      } catch {
        /* stream ended */
      }
    })();
    (async () => {
      const dec = new TextDecoder();
      try {
        for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
          session.stderrTail =
            (session.stderrTail + dec.decode(chunk, { stream: true })).slice(
              -4000,
            );
        }
      } catch {
        /* stream ended */
      }
    })();
  }

  private drop(rt: ScriptRuntimeKind, s: Session): void {
    if (this.sessions.get(rt) === s) this.sessions.delete(rt);
    // outstanding call resolves as host_fault — never fatal to the app
    for (const [, w] of s.waiters) {
      w.killTiers?.forEach(clearTimeout);
      clearTimeout(w.timeout);
      w.resolve({
        id: "",
        outcome: "host_fault",
        stdout: "",
        stderr: s.stderrTail.trim(),
        files: [],
      });
    }
    s.waiters.clear();
    this.setInfo(rt, { state: "dead" });
  }

  private signalGroup(proc: Bun.Subprocess, sig: string): void {
    try {
      // cz-host calls setsid() at startup → its pgid == its pid; negative
      // pid signals the whole group (script child processes included)
      process.kill(-proc.pid, sig as NodeJS.Signals);
    } catch {
      try {
        proc.kill(sig === "SIGKILL" ? 9 : sig === "SIGTERM" ? 15 : 2);
      } catch {
        /* already gone */
      }
    }
  }

  async ensure(rt: ScriptRuntimeKind, interpreterPath: string): Promise<void> {
    const cur = this.sessions.get(rt);
    if (cur && cur.proc.exitCode === null) return;
    if (cur) this.drop(rt, cur);

    const bin = hostBin();
    const mod = modulePath(rt);
    if (!bin || !mod) {
      throw new BackendUnavailable(
        "runtime-unavailable",
        `cz-host/module missing (bin=${bin ?? "?"}, module=${mod ?? "?"})`,
      );
    }
    const lib = this.deps.libPath?.(rt, interpreterPath) ?? null;
    if (!lib) {
      throw new BackendUnavailable(
        "runtime-unavailable",
        `no shared runtime library for ${rt}`,
      );
    }

    this.setInfo(rt, { state: "starting" });
    const prev = this.info.get(rt)?.restartCount ?? 0;
    const proc = Bun.spawn(
      [bin, "--module", mod, "--interpreter", interpreterPath, "--lib", lib],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: scriptRunsDir(),
      },
    );
    const session: Session = {
      proc,
      buf: "",
      waiters: new Map(),
      stderrTail: "",
      dead: proc.exited.then(() => this.drop(rt, session)),
    };
    session.dead.catch(() => {});
    this.sessions.set(rt, session);
    this.pump(session);

    // ready-line handshake (protocol.md): protocol+abi+language gate
    const ready = new Promise<HostResponse>((resolve) => {
      session.waiters.set("__ready__", {
        resolve,
        reject: () => {},
        timeout: setTimeout(() => {
          session.waiters.delete("__ready__");
          resolve({ id: "__ready__" });
        }, READY_TIMEOUT_MS),
      });
    });
    const line = await ready;
    if (session.proc.exitCode !== null) {
      throw new BackendUnavailable(
        "runtime-unavailable",
        `host-start-failed: ${session.stderrTail.trim() || "exited"}`,
      );
    }
    if (
      (line as { protocol?: number }).protocol !== 1 ||
      (line as { abi?: number }).abi !== ABI_VERSION ||
      (line as { language?: string }).language !== MODULES[rt].language ||
      (line as { ready?: boolean }).ready !== true
    ) {
      this.killSession(session);
      throw new BackendUnavailable(
        "runtime-unavailable",
        `version-mismatch: ${JSON.stringify(line).slice(0, 120)}`,
      );
    }
    this.setInfo(rt, {
      state: "live",
      restartCount: cur || prev > 0 ? prev + 1 : prev,
    });
  }

  private killSession(s: Session): void {
    try {
      s.proc.kill(9);
    } catch {
      /* already gone */
    }
  }

  async call(
    rt: ScriptRuntimeKind,
    req: ScriptCallRequest,
  ): Promise<ScriptCallResult> {
    const session = this.sessions.get(rt);
    if (!session || session.proc.exitCode !== null) {
      throw new BackendUnavailable(
        "session-dead",
        "script host session is not running",
      );
    }
    const id = `run-${++this.seq}`;
    const started = performance.now();
    const line =
      JSON.stringify({
        id,
        protocol: 1,
        op: "run",
        path: req.path,
        args: req.args,
        input: req.input ?? null,
        cwd: req.cwd,
        expected_sha256: req.expectedFingerprint ?? null,
        limits: {
          mem_bytes: req.limits?.memBytes ?? 0,
          output_bytes: req.limits?.outputBytes ?? 0,
        },
      }) + "\n";

    let timedOut = false;
    const respP = new Promise<HostResponse>((resolve, reject) => {
      const killTiers: ReturnType<typeof setTimeout>[] = [];
      const w: Waiter = {
        resolve,
        reject,
        killTiers,
        timeout: setTimeout(() => {
          timedOut = true;
          // cancel = signal, not a line: SIGINT → grace → group TERM → KILL
          this.signalGroup(session.proc, "SIGINT");
          killTiers.push(
            setTimeout(
              () => this.signalGroup(session.proc, "SIGTERM"),
              CANCEL_GRACE_MS,
            ),
            setTimeout(
              () => this.signalGroup(session.proc, "SIGKILL"),
              CANCEL_GRACE_MS * 2,
            ),
          );
        }, req.timeoutMs),
      };
      session.waiters.set(id, w);
    });
    const stdin = session.proc.stdin;
    if (!stdin || typeof stdin === "number") {
      session.waiters.delete(id);
      throw new BackendUnavailable(
        "session-dead",
        "script host stdin is not a pipe",
      );
    }
    stdin.write(line);
    stdin.flush();

    const resp = await respP;
    const durationMs = performance.now() - started;
    const info = this.info.get(rt);
    if (info) this.setInfo(rt, { calls: info.calls + 1 });

    const outcome = timedOut && resp.outcome !== "host_fault"
      ? "timeout"
      : (resp.outcome ?? "host_fault");
    const stderr =
      (resp.stderr ?? "") +
      (resp.truncated ? "\n[output truncated]" : "");
    return {
      outcome: outcome as ScriptCallResult["outcome"],
      exitStatus: outcome === "ok" ? 0 : 1,
      stdout:
        (resp.stdout ?? "") +
        (resp.value ? `${resp.value}\n` : ""),
      stderr,
      durationMs: resp.duration_ms ?? durationMs,
      files: resp.files ?? [],
      sessionRestarted: false,
      contentSha256: resp.content_sha256,
      error: resp.error
        ? {
            type: resp.error.type ?? "Error",
            message: resp.error.message ?? "script failed",
            traceback: resp.error.traceback,
            file: resp.error.file,
            line: resp.error.line,
          }
        : undefined,
      method: "host",
    };
  }

  async reset(rt: ScriptRuntimeKind): Promise<void> {
    const s = this.sessions.get(rt);
    this.sessions.delete(rt);
    if (s) {
      this.signalGroup(s.proc, "SIGKILL");
      for (const [, w] of s.waiters) {
        w.killTiers?.forEach(clearTimeout);
        clearTimeout(w.timeout);
        w.resolve({
          id: "",
          outcome: "interrupted",
          stdout: "",
          stderr: "session reset",
          files: [],
        });
      }
      s.waiters.clear();
    }
    this.setInfo(rt, { state: "cold" });
  }

  async dispose(): Promise<void> {
    for (const rt of this.sessions.keys()) {
      await this.reset(rt);
    }
  }
}
