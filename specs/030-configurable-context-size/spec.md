# Feature Specification: Configurable Context Size

**Feature Branch**: `030-configurable-context-size`

**Created**: 2026-11-16

**Status**: Draft

**Input**: User description: "Let the user choose how much conversation a model can hold (its context size) instead of the fixed 4,096-token ceiling, safely and without changing behaviour for existing users. Origin: spec 002 (`code-oss-host-migration`) of the research repository `marcionicolau/causerie-code-oss`, Phase 1 survey `p1-causerie-survey.md`: long documents and agent planning prompts exceed 4,096 tokens and are rejected or truncated."

## Clarifications

### Session 2026-11-16

- Q: After a size change, reload automatically or at the next load? → A: At the next load, with a one-click "Reload now" button next to the changed value.
- Q: What if a single new message is longer than the size in effect? → A: Warn before sending, show the size needed, and offer to raise the size or send anyway.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Work with long documents (Priority: P1)

A user wants to discuss a long document, or run a multi-step agent whose planning prompt is longer than 4,096 tokens. They open the model settings, choose a larger context size (for example 16,384), reload the model, and the long content is accepted and answered instead of being rejected or cut off.

**Why this priority**: it is the whole point of the feature; today the ceiling is fixed and blocks long-input work.

**Independent Test**: set the context size to 16,384, reload a model, send a synthetic ~12,000-token document with a question, and confirm a complete answer that uses the document.

**Acceptance Scenarios**:

1. **Given** the default context size, **When** the user sends content longer than the limit, **Then** behaviour is exactly as today (no change for anyone who did not touch the setting).
2. **Given** the user chose 16,384 and reloaded the model, **When** they send a ~12,000-token document, **Then** it is accepted in full and the answer references its content.
3. **Given** the user chose a size larger than the model supports, **When** the model loads, **Then** the app uses the model's own maximum and tells the user which value is in effect and why.

---

### User Story 2 - Safe choices on limited hardware (Priority: P1)

A user on a machine with limited memory picks a size that is too large. The app warns before loading, based on the memory advisor's recommendation, lets them proceed anyway, and if the load then fails for lack of memory it recovers to the previous working size and explains what happened, instead of leaving them with no model.

**Why this priority**: larger context uses much more memory; without a safety net a wrong choice breaks the app's core flow.

**Independent Test**: choose an oversized value on a machine with little free memory; confirm the warning, then confirm that a failed load ends with a working model at the default size and a clear message.

**Acceptance Scenarios**:

1. **Given** a chosen size above the advisor's recommendation for current free memory, **When** the user confirms the choice, **Then** a warning shows the recommendation and the user can accept or lower the value.
2. **Given** a load that fails for lack of memory at the chosen size, **When** the app handles the failure, **Then** it reloads at the default size and tells the user the chosen size could not be used.

---

### User Story 3 - Per-model sizes and one-click recommendation (Priority: P2)

A user runs a small fast model and a larger one. They keep a modest size for one and a large size for the other (including the two bound models in fusion mode), and can apply the advisor's recommended size to a model with one action.

**Why this priority**: models differ in memory cost and training length; a single global value would force a compromise.

**Independent Test**: set different sizes for two models, load each, and confirm each runs at its own size; apply the advisor's recommendation to one and confirm it matches.

**Acceptance Scenarios**:

1. **Given** a global default and a per-model override, **When** the model loads, **Then** the override wins; models without one use the global default.
2. **Given** the advisor shows a recommended size for a model, **When** the user chooses "apply recommendation", **Then** the model's size is set to that value and the reload requirement is shown.

---

### User Story 4 - Saved context stays correct (Priority: P3)

Saved conversation context (the stored model state that speeds up continuing a chat) was created at some size. After the user changes the size, the app never restores a saved state created at a different size, and conversation history is trimmed to the size actually in effect.

**Why this priority**: silent mismatches would give wrong answers or errors.

**Independent Test**: save context at 4,096, change to 8,192, reload, continue the chat; confirm the old saved state is ignored and answers are correct.

**Acceptance Scenarios**:

1. **Given** saved context made at a different size, **When** a chat continues after a size change, **Then** the saved state is discarded and rebuilt, with no error.
2. **Given** a size in effect, **When** history is trimmed to fit, **Then** it is trimmed to that size, not to the old ceiling.

### Edge Cases

- Requested size below a sensible minimum, zero, negative, or non-numeric: rejected with a message; the previous value is kept.
- Model trained for fewer tokens than requested: clamp to the model's maximum and say so.
- Size changed while a response is generating: the change applies at the next load; the user sees that a reload is needed; nothing changes mid-response.
- Fusion mode with two models: each model uses its own effective size; the memory warning accounts for both.
- Persisted value from an older or corrupt settings file: fall back to the default silently.
- GPU in use (spec 029): memory warnings use whichever memory the model will occupy.
- A single message larger than the effective size: the user is warned before sending (FR-013) and chooses to raise the size or send anyway.
- Memory pressure appears only after several turns: the existing error handling applies; this feature does not add mid-chat resizing.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST let the user set a context size as a global default and as an optional per-model override; a per-model value takes precedence.
- **FR-002**: The default MUST remain 4,096 tokens, so users who change nothing see no behavioural difference after upgrading.
- **FR-003**: The system MUST accept sizes from 512 tokens up to the model's own maximum, offer common presets (4,096, 8,192, 16,384, 32,768), and reject out-of-range or non-numeric input with a clear message.
- **FR-004**: The effective size MUST be the smaller of the requested size and the model's trained maximum; when clamped, the user MUST be told which value is in effect.
- **FR-005**: A changed size MUST take effect the next time the model loads and MUST NOT change mid-response; the interface MUST show when a reload is needed and offer a one-click "Reload now" action next to the changed value. The app MUST NOT reload the model on its own because of a size change.
- **FR-013**: When the newest message alone is larger than the effective size, the system MUST warn before sending, show the size that would be needed, and offer to raise the size or send anyway; it MUST NOT cut the message silently.
- **FR-006**: History trimming, saved-context validity checks and any displayed capacity MUST use the effective size.
- **FR-007**: Before loading with a size above the advisor's recommendation for current free memory, the system MUST warn the user and show the recommendation, and MUST let them proceed.
- **FR-008**: If a load fails for lack of memory at a non-default size, the system MUST reload at the default size and tell the user; the user MUST NOT be left without a loaded model unexplained.
- **FR-009**: The model or performance view MUST display the effective size of each loaded model.
- **FR-010**: The advisor MUST offer an action that applies its recommended size to a model.
- **FR-011**: The setting MUST persist across restarts and upgrades; an invalid persisted value MUST fall back to the default.
- **FR-012**: The feature MUST work fully offline and add no network use.

### Key Entities

- **Context size setting**: a number of tokens, held as a global default and optionally per model; attributes: value, source (default, global, per-model, recommendation).
- **Effective context size**: the value a loaded model actually runs with; attributes: value, clamp reason (none, model maximum, fallback after memory failure).
- **Saved context**: stored model state tied to a specific model and size; valid only at the size it was created.
- **Advisor recommendation**: the existing per-model recommended size derived from free memory (spec 011).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With the size set to 16,384, a synthetic ~12,000-token document is accepted and answered in full on a machine with enough memory, in 100% of 5 trials.
- **SC-002**: After upgrading with no changes, 100% of existing profiles load models at an effective size of 4,096 (regression check).
- **SC-003**: A size change takes effect after one model reload, with no restart of the app.
- **SC-004**: When a chosen size cannot be loaded for lack of memory, the user ends with a working model at the default size and a clear message in 10 of 10 trials.
- **SC-005**: Saved contexts created at a different size are never restored: 0 mismatches across the test matrix.
- **SC-006**: The size in effect for every loaded model is visible to the user without leaving the model view.

## Assumptions

- The default stays at 4,096; changing it is a separate decision for the maintainers once usage data exists.
- The native inference layer gains a way to receive the requested size when creating a model context (a change to its C interface); the existing in-process inference rule of the project constitution is unchanged.
- The memory advisor (spec 011) already computes a recommended size; this feature reuses it and makes it actionable.
- GPU memory handling belongs to spec 029 and is out of scope here; the two features share the advisor's free-memory figure.
- Origin and evidence: spec 001/002 of `marcionicolau/causerie-code-oss` (the 4,096-token ceiling blocked a legal agent's planner prompt of about 6,000 tokens on every host).
- No new third-party dependency is needed.
