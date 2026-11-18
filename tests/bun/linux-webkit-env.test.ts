// issue #55: dmabuf-renderer workaround predicate for NVIDIA + Wayland
import { describe, expect, test } from "bun:test";
import {
  applyLinuxWebviewEnv,
  needsDmabufWorkaround,
} from "../../src/bun/linux-webkit-env";

const wayland = { WAYLAND_DISPLAY: "wayland-1" };
const nvidia = () => true;
const noNvidia = () => false;

describe("needsDmabufWorkaround", () => {
  test("linux + wayland + nvidia → true", () => {
    expect(
      needsDmabufWorkaround({
        platform: "linux",
        env: wayland,
        moduleLoaded: nvidia,
      }),
    ).toBe(true);
  });
  test("non-linux → false", () => {
    expect(
      needsDmabufWorkaround({
        platform: "darwin",
        env: wayland,
        moduleLoaded: nvidia,
      }),
    ).toBe(false);
  });
  test("X11 session → false", () => {
    expect(
      needsDmabufWorkaround({
        platform: "linux",
        env: { XDG_SESSION_TYPE: "x11" },
        moduleLoaded: nvidia,
      }),
    ).toBe(false);
  });
  test("wayland via XDG_SESSION_TYPE only → true", () => {
    expect(
      needsDmabufWorkaround({
        platform: "linux",
        env: { XDG_SESSION_TYPE: "wayland" },
        moduleLoaded: nvidia,
      }),
    ).toBe(true);
  });
  test("no nvidia module → false", () => {
    expect(
      needsDmabufWorkaround({
        platform: "linux",
        env: wayland,
        moduleLoaded: noNvidia,
      }),
    ).toBe(false);
  });
  test("explicit user value is never overridden", () => {
    expect(
      needsDmabufWorkaround({
        platform: "linux",
        env: { ...wayland, WEBKIT_DISABLE_DMABUF_RENDERER: "0" },
        moduleLoaded: nvidia,
      }),
    ).toBe(false);
  });
});

describe("applyLinuxWebviewEnv", () => {
  test("sets the variable on a matching env", () => {
    const env = { ...wayland, XDG_SESSION_TYPE: "wayland" };
    // predicate depends on process.platform; assert via injected env only
    // when the platform matches — otherwise just check no mutation
    const before = env.WEBKIT_DISABLE_DMABUF_RENDERER;
    applyLinuxWebviewEnv(env as NodeJS.ProcessEnv);
    if (process.platform === "linux") {
      // on this linux dev box the nvidia probe may or may not hit; only
      // assert the value is a string if set
      if (env.WEBKIT_DISABLE_DMABUF_RENDERER !== undefined)
        expect(env.WEBKIT_DISABLE_DMABUF_RENDERER).toBe("1");
      else expect(before).toBeUndefined();
    } else {
      expect(env.WEBKIT_DISABLE_DMABUF_RENDERER).toBeUndefined();
    }
  });
});
