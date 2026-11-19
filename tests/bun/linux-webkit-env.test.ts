// issue #55: dmabuf-renderer workaround predicate for NVIDIA + Wayland
import { describe, expect, spyOn, test } from "bun:test";
import {
  applyLinuxWebviewEnv,
  libcSetenv,
  needsDmabufWorkaround,
} from "../../src/bun/linux-webkit-env";

const wayland = { WAYLAND_DISPLAY: "wayland-1" };
const nvidia = () => true;
const noNvidia = () => false;

// Reads the real C environment (what WebKitGTK sees), unlike process.env.
const libcEnv = () => {
  const { dlopen, FFIType, CString } = require("bun:ffi") as typeof import("bun:ffi");
  const libc = dlopen("libc.so.6", {
    getenv: { args: [FFIType.cstring], returns: FFIType.ptr },
    unsetenv: { args: [FFIType.cstring], returns: FFIType.i32 },
  });
  return {
    get(name: string): string | null {
      const p = libc.symbols.getenv(Buffer.from(`${name}\0`));
      return p ? String(new CString(p)) : null;
    },
    unset(name: string): void {
      libc.symbols.unsetenv(Buffer.from(`${name}\0`));
    },
  };
};

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

  test.each(["0", "1", ""])(
    "preset value %p is left alone in both environments",
    (value) => {
      const env: NodeJS.ProcessEnv = {
        ...wayland,
        WEBKIT_DISABLE_DMABUF_RENDERER: value,
      };
      const calls: [string, string][] = [];
      expect(
        applyLinuxWebviewEnv(env, (n, v) => (calls.push([n, v]), true), probe),
      ).toBe(false);
      expect(env.WEBKIT_DISABLE_DMABUF_RENDERER).toBe(value);
      expect(calls).toEqual([]);
    },
  );

  test("running twice is idempotent", () => {
    const env: NodeJS.ProcessEnv = { ...wayland };
    const calls: [string, string][] = [];
    const native = (n: string, v: string) => (calls.push([n, v]), true);
    expect(applyLinuxWebviewEnv(env, native, probe)).toBe(true);
    // second run sees the variable already set, so it must not touch anything
    expect(applyLinuxWebviewEnv(env, native, probe)).toBe(false);
    expect(env.WEBKIT_DISABLE_DMABUF_RENDERER).toBe("1");
    expect(calls).toEqual([["WEBKIT_DISABLE_DMABUF_RENDERER", "1"]]);
  });

  test("a failing native setenv does not break startup and warns once", () => {
    const env: NodeJS.ProcessEnv = { ...wayland };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(applyLinuxWebviewEnv(env, () => false, probe)).toBe(true);
      expect(env.WEBKIT_DISABLE_DMABUF_RENDERER).toBe("1");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(
        "native setenv failed",
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("a throwing native setenv does not propagate", () => {
    const env: NodeJS.ProcessEnv = { ...wayland };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const boom = () => {
        throw new Error("dlopen failed");
      };
      expect(applyLinuxWebviewEnv(env, boom, probe)).toBe(true);
      expect(env.WEBKIT_DISABLE_DMABUF_RENDERER).toBe("1");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test.each(["darwin", "win32"])(
    "%s: native setter never called and no warning",
    (platform) => {
      const env: NodeJS.ProcessEnv = { ...wayland };
      const calls: [string, string][] = [];
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(
          applyLinuxWebviewEnv(env, (n, v) => (calls.push([n, v]), true), {
            platform,
            moduleLoaded: nvidia,
          }),
        ).toBe(false);
        expect(calls).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
  );
});

// Issue #55 end to end: the variable must reach the C environment (getenv),
// not only process.env.
describe.skipIf(process.platform !== "linux")("applyLinuxWebviewEnv (real libc)", () => {
  const NAME = "WEBKIT_DISABLE_DMABUF_RENDERER";
  const probe = { platform: "linux", moduleLoaded: nvidia };

  test("real libcSetenv exposes WEBKIT_DISABLE_DMABUF_RENDERER=1 to getenv", () => {
    const c = libcEnv();
    c.unset(NAME);
    try {
      expect(c.get(NAME)).toBeNull();
      expect(applyLinuxWebviewEnv({ ...wayland }, libcSetenv, probe)).toBe(true);
      expect(c.get(NAME)).toBe("1");
    } finally {
      c.unset(NAME);
    }
  });

  test("regression #57: a no-op native setter leaves getenv empty", () => {
    const c = libcEnv();
    c.unset(NAME);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const env: NodeJS.ProcessEnv = { ...wayland };
      applyLinuxWebviewEnv(env, () => false, probe);
      expect(env[NAME]).toBe("1");
      expect(c.get(NAME)).toBeNull();
    } finally {
      warn.mockRestore();
      c.unset(NAME);
    }
  });
});

// The reason for the native call (issue #55): Bun's process.env is not libc's environ.
describe.skipIf(process.platform !== "linux")("libcSetenv (real libc)", () => {
  const getenv = (name: string): string | null => libcEnv().get(name);

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
