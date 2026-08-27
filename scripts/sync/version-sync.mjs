#!/usr/bin/env node
/**
 * Single-source-of-truth version sync for the Cognia app.
 *
 * The version lives in exactly one place — the root `package.json` `version`
 * field — and this script propagates it to every artifact that ships *as* the
 * Cognia app and must move together:
 *
 *   - src-tauri/tauri.conf.json      (desktop app version; drives the updater)
 *   - src-tauri/Cargo.toml           (Tauri requires this to match tauri.conf)
 *   - crates/cognia-cli/Cargo.toml   (the `cognia` plugin-author CLI)
 *   - crates/cognia-sandbox-runner/Cargo.toml (bundled with the desktop app)
 *   - cli/package.json               (@cognia/agent-cli — the `cognia-agent` CLI)
 *   - sidecar/package.json           (cognia-claude-sidecar, bundled in resources)
 *   - sidecar/vscode-ext-host/package.json
 *   - mobile/package.json            (Capacitor shell)
 *   - docs/package.json
 *   - browser-extension/package.json (WXT copies it into the manifest)
 *
 * Deliberately EXCLUDED (they version independently of the app): everything
 * under `services/`, the `crates/cognia-plugin-template*` scaffolds,
 * `plugins/wasm-example-formatter`, and `packages/plugin-sdk` (published SDK).
 *
 * Mirrors the source-of-truth pattern of `release-sync-keys.mjs`: one canonical
 * value, N mirrors that can never drift, and a `--check` mode for CI.
 *
 * Usage:  node scripts/sync/version-sync.mjs           (sync all mirrors)
 *         node scripts/sync/version-sync.mjs --check    (CI: fail on drift)
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Command, CommanderError } from "commander"
import writeFileAtomic from "write-file-atomic"
import { z } from "zod"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

/**
 * The app-version group. `kind` selects the replace/extract strategy:
 *   - "json":  the top-level `"version": "…"` field
 *   - "cargo": the first `version = "…"` line (the `[package]` version)
 */
export const TARGETS = [
  { path: "src-tauri/tauri.conf.json", kind: "json" },
  { path: "src-tauri/Cargo.toml", kind: "cargo" },
  { path: "crates/cognia-cli/Cargo.toml", kind: "cargo" },
  { path: "crates/cognia-sandbox-runner/Cargo.toml", kind: "cargo" },
  { path: "cli/package.json", kind: "json" },
  { path: "sidecar/package.json", kind: "json" },
  { path: "sidecar/vscode-ext-host/package.json", kind: "json" },
  { path: "mobile/package.json", kind: "json" },
  { path: "docs/package.json", kind: "json" },
  // WXT reads the manifest version out of package.json, so the extension
  // users see and the app it pairs with report the same number.
  { path: "browser-extension/package.json", kind: "json" },
]

const JSON_VERSION_RE = /"version":\s*"([^"]+)"/
const CARGO_VERSION_RE = /^version\s*=\s*"([^"]+)"/m

/** A valid semver-ish version: MAJOR.MINOR.PATCH with an optional pre/build tail. */
export function isValidVersion(v) {
  return typeof v === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(v)
}

/** Extract the current version from a file's content, or null if not found. */
export function extractVersion(content, kind) {
  const re = kind === "cargo" ? CARGO_VERSION_RE : JSON_VERSION_RE
  const m = content.match(re)
  return m ? m[1] : null
}

/**
 * Return `content` with its first version literal set to `version`. Pure — only
 * the FIRST match is replaced, which for these files is always the package's own
 * version (JSON: the top-level field on line ~3; Cargo: the `[package]` version
 * before any `[dependencies]`), never a nested dependency version.
 */
export function replaceVersion(content, kind, version) {
  const re = kind === "cargo" ? CARGO_VERSION_RE : JSON_VERSION_RE
  if (!re.test(content)) return content
  return kind === "cargo"
    ? content.replace(CARGO_VERSION_RE, `version = "${version}"`)
    : content.replace(JSON_VERSION_RE, `"version": "${version}"`)
}

/** Read the canonical version from the root package.json. */
export function readCanonicalVersion() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  if (!isValidVersion(pkg.version)) {
    throw new Error(`root package.json has an invalid version: ${pkg.version}`)
  }
  return pkg.version
}

const cliSchema = z.object({ check: z.boolean().default(false) })

function createProgram() {
  return new Command()
    .name("pnpm version:sync")
    .description("Synchronize the application version across shipping artifacts.")
    .configureOutput({ writeErr: () => {} })
    .showHelpAfterError()
    .exitOverride()
    .option("--check", "Report drift without rewriting version mirrors.")
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

function main({ check = false } = {}) {
  const version = readCanonicalVersion()

  const drifted = []
  const updated = []

  for (const { path, kind } of TARGETS) {
    const abs = join(root, path)
    let content
    try {
      content = readFileSync(abs, "utf8")
    } catch {
      console.error(`[version-sync] target not found: ${path}`)
      process.exit(1)
    }
    const current = extractVersion(content, kind)
    if (current === null) {
      console.error(`[version-sync] could not find a version literal in ${path}`)
      process.exit(1)
    }
    if (current === version) continue

    if (check) {
      drifted.push(`${path} (${current} → ${version})`)
      continue
    }
    writeFileAtomic.sync(abs, replaceVersion(content, kind, version))
    updated.push(path)
  }

  if (check) {
    if (drifted.length) {
      console.error(
        `[version-sync] DRIFT from root ${version}:\n` +
          drifted.map((d) => `  - ${d}`).join("\n") +
          `\n[version-sync] run \`pnpm version:sync\` to fix`
      )
      process.exit(1)
    }
    console.log(`[version-sync] all ${TARGETS.length} mirrors match ${version}`)
    return
  }

  if (updated.length) {
    console.log(
      `[version-sync] synced ${updated.length} file(s) to ${version}:\n` +
        updated.map((p) => `  - ${p}`).join("\n")
    )
  } else {
    console.log(`[version-sync] all ${TARGETS.length} mirrors already at ${version}`)
  }
}

// Only auto-run when invoked directly (not when imported by the test).
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("version-sync.mjs")
) {
  const options = parseArgs(process.argv.slice(2))
  if (options) main(options)
}
