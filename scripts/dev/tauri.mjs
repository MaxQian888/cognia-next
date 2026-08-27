#!/usr/bin/env node

import { spawn } from "node:child_process"
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

export async function runTauri(args, { env = process.env } = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
  const child = spawn(pnpm, ["exec", "tauri", ...withFailFastDev(args)], {
    cwd: root,
    env: withDevResourceEnv(args, env),
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
