# Implementation Plan: Fix webview env propagation (#55)

**Branch**: `fix/55-libc-setenv` (existing; PR #60) | **Date**: 2026-11-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/032-fix-webview-env-propagation/spec.md`

## Summary

The #57 workaround set `WEBKIT_DISABLE_DMABUF_RENDERER` only through Bun's `process.env`, which never reaches libc's `environ`, so WebKitGTK's `getenv` never saw it. PR #60 already adds a libc `setenv` call through `bun:ffi` in `src/bun/linux-webkit-env.ts` (`libcSetenv`, wired in `applyLinuxWebviewEnv`). This plan treats that code as the baseline and closes the gaps against the spec: an end-to-end test that goes through `applyLinuxWebviewEnv` and reads back via real `getenv`, failure observability, README accuracy, and packaged-build verification.

## Technical Context

**Language/Version**: TypeScript (strict), Bun 1.4.4

**Primary Dependencies**: `bun:ffi` (built in, no new packages), glibc `setenv`/`getenv`

**Storage**: N/A

**Testing**: `bun test ./tests` (scoped), file `tests/bun/linux-webkit-env.test.ts`

**Target Platform**: Linux (glibc); other platforms are no-ops

**Project Type**: desktop-app (Electrobun main process)

**Performance Goals**: N/A, one-shot call at startup, well under 1 ms

**Constraints**: must run before the webview spawns; must never throw; never override a user-set value

**Scale/Scope**: 1 source file, 1 test file, README note

## Constitution Check

| Principle | Status |
|-----------|--------|
| I Local-first inference | N/A, unrelated |
| II Electrobun process boundaries | Pass, main-process startup only; no RPC touched |
| III Strict TS & typed FFI | Pass, typed `NativeSetenv`; FFI signature declared; return value validated (`=== 0`); failure caught. |
| IV/V Components / Vite | N/A |
| VI Minimal dependencies | Pass, no new dependency; `bun:ffi` is built in |
| Quality gates (tsc, lint, FFI path tested) | To run in tasks: `bun run typecheck`, `bun run lint`, scoped tests |

Re-check after design: no change, still passes.

## Project Structure

### Documentation (this feature)

```text
specs/032-fix-webview-env-propagation/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── tasks.md          # /speckit-tasks
```

No `contracts/`: no external interface is added or changed.

### Source Code

```text
src/bun/linux-webkit-env.ts        # libcSetenv + applyLinuxWebviewEnv (exists on PR #60)
src/bun/index.ts                   # calls applyLinuxWebviewEnv() before window creation
tests/bun/linux-webkit-env.test.ts # add end-to-end getenv test (gap)
README.md                          # variable table + troubleshooting (verify wording)
```

**Structure Decision**: Single existing module; no new files in `src/`.

## Gap analysis (PR #60 vs spec)

| Req | Covered by PR #60 | Gap |
|-----|-------------------|-----|
| FR-001 C env visible | `libcSetenv` + test "makes value visible to getenv" using a different variable | No test that `applyLinuxWebviewEnv` itself leaves `WEBKIT_DISABLE_DMABUF_RENDERER=1` in real `getenv` |
| FR-002 process.env kept | yes | none |
| FR-003 no override | yes (predicate + test) | Empty-string case not tested |
| FR-004 non-matching no-op | yes | none |
| FR-005 never throws | try/catch + test with failing native | Failure is silent; add a one-line `console.warn` so a blank window is diagnosable |
| FR-006 tests read C env | partially | See FR-001 gap |
| FR-007 packaged verification | no | Manual step, see quickstart |
| FR-008 README | present | Mention the C-environment reason is not needed; confirm text is still accurate |
