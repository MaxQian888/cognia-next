#!/usr/bin/env node

import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

export function withFailFastDev(args) {
  if (args[0] !== "dev") return args

  const separator = args.indexOf("--")
  const tauriArgs = separator === -1 ? args : args.slice(0, separator)
  if (tauriArgs.includes("--exit-on-panic") || tauriArgs.includes("--no-watch")) return args

  return ["dev", "--exit-on-panic", ...args.slice(1)]
}

/**
 * `tauri-build` re-stages every `bundle.resources` entry each time the build
 * script runs, with an unconditional per-file `std::fs::copy`. The list expands
 * to ~156k `rerun-if-changed` paths, 98% of them under `sidecar/node_modules`,
 * which costs minutes of almost entirely kernel time per run. `beforeDevCommand`
 * gates the dev server behind that copy, so on a cold cache the wait outlives
 * Tauri's 180s frontend timeout and `tauri dev` aborts before Next.js starts.
 *
 * A development build reads none of the staged payload: every `resource_dir()`
 * consumer falls back to the checkout — `claude::sidecar::sidecar_dir`,
 * `node_runtime::bundled_candidates`, `pi_extension` (which reuses
 * `sidecar_dir`), `hooks::builtin::builtin_base_dir`, and
 * `cognia-terminal::terminal_script_dir`. Emptying the list makes all five
 * resolve from the repo. Packaged bundles and `pnpm tauri build` are untouched
 * and still stage the real resources.
 *
 * Must stay byte-identical to `HEADLESS_TAURI_CONFIG` in `scripts/dev/headless.mjs`:
 * `tauri-build` declares `rerun-if-env-changed=TAURI_CONFIG`, so a differing
 * value would give a headless build and a desktop dev build separate build-script
 * fingerprints and make each switch between them pay the copy again.
 */
export const DEV_TAURI_CONFIG = JSON.stringify({ bundle: { resources: [] } })

/**
 * Empty `bundle.resources` for `tauri dev` only. An explicit `TAURI_CONFIG`
 * already in the environment wins — `scripts/dev/headless.mjs` and any manual
 * override set one deliberately.
 */
export function withDevResourceEnv(args, env) {
  if (args[0] !== "dev") return env
  if (env.TAURI_CONFIG) return env
  return { ...env, TAURI_CONFIG: DEV_TAURI_CONFIG }
}

/**
 * `tauri dev` starts its fixed 180s frontend wait the moment it spawns
 * `beforeDevCommand`, and that chain cargo-builds the helper binaries
 * (`cognia-server`, the external-agent launcher, the bootstrap agent) before
 * `pnpm dev` ever binds the port. When the Rust cache is cold or a shared crate
 * changed, compiling them spends the whole budget and the CLI aborts with
 * "Could not connect to `http://localhost:3000/` after 180s" while cargo is
 * still running.
 *
 * The wrapper runs those cargo steps first, before the CLI's clock starts, with
 * the same environment `tauri dev` passes down (`TAURI_CONFIG` is part of the
 * `src-tauri` build-script fingerprint). The copies inside `beforeDevCommand`
 * then finish as fingerprint no-ops in a second or two, so the wait only covers
 * `predev` and Next.js startup. `beforeDevCommand` keeps the steps so a direct
 * `tauri dev` or the system-node launcher still prepares everything.
 *
 * Only `pnpm <script>` steps whose package script is a `cargo build` qualify:
 * cargo is the step whose cost can exceed the timeout, and the only one whose
 * second run is free.
 */
export function cargoPrepareScripts(beforeDevCommand, scripts) {
  if (typeof beforeDevCommand !== "string") return []
  return beforeDevCommand
    .split("&&")
    .map((step) => /^pnpm (?:run )?([\w:.-]+)$/.exec(step.trim())?.[1])
    .filter((name) => name && /^cargo build\b/.test(scripts[name] ?? ""))
}

function readConfigOverride(value, root) {
  const trimmed = value.trim()
  if (trimmed.startsWith("{")) return JSON.parse(trimmed)
  const file = path.resolve(root, trimmed)
  if (!file.endsWith(".json") || !existsSync(file)) {
    throw new Error(`unsupported --config value: ${value}`)
  }
  return JSON.parse(readFileSync(file, "utf8"))
}

/**
 * The `beforeDevCommand` a `tauri dev` invocation will run: the base config,
 * overridden by any `--config` passed before the `--` separator (later wins, as
 * in the CLI). Returns `null` when an override cannot be read here (JSON5/TOML),
 * so the caller skips the cargo pre-step instead of guessing.
 */
export function resolveBeforeDevCommand(args, baseConfig, root) {
  const separator = args.indexOf("--")
  const tauriArgs = separator === -1 ? args : args.slice(0, separator)
  let command = baseConfig.build?.beforeDevCommand

  for (let index = 0; index < tauriArgs.length; index++) {
    const arg = tauriArgs[index]
    let value
    if (arg === "--config" || arg === "-c") value = tauriArgs[++index]
    else if (arg.startsWith("--config=")) value = arg.slice("--config=".length)
    else continue
    if (value === undefined) return null

    let override
    try {
      override = readConfigOverride(value, root)
    } catch {
      return null
    }
    const overridden = override?.build?.beforeDevCommand
    if (overridden !== undefined) {
      command = typeof overridden === "string" ? overridden : overridden?.script
    }
  }

  return typeof command === "string" ? command : null
}

export function devPrepareScripts(args, root) {
  if (args[0] !== "dev") return []
  const separator = args.indexOf("--")
  const tauriArgs = separator === -1 ? args : args.slice(0, separator)
  if (tauriArgs.includes("--help") || tauriArgs.includes("-h")) return []

  const config = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"))
  const { scripts } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
  return cargoPrepareScripts(resolveBeforeDevCommand(args, config, root), scripts ?? {})
}

function runPnpmScript(name, { cwd, env }) {
  const isWindows = process.platform === "win32"
  const child = spawn(isWindows ? "pnpm.cmd" : "pnpm", ["run", name], {
    cwd,
    env,
    shell: isWindows,
    stdio: "inherit",
  })

  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({ code, signal }))
  })
}

export async function runTauri(args, { env = process.env } = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
  const childEnv = withDevResourceEnv(args, env)

  for (const name of devPrepareScripts(args, root)) {
    const result = await runPnpmScript(name, { cwd: root, env: childEnv })
    if (result.signal || result.code !== 0) return result
  }

  const require = createRequire(import.meta.url)
  const tauriCli = require.resolve("@tauri-apps/cli/tauri.js")
  // The wrapper runs the installed CLI; launching must not trigger pnpm's implicit install.
  const child = spawn(process.execPath, [tauriCli, ...withFailFastDev(args)], {
    cwd: root,
    env: childEnv,
    stdio: "inherit",
  })

  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({ code, signal }))
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runTauri(process.argv.slice(2))
  if (result.signal) process.kill(process.pid, result.signal)
  process.exit(result.code ?? 1)
}
