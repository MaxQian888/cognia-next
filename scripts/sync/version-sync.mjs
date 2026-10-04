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
 *   - crates/cognia-companion/Cargo.toml (reports the app version on the wire)
 *   - cli/package.json               (@cognia/agent-cli — the `cognia-agent` CLI)
 *   - sidecar/package.json           (cognia-claude-sidecar, bundled in resources)
 *   - sidecar/vscode-ext-host/package.json
 *   - mobile/package.json            (Capacitor shell)
 *   - mobile/android/version.properties (Android display and upgrade versions)
 *   - mobile/ios/App/App.xcodeproj/project.pbxproj (App target versions)
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
 *   - "android-properties": generated versionName and ordered versionCode
 *   - "ios-project": App target marketing and build versions
 */
export const TARGETS = [
  { path: "src-tauri/tauri.conf.json", kind: "json" },
  { path: "src-tauri/Cargo.toml", kind: "cargo" },
  { path: "crates/cognia-cli/Cargo.toml", kind: "cargo" },
  { path: "crates/cognia-sandbox-runner/Cargo.toml", kind: "cargo" },
  // `/healthz`, `whoami`, the bridge hello and the agent cards report this
  // crate's `CARGO_PKG_VERSION` (ADR-0196 P7).
  { path: "crates/cognia-companion/Cargo.toml", kind: "cargo" },
  { path: "crates/cognia-companion-rpc/Cargo.toml", kind: "cargo" },
  { path: "crates/cognia-sidecar/Cargo.toml", kind: "cargo" },
  { path: "cli/package.json", kind: "json" },
  { path: "sidecar/package.json", kind: "json" },
  { path: "sidecar/vscode-ext-host/package.json", kind: "json" },
  { path: "mobile/package.json", kind: "json" },
  { path: "mobile/android/version.properties", kind: "android-properties" },
  { path: "mobile/ios/App/App.xcodeproj/project.pbxproj", kind: "ios-project" },
  { path: "docs/package.json", kind: "json" },
  // WXT reads the manifest version out of package.json, so the extension
  // users see and the app it pairs with report the same number.
  { path: "browser-extension/package.json", kind: "json" },
]

const JSON_VERSION_RE = /"version":\s*"([^"]+)"/
const CARGO_VERSION_RE = /^version\s*=\s*"([^"]+)"/m

/** SemVer syntax, including the numeric prerelease leading-zero restriction. */
export function isValidVersion(v) {
  if (typeof v !== "string") return false
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      v
    )
  return Boolean(match && (!match[4] || match[4].split(".").every((part) => !/^0\d+$/.test(part))))
}

/**
 * Ordered, collision-free release subset: each tuple component is 0..99;
 * alpha/beta/rc sequence numbers are 0..499. The 2000 slots per tuple reserve
 * 1..500 for alpha, 501..1000 for beta, 1001..1500 for rc and 1999 for stable.
 * Maximum code 1,999,999,999 remains below Google Play's 2,100,000,000 limit.
 * Build metadata cannot distinguish an Android upgrade and is rejected.
 */
export function getAndroidVersion(version) {
  const match =
    typeof version === "string"
      ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/.exec(
          version
        )
      : null
  if (
    !match ||
    match.slice(1, 4).some((part) => Number(part) > 99) ||
    (match[5] && Number(match[5]) > 499)
  ) {
    throw new Error(
      `Unsupported Android version: ${version}. Use MAJOR.MINOR.PATCH (each 0..99), optionally -alpha.N, -beta.N or -rc.N (N 0..499), without build metadata.`
    )
  }
  const [major, minor, patch] = match.slice(1, 4).map(Number)
  const stage = match[4] ? { alpha: 1, beta: 501, rc: 1001 }[match[4]] + Number(match[5]) : 1999
  return { versionName: version, versionCode: (major * 10000 + minor * 100 + patch) * 2000 + stage }
}

function readAndroidProperty(content, key) {
  const matches = [...content.matchAll(new RegExp(`^${key}=([^\\r\\n]*)\\r?$`, "gm"))]
  if (matches.length !== 1) throw new Error(`Android properties must contain exactly one ${key}`)
  return matches[0][1]
}

/** Apple requires a numeric release tuple; build stages increase within it. */
export function getIosVersion(version) {
  const { versionCode } = getAndroidVersion(version)
  return { marketingVersion: version.split("-")[0], buildVersion: String(versionCode % 2000) }
}

function iosProperty(block, key) {
  const matches = [...block.matchAll(new RegExp(`^[\\t ]+${key} = ([^;\\r\\n]+);`, "gm"))]
  if (matches.length !== 1) throw new Error(`iOS App configuration requires exactly one ${key}`)
  return matches[0][1].trim().replace(/^"(.*)"$/, "$1")
}

// Follow native-target/configuration-list references, rather than rewriting all
// similarly named settings (which can belong to project, test or extension targets).
// Preserve the Xcode-generated OpenStep text byte-for-byte outside these literals.
function iosAppConfigurations(content) {
  const blocks = [
    ...content.matchAll(/^([\t ]+)([A-F0-9]{24})(?: \/\*[^\r\n]*?\*\/)? = \{\r?\n[\s\S]*?^\1\};/gm),
  ]
  const targets = blocks.filter(
    (match) => /isa = PBXNativeTarget;/.test(match[0]) && /^[\t ]+name = "?App"?;/m.test(match[0])
  )
  if (targets.length !== 1) throw new Error("iOS project requires exactly one App native target")
  const listId = iosProperty(targets[0][0], "buildConfigurationList").match(/^[A-F0-9]{24}\b/)?.[0]
  const list = blocks.filter(
    (match) => match[2] === listId && /isa = XCConfigurationList;/.test(match[0])
  )
  if (list.length !== 1) throw new Error("iOS App configuration list is missing or ambiguous")
  const references = list[0][0].match(/buildConfigurations = \(([\s\S]*?)\);/)?.[1]
  const ids = [...(references ?? "").matchAll(/\b[A-F0-9]{24}\b/g)].map((match) => match[0])
  if (ids.length !== 2 || new Set(ids).size !== 2)
    throw new Error("iOS App requires unique Debug and Release configurations")
  const configurations = ids.map((id) => {
    const matches = blocks.filter(
      (match) => match[2] === id && /isa = XCBuildConfiguration;/.test(match[0])
    )
    if (matches.length !== 1) throw new Error(`iOS App configuration ${id} is missing or ambiguous`)
    const match = matches[0]
    return {
      text: match[0],
      index: match.index,
      name: iosProperty(match[0], "name"),
      marketingVersion: iosProperty(match[0], "MARKETING_VERSION"),
      buildVersion: iosProperty(match[0], "CURRENT_PROJECT_VERSION"),
    }
  })
  if (
    configurations
      .map((item) => item.name)
      .sort()
      .join(",") !== "Debug,Release"
  )
    throw new Error("iOS App requires Debug and Release configurations")
  return configurations
}

export function isVersionSynced(content, kind, version) {
  if (kind === "ios-project") {
    const expected = getIosVersion(version)
    return iosAppConfigurations(content).every(
      (item) =>
        item.marketingVersion === expected.marketingVersion &&
        item.buildVersion === expected.buildVersion
    )
  }
  if (kind === "android-properties") {
    const expected = getAndroidVersion(version)
    return (
      readAndroidProperty(content, "versionName") === expected.versionName &&
      readAndroidProperty(content, "versionCode") === String(expected.versionCode)
    )
  }
  return extractVersion(content, kind) === version
}

/** Extract the current version from a file's content, or null if not found. */
export function extractVersion(content, kind) {
  if (kind === "ios-project") return iosAppConfigurations(content)[0].marketingVersion
  if (kind === "android-properties") return readAndroidProperty(content, "versionName")
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
  if (kind === "ios-project") {
    const expected = getIosVersion(version)
    for (const item of iosAppConfigurations(content).sort((a, b) => b.index - a.index)) {
      const updated = item.text
        .replace(/(MARKETING_VERSION = )[^;\r\n]+;/, `$1${expected.marketingVersion};`)
        .replace(/(CURRENT_PROJECT_VERSION = )[^;\r\n]+;/, `$1${expected.buildVersion};`)
      content =
        content.slice(0, item.index) + updated + content.slice(item.index + item.text.length)
    }
    return content
  }
  if (kind === "android-properties") {
    const values = getAndroidVersion(version)
    for (const [key, value] of Object.entries(values)) {
      readAndroidProperty(content, key)
      content = content.replace(new RegExp(`^${key}=[^\\r\\n]*`, "m"), `${key}=${value}`)
    }
    return content
  }
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
  // Validate the cross-platform release contract before updating any mirror.
  getAndroidVersion(version)

  const drifted = []
  const updated = []
  const pending = []

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
    if (isVersionSynced(content, kind, version)) continue

    if (check) {
      drifted.push(
        `${path} (${current} → ${version}${kind === "android-properties" ? `, expected versionCode ${getAndroidVersion(version).versionCode}` : ""})`
      )
      continue
    }
    pending.push({ abs, content: replaceVersion(content, kind, version) })
    updated.push(path)
  }

  // Complete validation before writing: a malformed later native project must
  // not leave earlier package/desktop version mirrors partially synchronized.
  for (const item of pending) writeFileAtomic.sync(item.abs, item.content)

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
