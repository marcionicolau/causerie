// feature 028 (T016): per-call backend selection + fallback.
// "auto" runs the native host when the interpreter probes usable, else the
// subprocess runner; a BackendUnavailable from the host retries subprocess
// once under FR-019. "host"/"subprocess" pin the backend — pinned host on
// an unusable interpreter is a clear error, never a silent fallback.
// Stored "embedded" migrates to "auto" (the embedded prototype is gone).
import type {
  ScriptPolicy,
  ScriptRuntimeKind,
  SessionInfo,
  SessionStateEvent,
} from "../../shared/types";
import type { ScriptCallRequest, ScriptCallResult } from "./backend";
import { BackendUnavailable } from "./backend";
import { SessionManager } from "./session";
import { SubprocessBackend } from "./backends/subprocess";
import { HostBackend } from "./backends/host";
import { probeHostRuntime } from "./runtimes";
import type { HostProbe } from "./runtimes";
import type { ScriptBackend } from "./backend";

export class RoutedSessions {
  private host: SessionManager;
  private sub: SessionManager;
  private notified = false;

  constructor(
    private deps: {
      getPolicy(): ScriptPolicy;
      emit(e: SessionStateEvent): void;
      notifyFallback(reason: string): void;
      // test seams — production defaults below
      probe?: (rt: ScriptRuntimeKind, interpreter: string) => HostProbe;
      makeHost?: () => ScriptBackend;
      makeSub?: () => ScriptBackend;
    },
  ) {
    const probe = deps.probe ?? probeHostRuntime;
    this.host = new SessionManager({
      backendFactory:
        deps.makeHost ??
        (() =>
          new HostBackend({
            libPath: (rt, interp) => probe(rt, interp).libPath,
          })),
      emit: (e) => deps.emit(e),
    });
    this.sub = new SessionManager({
      backendFactory: deps.makeSub ?? (() => new SubprocessBackend()),
      emit: (e) => deps.emit(e),
    });
  }

  private kind(): "host" | "subprocess" | "auto" {
    const k = this.deps.getPolicy().backend as string;
    return k === "host" || k === "subprocess" ? k : "auto"; // embedded → auto
  }

  status(rt: ScriptRuntimeKind): SessionInfo {
    const h = this.host.status(rt);
    if (h.state !== "cold") return h;
    return this.sub.status(rt);
  }

  async call(
    rt: ScriptRuntimeKind,
    interpreterPath: string,
    req: ScriptCallRequest,
  ): Promise<ScriptCallResult> {
    const kind = this.kind();
    const probe =
      kind === "subprocess"
        ? null
        : (this.deps.probe ?? probeHostRuntime)(rt, interpreterPath);

    if (kind === "host") {
      if (probe && !probe.usable) {
        throw new BackendUnavailable(
          "runtime-unavailable",
          `host pinned but ${rt} unusable: ${probe.reason ?? "?"}`,
        );
      }
      return this.withReason(await this.host.call(rt, interpreterPath, req), "pinned");
    }
    if (kind === "subprocess") {
      return this.withReason(await this.sub.call(rt, interpreterPath, req), "pinned");
    }
    // auto
    if (probe?.usable) {
      try {
        return await this.host.call(rt, interpreterPath, req);
      } catch (e) {
        if (!(e instanceof BackendUnavailable)) throw e;
        this.fallbackOnce(e.message);
        return this.withReason(
          await this.sub.call(rt, interpreterPath, req),
          `host-failed:${e.reason ?? "unavailable"}`,
        );
      }
    }
    return this.withReason(
      await this.sub.call(rt, interpreterPath, req),
      probe?.reason ?? "host-unusable",
    );
  }

  private withReason(r: ScriptCallResult, reason: string): ScriptCallResult {
    r.methodReason = reason;
    return r;
  }

  private fallbackOnce(reason: string): void {
    if (this.notified) return;
    this.notified = true;
    this.deps.notifyFallback(reason);
  }

  async reset(rt: ScriptRuntimeKind): Promise<void> {
    await Promise.all([this.host.reset(rt), this.sub.reset(rt)]);
  }

  async dispose(): Promise<void> {
    await Promise.all([this.host.dispose(), this.sub.dispose()]);
  }
}
