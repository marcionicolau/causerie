// feature 030 (US1–US3): per-model / global context-size control.
// Source precedence: perModel[basename] > global default > 4096. A saved
// change never reloads — it applies on the next load ("Reload now" when
// the edited model is the active one). Warns when the chosen size exceeds
// the advisor's recommendedCtx for this file (US2; the user may proceed).
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { invoke } from "@/lib/rpc";
import { notify } from "@/lib/notify";
import type {
  ContextSizeSettings,
  EffectiveContext,
  ModelAdvise,
} from "@shared/types";

const PRESETS = [4096, 8192, 16384, 32768];
const isValid = (v: number) =>
  Number.isInteger(v) && v >= 512 && v <= 1_048_576;
const fmt = (v: number) => (v >= 1024 ? `${v / 1024}k` : `${v}`);

interface Props {
  fileName: string;
  active: boolean;
  advise?: ModelAdvise;
  context?: ContextSizeSettings;
  // model.status.context when this model is the loaded one
  loaded?: EffectiveContext | null;
  onSaved: () => void;
  onReload: () => void;
}

export function ContextSizeControl({
  fileName,
  active,
  advise,
  context,
  loaded,
  onSaved,
  onReload,
}: Props) {
  const perModel = context?.perModel?.[fileName];
  const source =
    perModel !== undefined
      ? "model"
      : context?.default !== undefined
        ? "global"
        : "default";
  const current = perModel ?? context?.default ?? 4096;
  const [custom, setCustom] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const customNum = Number(custom);
  const customErr =
    custom !== "" && !isValid(customNum) ? "Integer 512–1048576" : null;
  const recommended = advise?.recommendedCtx;
  const overBudget = recommended !== undefined && current > recommended;
  const reloadNeeded =
    active && loaded != null && current !== loaded.effective;

  const save = async (patch: {
    default?: number | null;
    perModel?: Record<string, number | null>;
  }) => {
    setBusy(true);
    setErr(null);
    try {
      await invoke("settings.set", { context: patch });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1 space-y-2 rounded border border-border bg-background/60 p-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">
          Context{" "}
          <span className="text-foreground">{current.toLocaleString()}</span>{" "}
          (
          {source === "model"
            ? "this model"
            : source === "global"
              ? "global"
              : "default"}
          )
        </span>
        {PRESETS.map((p) => (
          <Button
            key={p}
            size="sm"
            variant={current === p ? "secondary" : "ghost"}
            className="h-6 px-2 text-xs"
            disabled={busy}
            aria-label={`Set context to ${p}`}
            onClick={() => void save({ perModel: { [fileName]: p } })}
          >
            {fmt(p)}
          </Button>
        ))}
        <div className="flex items-center gap-1">
          <Field className="w-24" data-invalid={customErr ? true : undefined}>
            <FieldLabel htmlFor={`ctx-${fileName}`} className="sr-only">
              Custom context size
            </FieldLabel>
            <Input
              id={`ctx-${fileName}`}
              className="h-6 text-xs"
              inputMode="numeric"
              placeholder="custom"
              value={custom}
              aria-invalid={customErr ? true : undefined}
              onChange={(e) => setCustom(e.target.value)}
            />
          </Field>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            disabled={busy || custom === "" || customErr !== null}
            aria-label="Set custom context size for this model"
            title="Set for this model"
            onClick={() => {
              void save({ perModel: { [fileName]: customNum } });
              setCustom("");
            }}
          >
            Set
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            disabled={busy || custom === "" || customErr !== null}
            aria-label="Set custom context size as global default"
            title="Set as global default"
            onClick={() => {
              void save({ default: customNum });
              setCustom("");
            }}
          >
            Set global
          </Button>
        </div>
        {perModel !== undefined && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            disabled={busy}
            onClick={() => void save({ perModel: { [fileName]: null } })}
          >
            Clear override
          </Button>
        )}
        {recommended !== undefined && current !== recommended && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs text-success"
            disabled={busy}
            title={`Advisor recommends ≤ ${recommended.toLocaleString()} for this model (${advise?.basis} basis)`}
            onClick={() =>
              void save({ perModel: { [fileName]: recommended } })
            }
          >
            Use recommended {fmt(recommended)}
          </Button>
        )}
      </div>
      {customErr && <FieldError className="text-xs">{customErr}</FieldError>}
      {overBudget && (
        <p className="text-warning">
          Above the advisor&apos;s recommended {recommended?.toLocaleString()}{" "}
          for this model — may not fit in memory; it will still apply on next
          load.
        </p>
      )}
      {reloadNeeded && (
        <div className="flex items-center gap-2 text-warning">
          <span>
            Saved {current.toLocaleString()} applies on next load (loaded:{" "}
            {loaded.effective.toLocaleString()})
          </span>
          <Button
            size="sm"
            variant="secondary"
            className="h-6 px-2 text-xs"
            onClick={() => {
              onReload();
              notify.info("Reloading model", {
                description: `Applying context size ${current.toLocaleString()}`,
              });
            }}
          >
            Reload now
          </Button>
        </div>
      )}
      {err && <FieldError className="text-xs">{err}</FieldError>}
    </div>
  );
}
