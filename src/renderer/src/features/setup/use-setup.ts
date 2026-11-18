// feature 022: first-run bootstrap state — initial query + live events.
// issue #58: pushed events can still be lost (listener-not-yet-attached
// race, dropped bridge message) — while the phase is non-terminal the
// hook re-queries setup.status periodically and on window refocus so the
// modal always converges to the backend state.
import { useEffect, useRef, useState } from "react";
import { invoke, on } from "@/lib/rpc";
import type { SetupPhase, SetupState } from "@shared/types";
import { setupPhaseIsLive } from "./setup-phase";

const IDLE: SetupState = {
  phase: "idle",
  downloadedBytes: 0,
  totalBytes: null,
  targets: [],
};

const RESYNC_MS = 1500;

export function useSetup() {
  const [state, setState] = useState<SetupState>(IDLE);
  const phaseRef = useRef<SetupPhase>(state.phase);
  phaseRef.current = state.phase;

  useEffect(() => {
    const refresh = () =>
      void invoke("setup.status", {}).then(setState).catch(() => {});
    refresh();
    const off = on("setup.status", setState);
    const timer = setInterval(() => {
      if (setupPhaseIsLive(phaseRef.current)) refresh();
    }, RESYNC_MS);
    const onVisible = () => {
      if (document.visibilityState !== "hidden") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      off();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  const retry = () => {
    void invoke("setup.retry", {}).catch(() => {});
    void invoke("setup.status", {}).then(setState).catch(() => {});
  };
  return { state, retry };
}
