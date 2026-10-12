#!/usr/bin/env node
/**
 * predev hook — auto-configure the `cognia` plugin-author CLI for desktop dev.
 *
 * The Plugin DevTools "cognia CLI" surface (`useCogniaCliStatus` →
 * `detect_binary("cognia")`) only lights up when a `cognia` binary is
 * discoverable. Rather than make each developer run
 * `cargo install --locked --path crates/cognia-cli`, this builds the CLI into
 * the shared workspace target dir (`target/debug/cognia`). The Tauri backend
 * registers that dir as a managed search path in debug builds
 * (`cli_bridge::detect::register_dev_build_dir`), so the freshly-built binary
 * is detected without touching the developer's PATH.
 *
 * Scope + safety:
 *   - Only runs when invoked by `tauri dev` — Tauri exports `TAURI_ENV_*`
 *     into the `beforeDevCommand` (`pnpm dev`) process. A plain web `pnpm dev`
 *     (no Tauri env) is a no-op, so web-only contributors never pay a cargo
 *     build and don't need a Rust toolchain.
 *   - `cargo build` is incremental: near-instant once warm, one-time cost cold.
 *   - It must NEVER abort dev startup. Missing cargo, a build failure, or any
 *     other error is logged and the process still exits 0.
 *
 * Override with COGNIA_SKIP_CLI_BUILD=1 to skip even under Tauri.
 */

import { execaSync } from "execa"
import { fileURLToPath } from "node:url"

const tag = "[ensure-cognia-cli]"

/** True when this `pnpm dev` was spawned by `tauri dev` (vs. a web dev run). */
function isTauriDev() {
  // Tauri v2 exports TAURI_ENV_* for before{Dev,Build}Command. PLATFORM is
  // always present; presence (not value) is the signal we key off.
  return Boolean(process.env.TAURI_ENV_PLATFORM)
}

/** True when `cargo` is on PATH and runnable. */
function hasCargo(env) {
  try {
    return execaSync("cargo", ["--version"], { env, stdio: "ignore", reject: false }).exitCode === 0
  } catch {
    return false
  }
}

/**
 * Build the CLI unless `COGNIA_SKIP_CLI_BUILD=1`. Never throws and never fails:
 * `scripts/dev/tauri.mjs` also calls this before the Tauri CLI starts its 180s
 * frontend wait, so the cargo work lands outside that budget and the `predev`
 * run below finishes as a fingerprint no-op.
 */
export function buildCogniaCli(env = process.env) {
  if (env.COGNIA_SKIP_CLI_BUILD === "1") {
    console.log(`${tag} COGNIA_SKIP_CLI_BUILD=1 — skipping.`)
    return
  }
  if (!hasCargo(env)) {
    console.warn(
      `${tag} cargo not found — skipping CLI build. Install Rust, or run ` +
        `\`cargo install --locked --path crates/cognia-cli\` to enable Plugin DevTools.`
    )
    return
  }

  console.log(`${tag} building cognia CLI (cargo build -p cognia-cli)…`)
  const build = execaSync("cargo", ["build", "-p", "cognia-cli"], {
    env,
    stdio: "inherit",
    reject: false,
  })
  if (build.exitCode === 0) {
    console.log(`${tag} cognia CLI ready in target/debug — DevTools will detect it on boot.`)
  } else {
    console.warn(
      `${tag} cargo build -p cognia-cli failed (${build.signal ?? `exit ${build.exitCode}`}). ` +
        `Dev server will start anyway; Plugin DevTools will show the CLI as missing.`
    )
  }
}

function main() {
  if (!isTauriDev()) {
    // Web `pnpm dev` — nothing to do.
    return
  }
  buildCogniaCli()
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    console.warn(`${tag} unexpected error — skipping:`, err)
  }
  // Always succeed: predev must not block `next dev`.
  process.exit(0)
}
