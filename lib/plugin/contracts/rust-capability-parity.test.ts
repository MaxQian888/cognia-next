/**
 * Rust ↔ TS parity drift guard.
 *
 * The `cognia plugin lint` CLI (`crates/cognia-cli/src/cmd_lint.rs`) hard-codes
 * whitelists so it can validate manifests offline. If they drift from the TS
 * validator, the CLI passes a manifest the app then rejects at load (or vice
 * versa). This test regex-extracts each Rust list and asserts set-equality
 * against the authoritative TS sources, so a drift fails here loudly.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CANONICAL_PLUGIN_CAPABILITIES } from "./plugin-capabilities"

const REPO_ROOT = join(__dirname, "..", "..", "..")
const RUST_LINT = readFileSync(
  join(REPO_ROOT, "crates", "cognia-cli", "src", "cmd_lint.rs"),
  "utf8"
)
const TS_VALIDATION = readFileSync(
  join(REPO_ROOT, "lib", "plugin", "core", "validation.ts"),
  "utf8"
)
const API_BRIDGE = readFileSync(
  join(REPO_ROOT, "src-tauri", "src", "plugin_api", "api_bridge.rs"),
  "utf8"
)

/** Permission strings advertised inside the gateway's `capability_table()`. */
function extractCapabilityTablePermissions(source: string): Set<string> {
  const fnStart = source.indexOf("fn capability_table()")
  if (fnStart === -1) throw new Error("capability_table() not found")
  const fnEnd = source.indexOf("\n}", fnStart)
  const body = source.slice(fnStart, fnEnd === -1 ? undefined : fnEnd)
  const perms = new Set<string>()
  // Each entry is `cap("api", bool, bool, &["perm", ...])` — pull the perm
  // arrays only (not the `api` string), then the quoted strings inside them.
  for (const arr of body.match(/&\[([^\]]*)\]/g) ?? []) {
    for (const q of arr.match(/"([^"]+)"/g) ?? []) perms.add(q.slice(1, -1))
  }
  return perms
}

/** Extract the quoted string literals from the array assigned to `constName`. */
function extractList(source: string, constName: string): Set<string> {
  const start = source.indexOf(constName)
  if (start === -1) throw new Error(`const ${constName} not found`)
  const eq = source.indexOf("=", start)
  const open = source.indexOf("[", eq)
  const close = source.indexOf("]", open)
  if (eq === -1 || open === -1 || close === -1) {
    throw new Error(`could not locate array literal for ${constName}`)
  }
  const block = source.slice(open, close)
  const matches = block.match(/["']([^"']+)["']/g) ?? []
  return new Set(matches.map((m) => m.slice(1, -1)))
}

function sorted(set: Set<string>): string[] {
  return [...set].sort()
}

describe("Rust CLI ↔ TS validator parity", () => {
  it("VALID_CAPABILITIES matches CANONICAL_PLUGIN_CAPABILITIES", () => {
    const rust = extractList(RUST_LINT, "VALID_CAPABILITIES")
    const ts = new Set<string>(CANONICAL_PLUGIN_CAPABILITIES)
    expect(sorted(rust)).toEqual(sorted(ts))
  })

  it("VALID_PERMISSIONS matches the TS validator list", () => {
    const rust = extractList(RUST_LINT, "VALID_PERMISSIONS")
    const ts = extractList(TS_VALIDATION, "VALID_PERMISSIONS")
    expect(sorted(rust)).toEqual(sorted(ts))
  })

  it("VALID_PLUGIN_TYPES matches the TS validator list", () => {
    const rust = extractList(RUST_LINT, "VALID_PLUGIN_TYPES")
    const ts = extractList(TS_VALIDATION, "VALID_PLUGIN_TYPES")
    expect(sorted(rust)).toEqual(sorted(ts))
  })

  it("api_bridge capability_table permissions are a subset of VALID_PERMISSIONS", () => {
    const advertised = extractCapabilityTablePermissions(API_BRIDGE)
    const valid = extractList(TS_VALIDATION, "VALID_PERMISSIONS")
    expect(advertised.size).toBeGreaterThan(0)
    const offenders = [...advertised].filter((p) => !valid.has(p))
    expect(offenders).toEqual([])
  })
})
