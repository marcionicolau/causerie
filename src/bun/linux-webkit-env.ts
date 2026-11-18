// issue #55: WebKitGTK's dmabuf renderer fails to allocate GBM buffers on
// NVIDIA + Wayland (packaged builds → blank window, "Failed to create GBM
// buffer"). WEBKIT_DISABLE_DMABUF_RENDERER=1 forces the fallback renderer.
// Applied only when all three hold: Linux, a Wayland session, and the
// proprietary nvidia module loaded (/sys/module/nvidia). An explicit user
// value is never overridden.
//
// Why libc setenv: WebKitGTK reads the C environment (getenv) in the native
// webview process, but assigning to Bun's `process.env` only updates Bun's own
// copy — it never reaches libc's `environ`. Verified on a packaged build:
// the process.env assignment alone left the window blank; calling libc
// `setenv` through bun:ffi made it render. We keep the process.env write too
// (child processes and our own reads) and add the native one.
import { existsSync } from "node:fs";

export type NativeSetenv = (name: string, value: string) => boolean;

/** Set a variable in the C environment of this process. False when libc/bun:ffi is unavailable. */
export const libcSetenv: NativeSetenv = (name, value) => {
  try {
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const libc = dlopen("libc.so.6", {
      setenv: {
        args: [FFIType.cstring, FFIType.cstring, FFIType.i32],
        returns: FFIType.i32,
      },
    });
    return (
      libc.symbols.setenv(
        Buffer.from(`${name}\0`),
        Buffer.from(`${value}\0`),
        1,
      ) === 0
    );
  } catch {
    return false;
  }
};

export function needsDmabufWorkaround(opts: {
  platform: string;
  env: NodeJS.ProcessEnv;
  moduleLoaded?: (name: string) => boolean;
}): boolean {
  const { platform, env } = opts;
  if (platform !== "linux") return false;
  if (env.WEBKIT_DISABLE_DMABUF_RENDERER !== undefined) return false;
  const wayland =
    Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
  if (!wayland) return false;
  const loaded =
    opts.moduleLoaded ?? ((name: string) => existsSync(`/sys/module/${name}`));
  return loaded("nvidia");
}

export function applyLinuxWebviewEnv(
  env: NodeJS.ProcessEnv = process.env,
  native: NativeSetenv = libcSetenv,
  probe: { platform?: string; moduleLoaded?: (name: string) => boolean } = {},
): boolean {
  const ok = needsDmabufWorkaround({
    platform: probe.platform ?? process.platform,
    env,
    moduleLoaded: probe.moduleLoaded,
  });
  if (ok) {
    env.WEBKIT_DISABLE_DMABUF_RENDERER = "1";
    native("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
  }
  return ok;
}
