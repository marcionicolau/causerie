# Research: webview env propagation

## R1: Why #57 did not work
- **Decision**: Treat Bun `process.env` as not equal to the C environment.
- **Rationale**: Reporter verified in Bun 1.4.4 (system and bundled): `process.env.X="1"` then libc `getenv("X")` returns null. WebKitGTK reads via `getenv`. Reproduced in this repo by the existing test "a process.env assignment alone is invisible to getenv".
- **Alternatives**: none viable for the root cause; env-only fixes cannot work.

## R2: How to write the C environment
- **Decision**: libc `setenv(name, value, overwrite=1)` via `bun:ffi` `dlopen("libc.so.6")`, keeping the `process.env` write too.
- **Rationale**: Zero dependencies, same mechanism the project already uses for llama; verified working by the reporter on the installed bundle.
- **Alternatives**: (a) launcher script exporting the variable: only covers the packaged launcher, not `bun run dev` or direct binary runs, and cannot detect Wayland/NVIDIA cheaply; (b) re-exec self with the variable set: extra process churn and breaks `electrobun dev --watch`; (c) `.desktop` `Env=` entry: only for desktop-entry launches.

## R3: libc availability
- **Decision**: glibc `libc.so.6` only; any load/symbol failure returns `false` and startup continues.
- **Rationale**: Targets are Fedora/glibc distros. On musl the call no-ops, which equals the pre-fix behavior, not a regression.
- **Alternatives**: probe `libc.musl-*.so`; deferred until a musl user reports.

## R4: Ordering vs webview creation
- **Decision**: Keep the call at module top-level in `src/bun/index.ts`, before `new BrowserWindow`.
- **Rationale**: ESM import hoisting runs imports first, but the webview is spawned at window construction, which comes after the call.
- **Alternatives**: none needed.

## R5: Verification
- **Decision**: automated getenv round trip + manual packaged check on NVIDIA + Wayland.
- **Rationale**: The failure only manifests in a packaged GPU/compositor environment, so CI cannot cover it.
