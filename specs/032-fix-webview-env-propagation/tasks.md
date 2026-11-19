---

description: "Task list for fix webview env propagation (#55)"
---

# Tasks: Fix webview env propagation (blank window on NVIDIA + Wayland)

**Input**: Design documents from `specs/032-fix-webview-env-propagation/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: Included. FR-006 requires tests that read the C environment through libc.

**Baseline**: `libcSetenv` + `applyLinuxWebviewEnv` already exist on this branch (PR #60), and 12 tests pass. Tasks only cover the gaps in plan.md.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [X] T001 Confirm baseline: run `bun test tests/bun/linux-webkit-env.test.ts` and verify 12 pass on branch `fix/55-libc-setenv`

---

## Phase 2: Foundational

- [X] T002 Add a `getenv` test helper (via `bun:ffi` `dlopen("libc.so.6")`, returning `string | null`) at module scope in `tests/bun/linux-webkit-env.test.ts`, reusing the one currently inside the `libcSetenv (real libc)` describe block so all new tests share it

**Checkpoint**: shared helper ready; story tests can follow. All remaining test tasks edit the same file, so they run sequentially.

---

## Phase 3: User Story 1 - App window renders on NVIDIA + Wayland (Priority: P1) 🎯 MVP

**Goal**: After `applyLinuxWebviewEnv()`, `WEBKIT_DISABLE_DMABUF_RENDERER=1` is visible to libc `getenv` before the webview starts.

**Independent Test**: The end-to-end test below fails if only `process.env` is written (reproduces #57).

- [X] T003 [US1] In `tests/bun/linux-webkit-env.test.ts` add test "applyLinuxWebviewEnv with the real libcSetenv exposes WEBKIT_DISABLE_DMABUF_RENDERER=1 to getenv" using `applyLinuxWebviewEnv({ WAYLAND_DISPLAY: "wayland-1" }, libcSetenv, { platform: "linux", moduleLoaded: () => true })` then asserting the T002 helper returns `"1"`. Skip on non-Linux; clean up with libc `unsetenv` or restore afterwards so other tests are not polluted
- [X] T004 [US1] In `tests/bun/linux-webkit-env.test.ts` add a regression test: with a native writer stub that does nothing, assert `getenv` stays `null` even though `env.WEBKIT_DISABLE_DMABUF_RENDERER === "1"` (documents the #57 failure mode)
- [X] T005 [US1] Verify `src/bun/index.ts` still calls `applyLinuxWebviewEnv()` before the first `new BrowserWindow(...)`; fix the ordering only if it is not (no change expected)

**Checkpoint**: US1 verifiable with `bun test`; packaged check deferred to Phase 6.

---

## Phase 4: User Story 2 - User's explicit choice is respected (Priority: P2)

**Goal**: A user-set value, including an empty string, is never changed in either environment.

**Independent Test**: tests below pass with the variable preset to `"0"`, `"1"` and `""`.

- [X] T006 [US2] In `tests/bun/linux-webkit-env.test.ts` add a test where `env.WEBKIT_DISABLE_DMABUF_RENDERER === ""` (empty string, matching Wayland + NVIDIA probes): the native setter is never called and `env` is unchanged
- [X] T007 [US2] In `tests/bun/linux-webkit-env.test.ts` add a `test.each` over `"0"` and `"1"` preset values asserting both the env object and the recorded native calls are untouched

**Checkpoint**: US2 covered.

---

## Phase 5: User Story 3 - Other systems unaffected and never break (Priority: P2)

**Goal**: No-op on non-matching systems; a native failure is non-fatal and diagnosable.

**Independent Test**: tests below pass without a real NVIDIA machine.

- [X] T008 [US3] In `src/bun/linux-webkit-env.ts`, make `applyLinuxWebviewEnv` emit a single `console.warn("[linux-webkit-env] native setenv failed; WEBKIT_DISABLE_DMABUF_RENDERER only set in process.env")` when `native(...)` returns `false`; still return `true` and never throw
- [X] T009 [US3] In `tests/bun/linux-webkit-env.test.ts` extend the failing-native test to spy on `console.warn` and assert it is called once with the message from T008; add a case where the native writer throws and assert `applyLinuxWebviewEnv` still does not propagate the error (wrap the `native` call in try/catch in `src/bun/linux-webkit-env.ts` if it does)
- [X] T010 [US3] In `tests/bun/linux-webkit-env.test.ts` add a non-Linux case (`platform: "darwin"`, `"win32"`) confirming the native setter is never called and no warning is logged

**Checkpoint**: all three stories covered by automated tests.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T011 Run gates: `bun run typecheck`, `bun run lint`, `bun test ./tests` (scoped) and fix anything this change introduced
- [X] T012 [P] Re-read `README.md` (env table row for `WEBKIT_DISABLE_DMABUF_RENDERER` and the "Blank window on Linux (NVIDIA + Wayland)" troubleshooting entry) and adjust wording only if inaccurate (FR-008); also mention that on non-glibc systems the automatic workaround is not applied and the manual variable is needed
- [X] T013 [P] Update the AGENTS.md note for this area, if one exists, to say the workaround writes both `process.env` and the C environment (Bun `process.env` is not libc `environ`). Add a short gotcha line near the "bun:ffi NULL returns" gotcha
- [ ] T014 Manual: build a packaged canary (`bun run package`), launch with `env -u WEBKIT_DISABLE_DMABUF_RENDERER` and a fresh `APP_DATA_DIR` on an NVIDIA + Wayland machine, confirm UI paints and no `Failed to create GBM buffer` (quickstart.md, steps 1-3). Then repeat with the variable preset to `0` (step 4)
- [ ] T015 Post results (machine, GPU, driver, distro) on issue #55 and PR #60, ask for a second machine, and close #55 only after confirmation (FR-007)

---

## Dependencies & Execution Order

- T001 → T002 → US1 (T003-T005) → US2 (T006-T007) → US3 (T008-T010) → Polish.
- User stories are independent in behavior, but T003-T010 edit `tests/bun/linux-webkit-env.test.ts`, so they run sequentially. T008 changes `src/bun/linux-webkit-env.ts` and must precede T009.
- T012 and T013 are parallel (different files); T014-T015 need a packaged build and a suitable machine, and come last.

## Parallel Example

```text
After T011: T012 (README.md) and T013 (AGENTS.md) in parallel.
```

## Implementation Strategy

- **MVP**: Phases 1-3 (T001-T005). They prove the C-environment fix with an end-to-end test, since the code already exists.
- **Then**: US2 and US3 for robustness and diagnosability, then the gates and the manual packaged verification.
- Commit per phase using the project convention (`.specify/extensions/git/scripts/bash/auto-commit.sh`), conventional-commit messages.
