# Feature Specification: Fix webview env propagation (blank window on NVIDIA + Wayland)

**Feature Branch**: `fix/55-libc-setenv` (existing branch, PR #60 — no new branch)

**Created**: 2026-11-18

**Status**: Draft

**Input**: User description: "Fix issue #55: packaged app renders a blank window on NVIDIA + Wayland (WebKitGTK GBM buffer error). The earlier fix (#57) never took effect in the packaged build because the workaround variable was set only in the app runtime's own environment copy, which the native web view never reads. The variable must reach the process-level (C) environment before the web view starts, without overriding an explicit user value."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - App window renders on NVIDIA + Wayland (Priority: P1)

A Linux user on a Wayland session with the proprietary NVIDIA driver launches the packaged app with no special environment configuration. The main window shows the UI instead of a blank off-white surface.

**Why this priority**: Without it the app is unusable for this whole class of machines. The first attempted fix (#57) did not resolve it, so this is the actual fix.

**Independent Test**: On an NVIDIA + Wayland machine, launch the packaged build with no `WEBKIT_DISABLE_DMABUF_RENDERER` in the environment and confirm the UI paints. Automatically, after startup setup runs, the process-level environment must contain the workaround value.

**Acceptance Scenarios**:

1. **Given** Linux, a Wayland session, the NVIDIA kernel module loaded and the variable unset, **When** the app starts, **Then** the variable is visible with value `1` to the native process environment (not only to the runtime's own env object) before the web view is created, and the window renders.
2. **Given** the same machine, **When** the app is launched from a packaged (canary/stable) build, **Then** the UI renders, same as in dev.

---

### User Story 2 - User's explicit choice is respected (Priority: P2)

A user who has set `WEBKIT_DISABLE_DMABUF_RENDERER` themselves (to `0` or `1`) keeps that value.

**Why this priority**: Manual overrides are the documented escape hatch and must never be silently changed.

**Independent Test**: Start with the variable set to `0`. Afterwards both environments still say `0`.

**Acceptance Scenarios**:

1. **Given** the variable is already set to any value, **When** startup setup runs, **Then** neither environment is modified.

---

### User Story 3 - Other systems are unaffected and never break (Priority: P2)

On macOS, Windows, X11 sessions, non-NVIDIA Linux, or a Linux where the native environment cannot be written, startup is unchanged and never fails.

**Why this priority**: The workaround is only for one configuration. It must not degrade others or block startup.

**Independent Test**: Run the setup with non-matching conditions and with a failing native writer. No variable is set (non-matching) or startup continues normally (failing writer).

**Acceptance Scenarios**:

1. **Given** a non-Linux platform, a non-Wayland session, or NVIDIA module not loaded, **When** setup runs, **Then** no environment is changed.
2. **Given** a matching machine where writing the native environment is unavailable or errors, **When** setup runs, **Then** the app starts normally and the failure is not fatal.

---

### Edge Cases

- Variable set to an empty string by the user: counts as explicitly set, so it is not overridden.
- Wayland indicated only by the session-type variable, or only by the display variable: both count as Wayland.
- Native write fails while the runtime-level write succeeds: the app still starts; child processes still inherit the value.
- Setup runs more than once: result is idempotent.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: On Linux with a Wayland session and the NVIDIA module loaded, and the variable unset, the app MUST make `WEBKIT_DISABLE_DMABUF_RENDERER=1` visible in the process-level environment before the web view is created.
- **FR-002**: The app MUST also keep the value in the runtime's own environment object so child processes and in-app reads see it.
- **FR-003**: If the variable is already set to any value, including empty, the app MUST NOT modify it in either environment.
- **FR-004**: On non-Linux platforms, non-Wayland sessions, or when NVIDIA is not loaded, the app MUST NOT change the environment.
- **FR-005**: If the process-level environment cannot be written, the app MUST continue starting and MUST NOT throw.
- **FR-006**: Automated tests MUST verify the process-level environment (read back through the C library), not only the runtime env object, including a real round trip.
- **FR-007**: The packaged build MUST be verified to render on at least one NVIDIA + Wayland machine, and ideally a second one, before issue #55 is closed.
- **FR-008**: README documentation of the variable and manual fallback MUST stay accurate.

### Key Entities

- **Workaround condition**: platform + session type + driver state + existing variable value, which decides whether the workaround applies.
- **Environment views**: the runtime's own env object and the process-level environment. The web view reads only the latter.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a verified NVIDIA + Wayland machine, 100% of cold launches of the packaged build show a rendered UI with no external environment variable set.
- **SC-002**: Tests fail if the workaround reaches only the runtime env object and not the process-level one (the #57 regression is detectable).
- **SC-003**: Existing user-set values are preserved in 100% of tested cases.
- **SC-004**: Zero startup failures across non-matching platforms/sessions and simulated native-write failure cases.

## Assumptions

- The workaround stays scoped to Linux + Wayland + NVIDIA; broadening it is out of scope.
- The reporter's single-machine verification of the setenv approach is trusted as the root cause; a second machine is requested for confirmation.
- The implementation already exists on PR #60 (`fix/55-libc-setenv`), and this spec formalises and verifies it.
- Packaging/re-packaging a canary build is a manual verification step outside automated tests.
