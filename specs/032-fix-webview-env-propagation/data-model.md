# Data Model

No persisted data. Runtime state only:

- **WorkaroundCondition** = `platform === "linux"` ∧ (`WAYLAND_DISPLAY` truthy ∨ `XDG_SESSION_TYPE === "wayland"`) ∧ `/sys/module/nvidia` exists ∧ `WEBKIT_DISABLE_DMABUF_RENDERER === undefined`.
- **Effect** when true: `process.env.WEBKIT_DISABLE_DMABUF_RENDERER = "1"` and libc `setenv(..., "1", 1)`.
- **Result**: `applyLinuxWebviewEnv` returns the condition boolean; native failure does not change it.
