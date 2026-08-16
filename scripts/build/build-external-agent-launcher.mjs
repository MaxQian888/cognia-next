#!/usr/bin/env node

/**
 * Stage `cognia-external-agent-launcher` as a Tauri sidecar.
 *
 * The desktop refuses to spawn an external agent unless it can wrap the launch
 * in this launcher (`crates/cognia-external-agent/src/sandbox.rs`). Until the
 * binary is bundled, that refusal is the only thing a packaged app can do — so
 * this script is a build-time requirement, not an optimization.
 *
 * Mirrors `build-terminal-host-sidecar.mjs` exactly: same target-triple
 * resolution, same `binaries/<name>-<triple>` layout Tauri's `externalBin`
 * expects, same `TAURI_CONFIG` scrubbing so a nested cargo build does not
 * recurse into sidecar preparation.
 */

import { chmodSync, copyFileSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

import { cargoBuildEnvironment, parseRustHost } from "./build-terminal-host-sidecar.mjs"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, "../..")

export const LAUNCHER_BIN = "cognia-external-agent-launcher"

export function launcherPaths(root, target, targetDir = join(root, "target")) {
  const extension = target.includes("windows") ? ".exe" : ""
  return {
    source: join(targetDir, "release", `${LAUNCHER_BIN}${extension}`),
    destination: join(root, "src-tauri", "binaries", `${LAUNCHER_BIN}-${target}${extension}`),
  }
}

export function prepareExternalAgentLauncher({
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

  const buildArgs = ["build", "-p", "cognia-automation", "--bin", LAUNCHER_BIN, "--release"]
  if (target) buildArgs.push("--target", resolvedTarget)
  const build = run("cargo", buildArgs, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    env: cargoBuildEnvironment(),
  })
  if (build.status !== 0) throw new Error(`building ${LAUNCHER_BIN} failed`)

  const effectiveTargetDir = targetDir
    ? resolve(root, targetDir)
    : target
      ? join(root, "target", resolvedTarget)
      : join(root, "target")
  const paths = launcherPaths(root, resolvedTarget, effectiveTargetDir)
  mkdirSync(dirname(paths.destination), { recursive: true })
  copyFileSync(paths.source, paths.destination)
  if (!resolvedTarget.includes("windows")) chmodSync(paths.destination, 0o755)
  return { target: resolvedTarget, ...paths }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = prepareExternalAgentLauncher()
    console.log(`Prepared external-agent sandbox launcher: ${result.destination}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
