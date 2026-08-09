#!/usr/bin/env node
/**
 * `pnpm clean:db` — reset the desktop app's local databases and web caches.
 *
 * The Tauri WebView persists the whole app state in IndexedDB (Dexie: chat
 * sessions, settings, plugins) plus LocalStorage (zustand-persist). On macOS
 * WKWebView these stores can wedge — a Dexie upgrade that never commits, or a
 * runaway persist loop — leaving `pnpm tauri dev` stuck on boot (see the
 * `dev-boot-idb-wedge-diagnosis` note). Native app data (the sqlite-vec vector
 * store, the Tauri store, gateway config) lives alongside it under the app's
 * data directory. This script removes both so the next launch starts clean.
 *
 * DESTRUCTIVE: it deletes local chat history, settings, the vector store and
 * long-term memory. Secrets/OAuth tokens are NOT touched — those live in the OS
 * keychain (src-tauri secret_store), not in these files. Run it with the
 * desktop app CLOSED, or the WebView may re-create / lock the files.
 *
 * It never wipes anything outside the known per-app locations, and only removes
 * paths that actually exist, so it is safe to run on any platform. Pass
 * `--dry-run` to print the plan without deleting.
 *
 * Usage:
 *   node scripts/dev/clean-app-databases.mjs
 *   node scripts/dev/clean-app-databases.mjs --dry-run
 */

import { existsSync, rmSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path, { resolve, join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Command, CommanderError } from "commander"
import { z } from "zod"

/** Hard-coded fallbacks, mirrored from src-tauri/tauri.conf.json. */
const FALLBACK_IDENTIFIER = "com.cognia.desktop"
const FALLBACK_PRODUCT_NAME = "Cognia"
/** Cargo package/binary name — the folder macOS uses for the unbundled dev app. */
const DEV_BIN_NAME = "cognia-next"

/**
 * Read `identifier` + `productName` from tauri.conf.json so the target paths
 * stay correct if the app is ever renamed. Falls back to the constants above
 * (per field) on any read/parse failure. `readFile` is injectable for tests.
 */
export function readTauriIdentity(repoRoot, readFile = readFileSync) {
  const fallback = {
    identifier: FALLBACK_IDENTIFIER,
    productName: FALLBACK_PRODUCT_NAME,
  }
  try {
    const raw = readFile(join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8")
    const conf = JSON.parse(raw)
    const pick = (value, fb) => (typeof value === "string" && value.trim() ? value : fb)
    return {
      identifier: pick(conf.identifier, fallback.identifier),
      productName: pick(conf.productName, fallback.productName),
    }
  } catch {
    return fallback
  }
}

/**
 * Absolute paths of the app's local databases / web caches for one platform.
 *
 * The WebView data folder is keyed on the app's "name", which differs between
 * the unbundled dev binary (`binName`), the bundled product (`productName`),
 * and the bundle identifier — so all three are probed. Native app data uses the
 * identifier only. Dependencies (`platform`/`home`/`env`) are injected so the
 * derivation is unit-testable for every OS from a single host.
 *
 * Returns a de-duplicated list; unknown platforms return `[]`.
 */
export function appStorageTargets({
  platform,
  home,
  env,
  identifier,
  productName,
  binName = DEV_BIN_NAME,
}) {
  // Target-OS path semantics regardless of the host running this script.
  const p = platform === "win32" ? path.win32 : path.posix
  const names = [...new Set([binName, productName, identifier])]
  const targets = []

  if (platform === "darwin") {
    for (const name of names) {
      targets.push(p.join(home, "Library", "WebKit", name)) // IndexedDB + LocalStorage
      targets.push(p.join(home, "Library", "Caches", name)) // WKWebView disk cache
    }
    targets.push(
      p.join(home, "Library", "Application Support", identifier) // native app data
    )
  } else if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || p.join(home, "AppData", "Local")
    const appData = env.APPDATA || p.join(home, "AppData", "Roaming")
    for (const name of names) {
      targets.push(p.join(localAppData, name, "EBWebView")) // WebView2 IndexedDB/cache
    }
    targets.push(p.join(appData, identifier)) // roaming app data (Tauri store, config)
    targets.push(p.join(localAppData, identifier)) // local app data
  } else if (platform === "linux") {
    const dataHome = env.XDG_DATA_HOME || p.join(home, ".local", "share")
    const cacheHome = env.XDG_CACHE_HOME || p.join(home, ".cache")
    for (const name of names) {
      targets.push(p.join(dataHome, name)) // WebKitGTK data (incl. identifier == native app data)
      targets.push(p.join(cacheHome, name)) // WebKitGTK cache
    }
  }

  return [...new Set(targets)]
}

/**
 * Remove every target that exists. Missing paths are skipped; a failing removal
 * (e.g. the app still holds a lock) is recorded and the loop continues. In
 * `dryRun` mode nothing is deleted — existing targets are reported as
 * would-remove. `exists`/`rm` are injected so tests never touch the real FS.
 *
 * Returns `{ removed, skipped, failed }`.
 */
export function cleanAppDatabases({ targets, exists, rm, log = console.log, dryRun = false }) {
  const removed = []
  const skipped = []
  const failed = []

  for (const target of targets) {
    if (!exists(target)) {
      skipped.push(target)
      continue
    }
    if (dryRun) {
      removed.push(target)
      log(`[clean-db] would remove ${target}`)
      continue
    }
    try {
      rm(target)
      removed.push(target)
      log(`[clean-db] removed ${target}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ target, error: message })
      log(`[clean-db] FAILED to remove ${target} (${message})`)
    }
  }

  return { removed, skipped, failed }
}

const __filename = fileURLToPath(import.meta.url)
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === __filename

const cliSchema = z.object({ dryRun: z.boolean().default(false) })

function createProgram() {
  return new Command()
    .name("pnpm clean:db")
    .description("Reset Cognia's local databases and WebView caches.")
    .configureOutput({ writeErr: () => {} })
    .showHelpAfterError()
    .exitOverride()
    .option("--dry-run", "Print the deletion plan without removing files.")
}

export function parseArgs(argv) {
  const program = createProgram()
  try {
    program.parse(argv, { from: "user" })
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") return null
    throw error
  }
  return cliSchema.parse(program.opts())
}

function main(argv) {
  const options = parseArgs(argv)
  if (!options) return
  const repoRoot = resolve(dirname(__filename), "..", "..")
  const { identifier, productName } = readTauriIdentity(repoRoot)
  const targets = appStorageTargets({
    platform: process.platform,
    home: homedir(),
    env: process.env,
    identifier,
    productName,
    binName: DEV_BIN_NAME,
  })

  if (targets.length === 0) {
    console.log(
      `[clean-db] no known storage locations for platform "${process.platform}" — nothing to do.`
    )
  } else {
    console.log(
      options.dryRun
        ? "[clean-db] DRY RUN — the following would be removed (nothing is deleted):"
        : "[clean-db] Resetting local databases & web caches. Make sure the desktop app is CLOSED first."
    )
    const result = cleanAppDatabases({
      targets,
      exists: existsSync,
      rm: (target) => rmSync(target, { recursive: true, force: true }),
      dryRun: options.dryRun,
    })
    console.log(
      `[clean-db] ${options.dryRun ? "would remove" : "removed"} ${result.removed.length}, ` +
        `absent ${result.skipped.length}, failed ${result.failed.length}.`
    )
    if (result.failed.length > 0) process.exitCode = 1
  }
}

if (isDirectRun) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`[clean-db] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
