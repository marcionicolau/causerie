#!/usr/bin/env bash
# Build llama_shim + llama.cpp deps into native/out/<platform>/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# FR-004: fail fast naming the missing prerequisite (not a cmake/compiler dump)
missing=()
command -v bun   >/dev/null || missing+=("bun")
command -v cmake >/dev/null || missing+=("cmake")
command -v cc    >/dev/null || command -v c++ >/dev/null || command -v gcc >/dev/null || command -v clang >/dev/null || missing+=("c++ toolchain (gcc/clang)")

# feature 029: GPU backend needs the Vulkan SDK on Linux/Windows
# (headers + glslc shader compiler + SPIRV-Headers). macOS needs nothing
# extra (Metal ships with the OS). CAUSERIE_GPU=off skips the requirement
# and produces a CPU-only build.
GPU_ARGS=()
if [ "${CAUSERIE_GPU:-on}" != "off" ] && [ "$(uname -s)" != "Darwin" ]; then
  command -v glslc >/dev/null || missing+=("Vulkan SDK (glslc + vulkan-headers + SPIRV-Headers) — or set CAUSERIE_GPU=off")
fi
if ((${#missing[@]})); then
  echo "missing prerequisite: ${missing[*]}" >&2
  exit 1
fi
if [ "${CAUSERIE_GPU:-on}" = "off" ]; then
  GPU_ARGS+=(-DGGML_VULKAN=OFF)
fi

case "$(uname -s)" in
  Linux)   OS="linux" ;;
  Darwin)  OS="darwin" ;;
  *)       echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)           echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

PLATFORM="${OS}-${ARCH}"
# cmake tree lives outside native/out/ — only the staged libs are packaged
BUILD_DIR="${ROOT}/native/build/${PLATFORM}"

cmake -S "${ROOT}/src/native/shim" -B "${BUILD_DIR}" -DCMAKE_BUILD_TYPE=Release "${GPU_ARGS[@]}"
cmake --build "${BUILD_DIR}" -j "$(nproc 2>/dev/null || sysctl -n hw.ncpu)"

bun "${ROOT}/scripts/stage-native.ts" "${BUILD_DIR}" "${ROOT}/native/out/${PLATFORM}"
echo "staged native artifacts -> native/out/${PLATFORM}"
