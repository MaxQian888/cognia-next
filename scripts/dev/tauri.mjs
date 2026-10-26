#!/usr/bin/env node

import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildCogniaCli } from "./ensure-cognia-cli.mjs"

export function withFailFastDev(args) {
  if (args[0] !== "dev") return args

  const separator = args.indexOf("--")
  const tauriArgs = separator === -1 ? args : args.slice(0, separator)
  if (tauriArgs.includes("--exit-on-panic") || tauriArgs.includes("--no-watch")) return args

  return ["dev", "--exit-on-panic", ...args.slice(1)]
}

/**
 * `tauri dev` replaces the app's default features with an explicit list
 * (`--no-default-features --features ocr-paddle`), a different feature set
 * from the one a plain `cargo build` / `cargo test` / rust-analyzer resolves
 * (`default` + `ocr-paddle`). Cargo keys every artifact on that set, so the two
 * kept separate copies of `app_lib` and the app binaries. Naming `default`
 * makes the CLI ask for `default,ocr-paddle`, the same set, so `tauri dev` and
 * plain cargo share one build. A caller that turns default features off itself
 * (`-- --no-default-features`) keeps its own choice.
 */
export function withDefaultFeatures(args) {
  if (args[0] !== "dev") return args
  const separator = args.indexOf("--")
  const tauriArgs = separator === -1 ? args : args.slice(0, separator)
  const cargoArgs = separator === -1 ? [] : args.slice(separator + 1)
  if (cargoArgs.includes("--no-default-features")) return args
  for (let i = 0; i < tauriArgs.length; i++) {
    const arg = tauriArgs[i]
    const value =
      arg === "--features" || arg === "-f"
        ? tauriArgs[i + 1]
        : arg.startsWith("--features=")
          ? arg.slice("--features=".length)
          : undefined
    if (value?.split(/[\s,]+/).includes("default")) return args
  }
  return ["dev", "--features", "default", ...args.slice(1)]
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
 * the same environment `tauri dev` passes down. The copies inside
 * `beforeDevCommand` then finish as fingerprint no-ops in a second or two, so
 * the wait only covers `predev` and Next.js startup. `beforeDevCommand` keeps
 * the steps so a direct `tauri dev` or the system-node launcher still prepares
 * everything.
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

/** A `tauri dev` invocation that will build and launch the app (not `--help`). */
export function isDevLaunch(args) {
  if (args[0] !== "dev") return false
  const separator = args.indexOf("--")
  const tauriArgs = separator === -1 ? args : args.slice(0, separator)
  return !tauriArgs.includes("--help") && !tauriArgs.includes("-h")
}

export function devPrepareScripts(args, root) {
  if (!isDevLaunch(args)) return []

  const config = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"))
  const { scripts } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
  return cargoPrepareScripts(resolveBeforeDevCommand(args, config, root), scripts ?? {})
}

/** Clear the frontend listener before Tauri can mistake it for this run's server. */
export function devPreparePort(args, root) {
  if (!isDevLaunch(args)) return null
  const config = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"))
  const command = resolveBeforeDevCommand(args, config, root)
  for (const step of command?.split("&&") ?? []) {
    const match = /^node scripts\/dev\/free-port\.mjs ([1-9]\d*)$/.exec(step.trim())
    if (match && Number(match[1]) <= 65535) return Number(match[1])
  }
  return null
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
  // `src-tauri/build.rs` drops `bundle.resources` / `bundle.externalBin` from
  // every development build itself, so no `TAURI_CONFIG` is exported here: an
  // extra value would split this build's fingerprint from rust-analyzer's and
  // `cargo test`'s and re-run the build script on every switch.
  for (const name of devPrepareScripts(args, root)) {
    const result = await runPnpmScript(name, { cwd: root, env })
    if (result.signal || result.code !== 0) return result
  }
  // `predev` (inside `beforeDevCommand`, so inside the 180s wait) builds the
  // plugin-author CLI. Warm it here first; it stays best-effort there and here.
  if (isDevLaunch(args)) {
    try {
      buildCogniaCli(env)
    } catch (error) {
      console.warn("[tauri] cognia CLI warm-up failed; predev will retry:", error)
    }
  }

  const frontendPort = devPreparePort(args, root)
  if (frontendPort !== null) {
    // beforeDevCommand repeats this check, but by then the CLI has already
    // decided whether its devUrl is ready. Clearing it here prevents launching
    // the webview against a server that the preparation chain is about to stop.
    const child = spawn(
      process.execPath,
      [path.join(root, "scripts/dev/free-port.mjs"), String(frontendPort)],
      {
        cwd: root,
        env,
        stdio: "inherit",
      }
    )
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => resolve({ code, signal }))
    })
    if (result.signal || result.code !== 0) return result
  }

  const require = createRequire(import.meta.url)
  const tauriCli = require.resolve("@tauri-apps/cli/tauri.js")
  // The wrapper runs the installed CLI; launching must not trigger pnpm's implicit install.
  const child = spawn(process.execPath, [tauriCli, ...withFailFastDev(withDefaultFeatures(args))], {
    cwd: root,
    env,
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
