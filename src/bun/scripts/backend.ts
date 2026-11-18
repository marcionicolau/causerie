// feature 023: the ScriptBackend contract (contracts/backend.md).
// Two mechanisms satisfy it — subprocess session (Bun.spawn runner)
// and embedded FFI session (Worker + libpython/libR prototype).
// SessionManager is the only consumer; callers never see the impl.
import type {
  ScriptOutcome,
  ScriptRuntimeKind,
  SessionInfo,
} from "../../shared/types";

// feature 028 (T004): backends run the file at `path` and read the bytes
// themselves — contentSha256 always describes what actually executed.
export interface ScriptCallRequest {
  runId: string;
  path: string; // absolute script path — backend reads it
  expectedFingerprint?: string; // approved sha256; mismatch → content_changed
  args: Record<string, unknown>; // declared params → runtime variables
  input?: string; // raw text arg for paramless scripts
  cwd: string; // dataDir()/script-runs/<runId>/ — created by caller
  timeoutMs: number;
  limits?: { memBytes?: number; outputBytes?: number };
}

export interface ScriptCallError {
  type: string;
  message: string;
  traceback?: string;
  file?: string;
  line?: number;
}

export interface ScriptCallResult {
  outcome: ScriptOutcome;
  exitStatus: number | null; // null when the eval completed (no process exit)
  stdout: string;
  stderr: string;
  durationMs: number;
  files: string[]; // names produced inside cwd
  sessionRestarted: boolean; // session was (re)created for this call
  contentSha256?: string; // sha256 of the bytes actually run
  error?: ScriptCallError;
  method?: "host" | "subprocess"; // which mechanism ran it
  methodReason?: string; // fallback reason when not the pinned/first choice
}

export class BackendUnavailable extends Error {
  constructor(
    public readonly reason:
      | "runtime-unavailable"
      | "timeout"
      | "interrupted"
      | "session-dead",
    message: string,
    public readonly partial?: { stdout: string; stderr: string },
  ) {
    super(message);
    this.name = "BackendUnavailable";
  }
}

export interface ScriptBackend {
  readonly kind: "subprocess" | "host";
  // cold → live: start/attach the runtime session (idempotent).
  // interpreterPath is the resolved executable (runtimes.ts).
  ensure(rt: ScriptRuntimeKind, interpreterPath: string): Promise<void>;
  // serialized upstream by SessionManager — at most one outstanding
  // call per runtime reaches here. Timeout enforcement lives here.
  call(
    rt: ScriptRuntimeKind,
    req: ScriptCallRequest,
  ): Promise<ScriptCallResult>;
  // terminate the session; ensure() may start it again
  reset(rt: ScriptRuntimeKind): Promise<void>;
  status(rt: ScriptRuntimeKind): SessionInfo | null;
  // app shutdown — all sessions
  dispose(): Promise<void>;
}
