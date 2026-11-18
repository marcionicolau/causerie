// issue #55: dmabuf-renderer workaround predicate for NVIDIA + Wayland
import { describe, expect, test } from "bun:test";
import {
  applyLinuxWebviewEnv,
  libcSetenv,
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
  const probe = { platform: "linux", moduleLoaded: nvidia };

  test("matching env: sets process env AND the C environment", () => {
    const env: NodeJS.ProcessEnv = { ...wayland };
    const calls: [string, string][] = [];
    const ok = applyLinuxWebviewEnv(
      env,
      (n, v) => (calls.push([n, v]), true),
      probe,
    );
    expect(ok).toBe(true);
    expect(env.WEBKIT_DISABLE_DMABUF_RENDERER).toBe("1");
    expect(calls).toEqual([["WEBKIT_DISABLE_DMABUF_RENDERER", "1"]]);
  });

  test("no workaround needed: nothing is set anywhere", () => {
    const env: NodeJS.ProcessEnv = { ...wayland };
    const calls: [string, string][] = [];
    const ok = applyLinuxWebviewEnv(
      env,
      (n, v) => (calls.push([n, v]), true),
      { platform: "linux", moduleLoaded: noNvidia },
    );
    expect(ok).toBe(false);
    expect(env.WEBKIT_DISABLE_DMABUF_RENDERER).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("an explicit user value is left alone in both environments", () => {
    const env: NodeJS.ProcessEnv = {
      ...wayland,
      WEBKIT_DISABLE_DMABUF_RENDERER: "0",
    };
    const calls: [string, string][] = [];
    applyLinuxWebviewEnv(env, (n, v) => (calls.push([n, v]), true), probe);
    expect(env.WEBKIT_DISABLE_DMABUF_RENDERER).toBe("0");
    expect(calls).toEqual([]);
  });

  test("a failing native setenv does not break startup", () => {
    const env: NodeJS.ProcessEnv = { ...wayland };
    expect(applyLinuxWebviewEnv(env, () => false, probe)).toBe(true);
    expect(env.WEBKIT_DISABLE_DMABUF_RENDERER).toBe("1");
  });
});

// The reason for the native call (issue #55): Bun's process.env is not libc's environ.
describe.skipIf(process.platform !== "linux")("libcSetenv (real libc)", () => {
  const getenv = (name: string): string | null => {
    const { dlopen, FFIType, CString } = require("bun:ffi") as typeof import("bun:ffi");
    const libc = dlopen("libc.so.6", {
      getenv: { args: [FFIType.cstring], returns: FFIType.ptr },
    });
    const p = libc.symbols.getenv(Buffer.from(`${name}\0`));
    return p ? String(new CString(p)) : null;
  };

  test("a process.env assignment alone is invisible to getenv", () => {
    process.env.CZ_TEST_ONLY_PROCESS_ENV = "x";
    expect(getenv("CZ_TEST_ONLY_PROCESS_ENV")).toBeNull();
    delete process.env.CZ_TEST_ONLY_PROCESS_ENV;
  });

  test("libcSetenv makes the value visible to getenv", () => {
    expect(libcSetenv("CZ_TEST_LIBC_SETENV", "1")).toBe(true);
    expect(getenv("CZ_TEST_LIBC_SETENV")).toBe("1");
  });
});
