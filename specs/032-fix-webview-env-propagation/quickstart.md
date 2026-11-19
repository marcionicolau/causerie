# Quickstart: validating #55

## Automated

```sh
bun test tests/bun/linux-webkit-env.test.ts
bun run typecheck && bun run lint
```

Expected: all pass, including the end-to-end test that reads `WEBKIT_DISABLE_DMABUF_RENDERER` back through libc `getenv` after `applyLinuxWebviewEnv`.

## Manual (NVIDIA + Wayland machine)

1. `bun run package` (or take the CI canary artifact).
2. Run the launcher with a fresh data dir and `env -u WEBKIT_DISABLE_DMABUF_RENDERER`.
3. Expect: UI paints; no `Failed to create GBM buffer` in the log.
4. Repeat with `WEBKIT_DISABLE_DMABUF_RENDERER=0`: workaround must not apply (user value kept).
5. Record results (machine, GPU, driver, distro) on issue #55; request a second machine.
