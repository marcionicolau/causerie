// feature 029 (US3): compute preference (Auto / CPU only), detected GPU
// device + free VRAM, probe status/reason, and the compute path of the
// currently loaded model. Preference applies to the next model load.
import { SelectField } from "@/components/select-field";
import { useEffect, useState } from "react";
import { invoke } from "@/lib/rpc";
import type { ComputeMode, ComputePath, GpuProbeStatus } from "@shared/types";

interface ComputeStatus {
  probed: boolean;
  status: GpuProbeStatus;
  devices: {
    name: string;
    backend: string;
    freeBytes: number;
    totalBytes: number;
  }[];
  reason?: string;
  mode: ComputeMode;
  active?: ComputePath;
}

const MODES: { value: ComputeMode; label: string }[] = [
  { value: "auto", label: "Auto (use GPU when available)" },
  { value: "cpu", label: "CPU only" },
];

const gib = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GiB`;

const PATH_LABEL: Record<ComputePath["mode"], string> = {
  cpu: "CPU",
  "gpu-full": "GPU (full offload)",
  "gpu-partial": "GPU (partial offload)",
};

function statusText(s: ComputeStatus): string {
  if (!s.probed && s.status !== "disabled") return "Checking for GPU…";
  switch (s.status) {
    case "available":
      return "GPU available";
    case "unavailable":
      return "No usable GPU";
    case "timeout":
      return "GPU check timed out — using CPU";
    case "error":
      return "GPU check failed — using CPU";
    case "disabled":
      return "GPU disabled by preference";
  }
}

export function ComputeSettings() {
  const [mode, setMode] = useState<ComputeMode>("auto");
  const [st, setSt] = useState<ComputeStatus | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void invoke("settings.get", {}).then((s) => setMode(s.computeMode));
    void invoke("compute.status", {}).then(setSt).catch(() => {});
  }, []);

  const save = async (m: ComputeMode) => {
    try {
      await invoke("settings.set", { computeMode: m });
      setNote(null);
      // status view changes immediately (disabled vs probed result)
      void invoke("compute.status", {}).then(setSt).catch(() => {});
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };

  const dev = st?.devices[0];

  return (
    <section
      id="settings-compute"
      aria-labelledby="compute-heading"
      className="border-b border-border bg-muted/40 px-4 py-3"
    >
      <div className="mx-auto flex max-w-2xl flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2
            id="compute-heading"
            className="text-xs font-medium text-muted-foreground"
          >
            Compute
          </h2>
          {st && (
            <span className="text-xs text-muted-foreground">
              {statusText(st)}
              {st.active && ` · active: ${PATH_LABEL[st.active.mode]}`}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span id="compute-mode-label">Inference runs on</span>
          <SelectField
            aria-label="Compute mode"
            className="w-56"
            value={mode}
            options={MODES.map((m) => ({ value: m.value, label: m.label }))}
            onValueChange={(v) => {
              const m = v as ComputeMode;
              setMode(m);
              void save(m);
            }}
          />
          {dev && st?.status === "available" && (
            <span className="text-muted-foreground">
              {dev.name} ({dev.backend}) · {gib(dev.freeBytes)} free of{" "}
              {gib(dev.totalBytes)}
            </span>
          )}
        </div>
        {st?.status === "unavailable" && (
          <p className="text-xs text-muted-foreground/80">
            {st.reason
              ? `GPU not usable: ${st.reason}. `
              : ""}
            Everything still works on CPU — the same models and features.
          </p>
        )}
        {(st?.status === "error" || st?.status === "timeout") &&
          st.reason && (
            <p className="text-xs text-muted-foreground/80">
              {st.reason} — GPU is skipped for this session.
            </p>
          )}
        <p className="text-xs text-muted-foreground/80">
          Applies the next time a model loads; a model already loaded keeps
          its current path.
        </p>
        {note && <p className="text-xs text-muted-foreground/80">{note}</p>}
      </div>
    </section>
  );
}
