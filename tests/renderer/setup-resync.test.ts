// issue #58: the first-run modal must converge to backend state even when
// pushed setup.status events are lost — resync runs while the phase is
// live and stops on terminal phases.
import { describe, expect, test } from "bun:test";
import { setupPhaseIsLive } from "../../src/renderer/src/features/setup/setup-phase";

describe("setupPhaseIsLive", () => {
  test("non-terminal phases keep resyncing", () => {
    for (const p of ["checking", "downloading", "loading"] as const) {
      expect(setupPhaseIsLive(p)).toBe(true);
    }
  });
  test("terminal phases stop the poll", () => {
    for (const p of ["idle", "done", "error"] as const) {
      expect(setupPhaseIsLive(p)).toBe(false);
    }
  });
});
