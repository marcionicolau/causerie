// Typed engine wrapper over the llama_shim FFI surface.
// Pull model: generate() drives an async lls_step loop on the JS thread,
// yielding to the event loop between steps so RPC stays responsive.
import { accessSync, constants, existsSync, renameSync, rmSync } from "node:fs";
import { CString, ptr } from "bun:ffi";
import { basename, dirname, join } from "node:path";
import type { RpcErrorCode } from "../../shared/rpc-contract";
import type {
  ComputeMode,
  ComputePath,
  GenerationParams,
} from "../../shared/types";
import { loadLlamaShim, newErrSlot, readErr, type LlamaShim } from "./ffi";
import {
  awaitProbe,
  fitGpuLayers,
  halveLayers,
  noteStaleShim,
  reportRuntimeFault,
  resolveMode,
} from "./gpu";
import { packParams } from "./params";
import { Utf8Stream } from "./utf8";
import { entryKey, type SnapshotStore } from "../kv/store";
import { modelFingerprint } from "../models/library";

export class EngineError extends Error {
  constructor(
    public readonly code: RpcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

const TOKEN_BUF_CAP = 4096;

export class LlamaEngine {
  private shim: LlamaShim | null = null;
  private model: number | null = null;
  private ctx: number | null = null;
  private modelName: string | null = null;
  private generating = false;
  private stopRequested = false;
  private kvConvId: string | null = null;
  private kvRoleKey = "main"; // feature 010: "main"|"planner"|"executor"
  private modelPath: string | null = null;
  private compute: ComputePath | null = null; // feature 029
  private tokenBuf = new Uint8Array(TOKEN_BUF_CAP);
  private outLen = new BigUint64Array(1);

  status(): { status: "unloaded" | "loading" | "ready" | "error"; name?: string; error?: string } {
    if (this.model !== null) {
      return { status: "ready", name: this.modelName ?? undefined };
    }
    return { status: "unloaded" };
  }

  async loadModel(
    path: string,
    opts?: { computeMode?: ComputeMode; contextSize?: number },
  ): Promise<{
    status: "ready";
    name: string;
    compute?: ComputePath;
    // feature 030: what the context was created with; fallback is set
    // when a non-default size failed on memory and the retry at 4096 won
    context: {
      requested: number;
      effective: number;
      fallback: { reason: "memory" } | null;
    };
  }> {
    if (!existsSync(path)) {
      throw new EngineError("MODEL_NOT_FOUND", `model file not found: ${path}`);
    }
    try {
      accessSync(path, constants.R_OK);
    } catch {
      throw new EngineError("MODEL_INVALID", `model file is not readable: ${path}`);
    }
    this.unloadModel();

    if (this.shim === null) {
      try {
        this.shim = loadLlamaShim();
      } catch (e) {
        throw new EngineError("ENGINE_ERROR", String(e));
      }
    }
    const { symbols } = this.shim;
    const err = newErrSlot();

    // feature 029: resolve the compute path. CPU is today's path verbatim;
    // auto+usable-GPU probes GPU layers fitted to free VRAM, retry-halving
    // on ANY load2 failure (corrupt file also fails CPU-side at n=0).
    let nGpu = 0;
    const canGpu =
      opts?.computeMode !== "cpu" &&
      typeof symbols.lls_model_load2 === "function" &&
      typeof symbols.lls_backend_init_gpu === "function";
    if (opts?.computeMode !== "cpu" && !canGpu) {
      // stale shim predating this feature: GPU unusable regardless of
      // the probe — surface it via compute.status and stay on CPU
      noteStaleShim();
    }
    if (canGpu) {
      const probe = await awaitProbe();
      if (resolveMode(opts?.computeMode ?? "auto", probe) === "gpu") {
        symbols.lls_backend_init_gpu!(
          join(dirname(this.shim.path), "gpu"),
        );
        const meta = this.ggufMeta(path);
        const free = Math.max(...probe.devices.map((d) => d.freeBytes));
        nGpu = fitGpuLayers(meta.fileBytes, meta.nLayer, free);
      }
    }
    // bun:ffi returns null for a NULL pointer — 0 is unreachable here,
    // but !model covers both for safety
    let model: number | null = null;
    for (let attempts = 0; ; attempts++) {
      model =
        nGpu !== 0 && symbols.lls_model_load2
          ? symbols.lls_model_load2(path, nGpu, ptr(err))
          : symbols.lls_model_load(path, ptr(err));
      if (model) break;
      const msg = readErr(this.shim, err);
      // any failure while a GPU request is live → halve; the terminal
      // n=0 attempt is the plain CPU load (≤4 GPU attempts total)
      if (nGpu === 0 || attempts >= 3) {
        throw new EngineError(
          msg && /memory|alloc/i.test(msg) ? "OUT_OF_MEMORY" : "MODEL_INVALID",
          msg ?? "failed to load model",
        );
      }
      nGpu = halveLayers(nGpu);
    }

    // feature 030: requested context size (0 = the shim's 4096 default);
    // a stale shim without lls_ctx_create_ex always gives 4096
    const wantCtx = opts?.contextSize ?? 0;
    const createEx = symbols.lls_ctx_create_ex;
    let ctx = createEx
      ? createEx(model, wantCtx, ptr(err))
      : symbols.lls_ctx_create(model, ptr(err));
    let contextFallback: { reason: "memory" } | null = null;
    if (!ctx && createEx && wantCtx !== 0 && wantCtx !== 4096) {
      // FR-008: retry once at the default when the failure looks like an
      // allocation problem; a non-memory failure propagates instead
      const first = readErr(this.shim, err) ?? "";
      if (/memory|alloc/i.test(first)) {
        ctx = createEx(model, 0, ptr(err));
        if (ctx) contextFallback = { reason: "memory" };
      }
    }
    if (!ctx) {
      const msg = readErr(this.shim, err) ?? "failed to create context";
      symbols.lls_model_free(model);
      throw new EngineError("OUT_OF_MEMORY", msg);
    }

    this.model = model;
    this.ctx = ctx;
    this.modelName = basename(path);
    this.modelPath = path;
    this.compute = this.readComputePath(model);
    return {
      status: "ready",
      name: this.modelName,
      compute: this.compute,
      context: {
        requested: wantCtx || 4096,
        effective: this.contextSize(),
        fallback: contextFallback,
      },
    };
  }

  // feature 029: where the loaded model landed (lls_model_gpu_info);
  // stale shims report cpu — informational only, never gates a load
  computePath(): ComputePath | null {
    return this.compute;
  }

  private readComputePath(model: number): ComputePath {
    const { symbols } = this.shim ?? {};
    if (!symbols?.lls_model_gpu_info) return { mode: "cpu" };
    const err = newErrSlot();
    const p = symbols.lls_model_gpu_info(model, ptr(err));
    if (!p) return { mode: "cpu" };
    try {
      const j = JSON.parse(new CString(p).toString()) as {
        gpuLayers?: number;
        layersTotal?: number;
        device?: string | null;
      };
      const gpu = j.gpuLayers ?? 0;
      const total = j.layersTotal ?? 0;
      return gpu > 0
        ? {
            mode: gpu >= total ? "gpu-full" : "gpu-partial",
            device: j.device ?? undefined,
            gpuLayers: gpu,
            layersTotal: total,
          }
        : { mode: "cpu" };
    } catch {
      return { mode: "cpu" };
    } finally {
      symbols.lls_free_string(p);
    }
  }

  // feature 029: header-only GGUF read for fit math (same JSON the
  // model library surfaces); absent fields degrade to the -1 fallback
  private ggufMeta(path: string): {
    nLayer: number | null;
    fileBytes: number;
  } {
    const { symbols } = this.shim ?? {};
    if (!symbols?.lls_gguf_meta) return { nLayer: null, fileBytes: 0 };
    const err = newErrSlot();
    const p = symbols.lls_gguf_meta(path, ptr(err));
    if (!p) return { nLayer: null, fileBytes: 0 };
    try {
      const j = JSON.parse(new CString(p).toString()) as {
        nLayer?: number | null;
        fileBytes?: number;
      };
      return {
        nLayer: typeof j.nLayer === "number" ? j.nLayer : null,
        fileBytes: typeof j.fileBytes === "number" ? j.fileBytes : 0,
      };
    } catch {
      return { nLayer: null, fileBytes: 0 };
    } finally {
      symbols.lls_free_string(p);
    }
  }

  unloadModel(): void {
    // shutdown order: generate_end -> ctx_free -> model_free (lib stays open)
    if (this.shim === null) return;
    if (this.ctx !== null) {
      this.shim.symbols.lls_generate_end(this.ctx);
      this.shim.symbols.lls_ctx_free(this.ctx);
      this.ctx = null;
    }
    if (this.model !== null) {
      this.shim.symbols.lls_model_free(this.model);
      this.model = null;
    }
    this.modelName = null;
    this.modelPath = null;
    this.compute = null;
    this.generating = false;
    this.stopRequested = false;
    this.kvConvId = null;
  }

  stop(): void {
    this.stopRequested = true;
  }

  isGenerating(): boolean {
    return this.generating;
  }

  // configured context-window size in tokens; 0 when no model is loaded
  contextSize(): number {
    if (this.ctx === null || this.shim === null) return 0;
    return this.shim.symbols.lls_ctx_size(this.ctx);
  }

  chatTemplate(): string | null {
    if (this.model === null || this.shim === null) return null;
    return this.shim.symbols.lls_chat_template(this.model);
  }

  // real token count via the model's tokenizer; chars/4 estimate when no
  // model is loaded (fallback keeps budgeting sane pre-load)
  tokenCount(text: string): number {
    if (this.ctx === null || this.shim === null) {
      return Math.ceil(text.length / 4);
    }
    const n = this.shim.symbols.lls_token_count(this.ctx, text);
    return n > 0 ? n : Math.ceil(text.length / 4);
  }

  // Drives the pull loop. onToken receives raw byte-chunks decoded as text.
  // params == null selects shim defaults (greedy + LLS_MAX_GEN/512 cap).
  // Resolves status "complete" on natural end, "partial" when stop() was
  // called; tokens counts generated tokens (one per lls_step).
  async generate(
    prompt: string,
    onToken: (delta: string) => void,
    params?: GenerationParams | null,
    opts?: {
      conversationId?: string;
      roleKey?: string; // feature 010: fusion phase key
      snapshot?: SnapshotStore; // feature 010: enables save/restore
    },
  ): Promise<{
    status: "complete" | "partial";
    tokens: number;
    elapsedMs: number;
    warm: boolean;
    // feature 016: exact sent-token count via the real tokenizer
    promptTokens: number;
  }> {
    if (this.ctx === null || this.shim === null) {
      throw new EngineError("NO_MODEL", "no model is loaded");
    }
    if (this.generating) {
      throw new EngineError("ENGINE_BUSY", "a generation is already active");
    }
    const { symbols } = this.shim;
    const err = newErrSlot();
    const pbuf = params ? packParams(params) : null;

    // KV reuse: continue-path when the conversation matches the last one;
    // the shim verifies the token prefix and falls back to a full decode
    // on any mismatch (correctness is guaranteed in C)
    const convId = opts?.conversationId;
    const roleKey = opts?.roleKey ?? "main";
    let resume =
      convId !== undefined &&
      convId === this.kvConvId &&
      roleKey === this.kvRoleKey;
    // feature 010: cold slot → try a disk snapshot before re-prefill;
    // any failure is silent and falls through to normal prefill (FR-009)
    if (!resume && convId && opts?.snapshot && this.modelPath) {
      resume = this.tryRestore(opts.snapshot, convId, roleKey);
    }
    const pptr = pbuf ? ptr(pbuf) : null;
    const rc = resume
      ? symbols.lls_generate_continue(this.ctx, prompt, pptr, ptr(err))
      : symbols.lls_generate_begin(this.ctx, prompt, pptr, ptr(err));
    if (rc !== 0 && rc !== 2) {
      const msg = readErr(this.shim, err) ?? "failed to begin generation";
      throw new EngineError("ENGINE_ERROR", msg);
    }
    const warm = resume && rc === 0;
    // feature 016 (FR-002): the "sent" count is exactly the shim's
    // tokenize of the same prompt string
    const promptTokens = symbols.lls_token_count(this.ctx, prompt);
    this.kvConvId = convId ?? this.kvConvId;
    if (convId) this.kvRoleKey = roleKey;

    const started = performance.now();
    let tokens = 0;
    this.generating = true;
    this.stopRequested = false;
    // one stateful decoder per generation so multi-byte characters split
    // across tokens never turn into U+FFFD
    const utf8 = new Utf8Stream();
    const flushUtf8 = () => {
      const tail = utf8.flush();
      if (tail) onToken(tail);
    };
    try {
      for (;;) {
        if (this.stopRequested) {
          flushUtf8();
          return {
            status: "partial",
            tokens,
            elapsedMs: performance.now() - started,
            warm,
            promptTokens,
          };
        }
        this.outLen[0] = 0n;
        const r = symbols.lls_step(this.ctx, ptr(this.tokenBuf), TOKEN_BUF_CAP, ptr(this.outLen));
        if (r === 0) {
          flushUtf8();
          return {
            status: "complete",
            tokens,
            elapsedMs: performance.now() - started,
            warm,
            promptTokens,
          };
        }
        if (r < 0) {
          // feature 029 (FR-012): a GPU-path decode failure latches the
          // probe so the next load resolves CPU automatically
          if (this.compute?.mode.startsWith("gpu")) {
            reportRuntimeFault();
          }
          throw new EngineError("ENGINE_ERROR", "decode step failed");
        }
        tokens += 1;
        const n = Number(this.outLen[0]);
        if (n > 0) {
          const text = utf8.push(this.tokenBuf.subarray(0, n));
          if (text) onToken(text);
        }
        // macrotask yield: keeps the event loop responsive for RPC
        // oxlint-disable-next-line no-await-in-loop -- sequential pull/step decode is required
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      symbols.lls_generate_end(this.ctx);
      this.generating = false;
      // feature 010: turn boundary → persist the decode state (FR-001).
      // Best-effort: any failure just means no snapshot this turn.
      if (convId && opts?.snapshot) {
        try {
          this.saveState(opts.snapshot);
        } catch {
          /* accelerator only */
        }
      }
    }
  }

  // feature 010: serialize resident KV for (kvConvId, kvRoleKey) via
  // shim → .tmp → rename → manifest. No-ops without a loaded model, a
  // state-capable shim, or a tagged conversation.
  saveState(store: SnapshotStore): void {
    const { symbols } = this.shim ?? {};
    if (
      !this.ctx ||
      !symbols?.lls_state_save ||
      !this.kvConvId ||
      !this.modelPath
    )
      return;
    const key = entryKey(this.kvConvId, this.kvRoleKey);
    const tmp = store.tmpPath(key);
    const err = newErrSlot();
    if (symbols.lls_state_save(this.ctx, tmp, ptr(err)) !== 0) {
      rmSync(tmp, { force: true });
      return;
    }
    renameSync(tmp, store.blobPath(key));
    store.save({
      key,
      convId: this.kvConvId,
      roleKey: this.kvRoleKey,
      modelPath: this.modelPath,
      fingerprint: modelFingerprint(this.modelPath),
      ctxSize: this.contextSize(),
    });
  }

  // feature 010: manifest-gated restore. Returns true when the shim
  // loaded the snapshot (kvConvId/kvRoleKey then track it).
  private tryRestore(
    store: SnapshotStore,
    convId: string,
    roleKey: string,
  ): boolean {
    const { symbols } = this.shim ?? {};
    if (!this.ctx || !symbols?.lls_state_load || !this.modelPath)
      return false;
    const key = entryKey(convId, roleKey);
    const p = store.lookup(
      key,
      modelFingerprint(this.modelPath),
      this.contextSize(),
    );
    if (!p) return false;
    const err = newErrSlot();
    if (symbols.lls_state_load(this.ctx, p, ptr(err)) !== 0) return false;
    this.kvConvId = convId;
    this.kvRoleKey = roleKey;
    store.touch(key);
    return true;
  }

  dispose(): void {
    this.unloadModel();
    if (this.shim !== null) {
      this.shim.lib.close();
      this.shim = null;
    }
  }
}
