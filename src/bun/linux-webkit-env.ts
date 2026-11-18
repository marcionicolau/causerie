// issue #55: WebKitGTK's dmabuf renderer fails to allocate GBM buffers on
// NVIDIA + Wayland (packaged builds → blank window, "Failed to create GBM
// buffer"). WEBKIT_DISABLE_DMABUF_RENDERER=1 forces the fallback renderer.
// Applied only when all three hold: Linux, a Wayland session, and the
// proprietary nvidia module loaded (/sys/module/nvidia). An explicit user
// value is never overridden.
import { existsSync } from "node:fs";

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
): boolean {
  const ok = needsDmabufWorkaround({ platform: process.platform, env });
  if (ok) env.WEBKIT_DISABLE_DMABUF_RENDERER = "1";
  return ok;
}
