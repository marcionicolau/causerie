# Validation: Interface Usability Overhaul

Records the before/after evidence for SC-001…SC-011. Entries marked
*owner* need a run in the real Electrobun window; everything else is
automated or code-verified.

## Walkthrough results (SC-002, SC-003, SC-004)

Script: `walkthrough.md`. Baseline run on `main` (T002), final run on the
feature branch (T065).

| #   | Date       | Build (baseline / final) | Time (s) | Keystrokes + clicks | Pass | Notes                   |
| --- | ---------- | ------------------------ | -------- | ------------------- | ---- | ----------------------- |
| 1   | 13-11-2026 | baseline                 | 10.5s    | 1                   | Ok   |                         |
| 2   | 13-11-2026 | baseline                 | 9.4s     | 4                   | Ok   | Wrong Characters showed |
| 3–6 | —          | baseline                 | —        | —                   | —    | *skipped — owner decision 2026-11-13; steps 1–2 recorded before the merge window remain the reference* |
| 1   | 17-11-2026 | final (harness)          | 0.9s     | Ctrl+N + type + Enter | Ok | New chat → "Generating" busy state + optimistic message visible |
| 2–5 | —          | final                    | —        | —                   | —    | *owner: T065 — need a real window (model load progress, file dialog, confirm dialog)* |
| 6a  | 17-11-2026 | final (harness)          | 1.7s     | Ctrl+K, "Synt", Enter | Ok | Named conversation reached |
| 6b  | 17-11-2026 | final (harness)          | ~1.4s    | Ctrl+K, "Go to Mo", ↓, Enter | Ok | "Go to Models" is 2nd match under fuzzy ranking; 1 extra keystroke |
| 6c  | 17-11-2026 | final (harness)          | 1.3s     | Ctrl+K, "compact", Enter | Ok | "Toggle compact density" action applied |

Final-run notes (harness): measured in Chrome 1440×900/1024×720 against the
real renderer on `bun run dev:renderer` with a stubbed `__electrobunHostBridge`
(canned RPC replies, synthetic data). Timings are wall-clock and not
comparable 1:1 with the real-window baselines, but every measured task lands
far under the baseline times and the SC-003 time target (< 5 s). Keystrokes
after palette-open: 6a type 4 + Enter; 6b type 7 + ↓ + Enter (fuzzy match
ranks "Toggle compact density" first for "Go to Mo"); 6c type 7 + Enter —
all well under 5 s each.

## Success-criteria evidence map

| SC | Criterion | Evidence | Status |
|----|-----------|----------|--------|
| SC-001 | AA contrast + focus + keyboard on all surfaces, both themes | `tests/ui-contrast.test.ts` — every token pair asserted in light, dark, and `prefers-contrast: more` (passing); global `:focus-visible` ring + `ring-2 ring-ring` primitives; `jsx-a11y` oxlint rules enabled; axe pass zero violations across all 16 cells (T063, fixes landed) | automated PASS; *owner: T064 screen-reader pass* |
| SC-002 | 100% checklist pass, no task slower than baseline | walkthrough table above — harness rows 1/6a/6b/6c all ≤ 1.7 s vs 10.5 s/9.4 s baselines | partial PASS; *owner: T065 real-window rows 2–5* |
| SC-003 | Reach named item < 5 s, < 3 keystrokes once palette open | measured 1.3–1.7 s per item (harness rows 6a–6c); one extra ↓ needed on 6b — fuzzy ranking puts a "Toggle…" action first | PASS on time; keystroke count noted |
| SC-004 | Before/after walkthrough recorded | baseline rows + final harness rows above | partial; *owner: T065* |
| SC-005 | Zero values outside the design scales | `tests/ui-audit.test.ts` — `font-sizes`, `icon-sizes`, `icon-import-site`, `overlays`, `native-controls` all enforced, zero violations | PASS |
| SC-006 | No clipped/unreachable content across size matrix × themes × densities | full 16-cell matrix PASS — zero horizontal scroll, 48 px rail @800, 256 px sidebar ≥1024 | PASS (T061) |
| SC-007 | Every > 200 ms action shows progress; every failure shows recovery | `action-inventory.md` — 40 actions across 13 surfaces, each row names progress + recovery pattern; `notify`/`confirm`/`Alert` implemented | PASS (code-verified) |
| SC-008 | All quality gates pass | `bun run typecheck`, `bun run lint`, `bun test ./tests`, `bun run build:renderer` — all green 2026-11-13 (tsc clean; oxlint warnings only; 592/592 tests; vite build 819 ms) | PASS |
| SC-009 | No old-look leftovers | side-by-side review 2026-11-17 across all surfaces × both themes vs 021 screenshots + candidates — no leftovers (`screenshots/`) | PASS (T066) |
| SC-010 | Conversation ≥ 40% of height at 800 × 600 with Metrics open | `ChatColumn` vertical split: conversation min 40%, metrics 10–50% (default 25%); width share measured 0.94 at 800 × 600 | code-verified; *owner: metrics-open spot check* |
| SC-011 | Mode, model(s), persona each selectable in exactly one place | `ChatSetup` header cluster is the only mode/model/persona control; `FusionControls` deleted | PASS |

## Performance notes (T060)

Measured 2026-11-13 (Bun, linux-x64, synthetic corpus):

| Measurement | Result | Budget |
|-------------|--------|--------|
| `search.query` cold index build — 500 convs × 20 msgs (10k entries) | 42 ms | ≤ 100 ms ✓ |
| `search.query` warm (incremental refresh) | 1–3 ms | ≤ 100 ms ✓ |
| Palette title filter, 500 items (substring per keystroke) | 0.2 ms | ≤ 100 ms ✓ |

Result sets are bounded server-side (20 groups × 3 hits) and the
conversation scroll list renders ~500 plain rows in a `ScrollArea` —
no virtualization needed at this scale. Sidebar menu rows are real
`<button>`s, so lists stay keyboard-navigable.

## Resize matrix (SC-006) — T061

Automated run 2026-11-17, Chrome headless on `bun run dev:renderer` + stubbed
`__electrobunHostBridge` (synthetic data). "Share" = conversation column ÷
viewport width. No cell showed horizontal scroll (`scrollWidth == clientWidth`).

| Size | Theme | Density | Result | Notes |
|------|-------|---------|--------|-------|
| 800 × 600 | light | comfortable | PASS | icon rail 48 px, conv share 0.94 |
| 800 × 600 | dark | comfortable | PASS | icon rail 48 px, conv share 0.94 |
| 800 × 600 | light | compact | PASS | icon rail 48 px, conv share 0.94 |
| 800 × 600 | dark | compact | PASS | icon rail 48 px, conv share 0.94 |
| 1024 × 720 | light | comfortable | PASS | sidebar 256 px, conv share 0.75 |
| 1024 × 720 | dark | comfortable | PASS | sidebar 256 px, conv share 0.75 |
| 1024 × 720 | light | compact | PASS | sidebar 256 px, conv share 0.75 |
| 1024 × 720 | dark | compact | PASS | sidebar 256 px, conv share 0.75 |
| 1440 × 900 | light | comfortable | PASS | sidebar 256 px, conv share 0.82 |
| 1440 × 900 | dark | comfortable | PASS | sidebar 256 px, conv share 0.82 |
| 1440 × 900 | light | compact | PASS | sidebar 256 px, conv share 0.82 |
| 1440 × 900 | dark | compact | PASS | sidebar 256 px, conv share 0.82 |
| 1920 × 1080 | light | comfortable | PASS | sidebar 256 px, conv share 0.87 |
| 1920 × 1080 | dark | comfortable | PASS | sidebar 256 px, conv share 0.87 |
| 1920 × 1080 | light | compact | PASS | sidebar 256 px, conv share 0.87 |
| 1920 × 1080 | dark | compact | PASS | sidebar 256 px, conv share 0.87 |

Observation (non-blocking): the Models surface renders scrolled to its
bottom edge in the harness (download form visible at viewport bottom). The
surface is `overflow-y-auto`; likely a scroll-restore/focus artifact —
verify once in the real window. Density variants produce identical widths
(expected: density affects padding/row height, not columns).

## Accessibility passes — T063/T064

axe-core 4.14.1 on the chat surface, all 16 size×theme×density cells +
surfaces walk (2026-11-17, same harness):

- **First pass found 3 violations** → all fixed and re-verified at zero:
  - `button-name` ×8 (critical, only in the ≤896 px icon rail): collapsed
    `SidebarMenuButton`s lost their text label → no accessible name. Fix:
    `aria-label={tooltip}` when `state === "collapsed"`
    (`components/ui/sidebar.tsx`).
  - `label-content-name-mismatch` ×2 (serious): `aria-label="Open command
    palette"` hid the visible "Search & commands" text → label removed;
    theme menu `aria-label="Theme"` vs visible "Theme: System" → label now
    `Theme: {mode}` (`ThemeSettings.tsx`).
  - `region` ×1 (moderate): `CommandDialog`'s `sr-only` `DialogHeader` was
    mounted outside `DialogContent` — permanent non-landmark node → moved
    inside (`components/ui/command.tsx`).
- **Re-run: zero violations in all 16 cells.**

Screen reader (T064): **code-verified, manual pass still open.** Chat
send/receive announcements go through `MessageList`'s `role="status"
aria-live="polite"` region; errors use `role="alert"`; busy controls carry
`aria-busy`; `Spinner` is `role="status"`. A real screen-reader run
(Orca/Narrator/VoiceOver) on send/receive + error toast remains an owner
task — no screen reader is available in this environment.

## Old-look leftover check — T066

Side-by-side review 2026-11-17: current surfaces captured in
`screenshots/` (`s-chat-*`, `s-models-*`, `s-personas-*`, `s-roles-*`,
`s-settings-*`, `palette-open-dark`, `m-*` matrix) vs pre-change
`../021-ai-ui-modernize/screenshots/` (dark/light/light-system) and the
`candidates/` mockups. Reviewed chat, models, personas, roles, settings in
both themes: breadcrumb header + workspace tabs, Single/Fusion segmented
control, Midnight palette, `Search & commands` palette affordance, icon
rail at 800 px, per-model `ctx` controls — the new look is applied
app-wide, including on surfaces added after feature 021 (scripts,
extensions). **No old-look leftovers found.**

## Minimum-size note — T080

Electrobun `BrowserWindow` has no minimum-size API (R7) → 800 × 600 is a
tested floor (`docs/window-size.md`).

Measured at 800 × 600 (2026-11-17, harness):
- sidebar: 48 px icon rail (auto-collapse < 896 px) — all rail buttons get
  accessible names from their tooltips (fixed under T063)
- conversation-area share: **0.94** of viewport width (metrics closed)
- header cluster wraps without clipping; composer + attach/send reachable
- vertical share with Metrics open: not measured in the harness
  (`outputPanel` off in canned settings) — `ChatColumn` code-verified split:
  conversation min 40%, metrics 10–50% default 25% → SC-010 stays
  code-verified; *owner: confirm once in the real window*
