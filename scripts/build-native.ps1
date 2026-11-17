# Build llama_shim + llama.cpp deps into native/out/win-x64/ (MSVC or clang-cl).
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)

# FR-004: fail fast naming the missing prerequisite
$missing = @()
if (-not (Get-Command bun   -ErrorAction SilentlyContinue)) { $missing += "bun" }
if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) { $missing += "cmake" }
if (-not (Get-Command cl    -ErrorAction SilentlyContinue) -and
    -not (Get-Command clang-cl -ErrorAction SilentlyContinue)) { $missing += "MSVC/clang-cl toolchain" }

# feature 029: GPU backend needs the Vulkan SDK (glslc + headers +
# SPIRV-Headers). CAUSERIE_GPU=off skips the requirement (CPU-only build).
$GpuArgs = @()
if ($env:CAUSERIE_GPU -ne "off") {
  if (-not (Get-Command glslc -ErrorAction SilentlyContinue)) {
    $missing += "Vulkan SDK (glslc + vulkan-headers + SPIRV-Headers) - or set CAUSERIE_GPU=off"
  }
} else {
  $GpuArgs += "-DGGML_VULKAN=OFF"
}
if ($missing.Count -gt 0) { Write-Error "missing prerequisite: $($missing -join ', ')"; exit 1 }

$Platform = "win-x64"
# cmake tree lives outside native/out/ — only the staged libs are packaged
$BuildDir = Join-Path $Root "native/build/$Platform"

cmake -S "$Root/src/native/shim" -B $BuildDir -DCMAKE_BUILD_TYPE=Release @GpuArgs
cmake --build $BuildDir --config Release

bun "$Root/scripts/stage-native.ts" "$BuildDir" "$Root/native/out/$Platform"
Write-Host "staged native artifacts -> native/out/$Platform"
