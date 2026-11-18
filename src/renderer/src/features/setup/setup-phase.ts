// issue #58: which SetupState phases mean "still in flight" — while one
// of these holds, use-setup keeps re-querying setup.status so lost push
// events can't freeze the modal.
import type { SetupPhase } from "@shared/types";

export function setupPhaseIsLive(phase: SetupPhase): boolean {
  return phase === "checking" || phase === "downloading" || phase === "loading";
}
