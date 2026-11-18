# Causerie

[![ci](https://github.com/marcionicolau/causerie/actions/workflows/ci.yml/badge.svg)](https://github.com/marcionicolau/causerie/actions/workflows/ci.yml)
[![packaging](https://github.com/marcionicolau/causerie/actions/workflows/packaging.yml/badge.svg)](https://github.com/marcionicolau/causerie/actions/workflows/packaging.yml)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?logo=bun&logoColor=white)](https://bun.sh)
[![Electrobun](https://img.shields.io/badge/shell-Electrobun%202.x-8A2BE2)](https://electrobun.dev)
[![TypeScript](https://img.shields.io/badge/lang-TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![llama.cpp](https://img.shields.io/badge/inference-llama.cpp%20in--process-success)](https://github.com/ggml-org/llama.cpp)
[![spec-driven](https://img.shields.io/badge/process-spec--driven%20(Spec%20Kit)-blue)](https://github.com/github/spec-kit)

Local-first AI chat desktop app — an [Electrobun](https://electrobun.dev) 2.x +
[Bun](https://bun.sh) shell with llama.cpp inference running in-process via
`bun:ffi`. No cloud calls: models are local GGUF files, conversations and
settings are local JSON.

> **Causerie** (French, *koz-REE*) — an informal conversation or chat; also a
> short, conversational essay.

<!-- screenshots -->

## Features

- **Local inference** — vendored llama.cpp behind a pull-based C ABI shim
  (`src/native/shim`), streamed tokens over typed Electrobun RPC.
- **Model library** — scans `models/` for GGUF files, parses headers
  in-process, per-model generation overrides, downloads, and a
  benchmark-based advisor (fit verdicts, recommended ctx) before loading.
- **Roles & fusion mode** — bind tags to models with ordered fallback chains
  (max 3); a two-phase plan→answer turn can split planner and executor across
  different models.
- **Conversation branching** — regenerate/edit creates sibling variants, not
  destructive resets; variant picker and branch overview in the UI.
- **Personas & prompt presets** — system prompts and `/`-picker snippets,
  cascaded `DEFAULT < global < persona < modelOverride < tag`.
- **Attachments** — pick local files into a turn; budgeted, line-truncated
  injection with per-file status.
- **Sandboxed tool use** — models can emit `read_file`/`list_dir` calls
  confined to a configured root, with ask/allow/deny policy.
- **Search, export & backup** — instant title+content search with hit
  highlighting; versioned JSON envelopes (conversations, settings, tags) and
  Markdown rendering.
- **KV-state persistence** — snapshot/restore KV cache per conversation so
  follow-ups skip re-prefill across restarts.
- **Output stats panel** — per-call token/latency metrics grouped by model,
  role and persona.
- **Auto-update** — packaged builds check a channel-scoped release feed on
  launch, download verified (`tarSha256`) bundles in the background, and
  apply on explicit restart; stable/canary channel selection, silent
  offline degradation, fully disableable (`AI_DESKTOP_APP_UPDATE=off`).
  The feed is the app's only update-network surface — see `docs/updates.md`.

## Workstation setup

Everything needed to develop, test, and build. Linux (x64/arm64) and macOS
are supported natively; Windows uses `scripts/build-native.ps1` (configured,
not CI-verified — see `docs/packaging.md`).

### Required software

| Tool | Why |
|------|-----|
| **git** | clone with submodules — llama.cpp is vendored at `src/native/vendor/llama.cpp` |
| **[Bun](https://bun.sh) ≥ 1.4** | runtime, package manager, script runner |
| **cmake + C++ toolchain** | build the llama.cpp FFI shim (`build-native.sh` fails fast naming what's missing) — gcc/clang on Linux/macOS, MSVC or clang-cl on Windows |
| **Hutch CLI on PATH** | runs `dev`/`build` tasks from `hutch.config.ts` — installed into `~/.hutch/bin` by its own installer (see below) |
| **zstd** | `scripts/verify-artifact.sh` inspects packaged `Resources/*.tar.zst` bundles |
| **A GGUF model** in `models/` | run the app; FFI test suites self-skip without one |

Optional but recommended: **ccache** (llama.cpp picks it up automatically via
`GGML_CCACHE` — much faster native rebuilds) and the
[**gh** CLI](https://cli.github.com) (`gh-install.sh` installs published
canary builds; releases are pushed as git tags). A desktop session
(X11/Wayland) is required for `bun run dev` — the app is a real window.

Package hints: Debian/Ubuntu `sudo apt install cmake build-essential zstd
ccache`; Fedora `sudo dnf install cmake gcc-c++ zstd ccache`; macOS
`xcode-select --install && brew install cmake zstd ccache`.

### First-time setup

```bash
git clone --recurse-submodules <repo-url>   # or: git submodule update --init
cd causerie
bun install

# Hutch launcher → ~/.hutch/bin/hutch (paired with the pinned electrobun)
curl -fsSL https://hutch.blackboard.sh/hutch/install.sh | sh
export PATH="$HOME/.hutch/bin:$PATH"        # add to your shell profile too

bun x electrobun prepare    # downloads the pinned toolchain into ~/.hutch
                            # and projects the SDK into .hutch/devkit
bun run build:native        # cmake → native/out/<platform>/
```

Optional test/dev model (same one CI caches — enables the FFI suites):

```bash
mkdir -p models
curl -fL -o models/SmolLM2-135M-Instruct-Q4_K_M.gguf \
  https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF/resolve/main/SmolLM2-135M-Instruct-Q4_K_M.gguf
```

### Verify the setup

```bash
bun run typecheck && bun run lint && bun test ./tests
bun run dev                 # opens the app window
```

Re-run `bun x electrobun prepare` after bumping `electrobun` —
`.hutch/devkit` is generated and git-ignored.

## Development

| Task | Command |
|------|---------|
| Dev (window + HMR) | `bun run dev` |
| Typecheck | `bun run typecheck` |
| Lint | `bun run lint` |
| Test | `bun test ./tests` (scoped — never bare `bun test`) |
| Native libs | `bun run build:native` |
| Renderer build | `bun run build:renderer` |
| Full canary package | `bun run package` |
| Full stable package | `bun run package:stable` |

CI: `.github/workflows/ci.yml` runs typecheck/lint/tests on `main` and PRs.

## Releases

The git tag is the source of truth — pushing a `v*` tag runs
`.github/workflows/packaging.yml`, which builds per-platform artifacts and
publishes a GitHub Release:

- `bun run release:stag` — tag `vX.Y.Z-rc.N` → canary-channel build, marked
  prerelease.
- `bun run release:prod` — promote the validated rc to `vX.Y.Z` (must be at
  the rc's commit) → stable-channel build.
- `bun run release:status` — latest stable tag, open rc train, HEAD.

`SKIP_TESTS=1` and `ASSUME_YES=1` adjust the release script's gates.

## Configuration

| Variable | Purpose |
|----------|---------|
| `MODELS_DIR` | override the GGUF scan directory (default `<userData>/models`) |
| `APP_DATA_DIR` | override the app-data root (store, snapshots, attachments) |
| `RELEASE_CHANNEL` | `canary` (default) or `stable` — version suffix + update channel |
| `VITE_DEV_URL` | dev-mode renderer URL (set by `bun run dev`) |
| `WEBKIT_DISABLE_DMABUF_RENDERER` | Linux only — set to `0`/`1` explicitly to override the automatic NVIDIA + Wayland workaround (the app defaults it to `1` when the `nvidia` module is loaded on a Wayland session; see Troubleshooting) |

### Troubleshooting

**Blank window on Linux (NVIDIA + Wayland)** — WebKitGTK's dmabuf renderer
fails to allocate GBM buffers on some NVIDIA/Wayland setups
(`Failed to create GBM buffer` in the log; window shows a title bar and an
empty body). The app detects this combination and sets
`WEBKIT_DISABLE_DMABUF_RENDERER=1` automatically. If you still see a blank
window, launch with the variable set explicitly:

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=1 ./bin/launcher
```

## Project layout

```
src/bun/        main process — window, RPC handlers, llama FFI engine, stores
src/shared/     RPC contract + domain types shared with the renderer
src/renderer/   React 19 + Tailwind v4 + shadcn UI (Vite)
src/native/     C ABI shim over vendored llama.cpp (cmake)
scripts/        native build, packaging verify, version, release.ts
specs/          Spec Kit feature specs and implementation artifacts
tests/          bun:test suites (FFI suites self-skip without a model)
```

## Spec-driven development

Features are built with [GitHub Spec Kit](https://github.com/github/spec-kit):
every change starts as a reviewed spec, not as code. Artifacts live in
`specs/<NNN>-<short-name>/` on a matching `<NNN>-<short-name>` branch:

| Artifact | Contents |
|----------|----------|
| `spec.md` | stakeholder-facing requirements (user stories, FRs, edge cases) |
| `plan.md` | architecture decisions against the project constitution |
| `tasks.md` | dependency-ordered, testable task breakdown |
| `data-model.md`, `research.md`, `contracts/`, `checklists/` | supporting design docs |

The flow per feature: `speckit-specify` → `speckit-clarify` → `speckit-plan`
→ `speckit-tasks` → `speckit-analyze` → `speckit-implement` →
`speckit-converge`. The project constitution
(`.specify/memory/constitution.md`) gates every plan; conventional commits
land per task via the git auto-commit extension
(`.specify/extensions/git/`).

See `specs/` for shipped features (roles & fusion, conversation branching,
attachments, personas, KV snapshots, sandboxed tools, packaging, …) and
`AGENTS.md` for the module map they produced.

## Contributing

Issues and PRs welcome. Keep `bun run typecheck`, `bun run lint` and
`bun test ./tests` green; feature work follows the Spec Kit flow above.

## License

TBD.
