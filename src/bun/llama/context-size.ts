// feature 030: resolve the requested/effective context size for a model
// load. Pure — settings validation lives in json-store/handlers, the
// trained maximum comes from the GGUF meta (contextTrain).
import type { ContextSizeSettings, EffectiveContext } from "../../shared/types";

export const DEFAULT_CONTEXT_SIZE = 4096;
export const MIN_CONTEXT_SIZE = 512;
export const MAX_CONTEXT_SIZE = 1_048_576;

export function isValidContextSize(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= MIN_CONTEXT_SIZE &&
    v <= MAX_CONTEXT_SIZE
  );
}

// Drop invalid values on the way in (persisted file may be hand-edited):
// out-of-range or non-integer entries fall through to the next level.
export function sanitizeContextSettings(
  raw: unknown,
): ContextSizeSettings | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as { default?: unknown; perModel?: unknown };
  const out: ContextSizeSettings = {};
  if (isValidContextSize(r.default)) out.default = r.default;
  if (typeof r.perModel === "object" && r.perModel !== null) {
    const per: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.perModel)) {
      if (isValidContextSize(v)) per[k] = v;
    }
    if (Object.keys(per).length > 0) out.perModel = per;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Which size a load should request and what the user will actually get.
 * `requested` = perModel[basename] ?? default ?? 4096;
 * `effective` = min(requested, trainCtx) when the model reports a trained
 * maximum — clamp is set then so the UI can say which value won.
 */
export function resolveContextSize(
  settings: ContextSizeSettings | undefined,
  modelFileName: string,
  trainCtx: number | null,
): Omit<EffectiveContext, "fallback"> {
  let requested = DEFAULT_CONTEXT_SIZE;
  let source: EffectiveContext["source"] = "default";
  const per = settings?.perModel?.[modelFileName];
  if (isValidContextSize(per)) {
    requested = per;
    source = "model";
  } else if (isValidContextSize(settings?.default)) {
    requested = settings.default;
    source = "global";
  }
  const cap = trainCtx !== null && trainCtx > 0 ? trainCtx : requested;
  const effective = Math.min(requested, cap);
  return {
    requested,
    effective,
    source,
    clamp: requested > effective ? "model-maximum" : null,
  };
}
