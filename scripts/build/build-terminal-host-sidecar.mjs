#!/usr/bin/env node

import { chmodSync, copyFileSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, "../..")

export function parseRustHost(output) {
  const host = output.match(/^host:\s*(\S+)$/m)?.[1]
  if (!host) throw new Error("rustc did not report a host target triple")
  return host
}

export function sidecarPaths(root, target, targetDir = join(root, "target")) {
  const extension = target.includes("windows") ? ".exe" : ""
  return {
    source: join(targetDir, "release", `cognia-server${extension}`),
    destination: join(root, "src-tauri", "binaries", `cognia-server-${target}${extension}`),
  }
}

export function cargoBuildEnvironment(base = process.env) {
  let tauriConfig = {}
  if (base.TAURI_CONFIG) {
    try {
      tauriConfig = JSON.parse(base.TAURI_CONFIG)
    } catch {
      throw new Error("TAURI_CONFIG must contain valid JSON")
    }
  }
  return {
    ...base,
    TAURI_CONFIG: JSON.stringify({
      ...tauriConfig,
      bundle: { ...(tauriConfig.bundle ?? {}), externalBin: [] },
    }),
  }
}

export function prepareTerminalHostSidecar({
  root = projectRoot,
  target = process.env.TAURI_ENV_TARGET_TRIPLE ?? process.env.CARGO_BUILD_TARGET,
  targetDir = process.env.CARGO_TARGET_DIR,
  run = spawnSync,
} = {}) {
  let resolvedTarget = target
  if (!resolvedTarget) {
    const rustc = run("rustc", ["-vV"], { cwd: root, encoding: "utf8" })
    if (rustc.status !== 0) {
      throw new Error(`rustc -vV failed: ${rustc.stderr || rustc.error || "unknown error"}`)
    }
    resolvedTarget = parseRustHost(rustc.stdout)
  }

  const buildArgs = [
    "build",
    "--manifest-path",
    join(root, "src-tauri", "Cargo.toml"),
    "--release",
    "--bin",
    "cognia-server",
  ]
  if (target) buildArgs.push("--target", resolvedTarget)
  const build = run("cargo", buildArgs, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    env: cargoBuildEnvironment(),
  })
  if (build.status !== 0) throw new Error("building cognia-server failed")

  const effectiveTargetDir = targetDir
    ? resolve(root, targetDir)
    : target
      ? join(root, "target", resolvedTarget)
      : join(root, "target")
  const paths = sidecarPaths(root, resolvedTarget, effectiveTargetDir)
  mkdirSync(dirname(paths.destination), { recursive: true })
  copyFileSync(paths.source, paths.destination)
  if (!resolvedTarget.includes("windows")) chmodSync(paths.destination, 0o755)
  return { target: resolvedTarget, ...paths }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = prepareTerminalHostSidecar()
    console.log(`Prepared terminal host sidecar: ${result.destination}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
