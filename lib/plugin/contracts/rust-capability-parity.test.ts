/**
 * Rust ↔ TS parity drift guard.
 *
 * The `cognia plugin lint` CLI (`crates/cognia-cli/src/cmd_lint.rs`) hard-codes
 * whitelists so it can validate manifests offline. If they drift from the TS
 * validator, the CLI passes a manifest the app then rejects at load (or vice
 * versa). This test regex-extracts each Rust list and asserts set-equality
 * against the authoritative TS sources, so a drift fails here loudly.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { CANONICAL_PLUGIN_CAPABILITIES, PLUGIN_CAPABILITY_CONTRACTS } from "./plugin-capabilities"
import {
  CANONICAL_PLUGIN_PERMISSIONS,
  CANONICAL_PLUGIN_TYPES,
} from "@/packages/plugin-sdk/src/contracts/catalog"

const REPO_ROOT = join(__dirname, "..", "..", "..")

/**
 * Read a load-bearing parity source, failing *loudly* if it has moved. A
 * silent ENOENT here disables the whole suite: when ADR-0067 relocated
 * api_bridge.rs on 2026-07-13, this file ENOENT'd at module load, so 0 tests
 * ran and drift stopped being caught while the red state read like just
 * another known-broken baseline. An explicit "it moved — repoint this guard"
 * error is the difference between a fix and a rearmed trap.
 */
function readGuarded(...segments: string[]): string {
  const path = join(REPO_ROOT, ...segments)
  if (!existsSync(path)) {
    throw new Error(
      `parity-guard source not found: ${path} — it moved. Repoint this guard; ` +
        `a silent ENOENT here disables Rust↔TS capability parity checking entirely.`
    )
  }
  return readFileSync(path, "utf8")
}

const RUST_LINT = readGuarded("crates", "cognia-cli", "src", "generated_plugin_contract.rs")
const API_BRIDGE = readGuarded("crates", "cognia-plugin-runtime", "src", "api_bridge.rs")

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

/**
 * Extract the Rust `CAPABILITY_FIELDS` table — rows shaped
 * `("cap", &["field", …])` — as a capability → sorted-fields map.
 */
function extractCapabilityFields(source: string): Map<string, string[]> {
  const marker = "const CAPABILITY_FIELDS"
  const start = source.indexOf(marker)
  if (start === -1) throw new Error("CAPABILITY_FIELDS not found in cmd_lint.rs")
  const end = source.indexOf("];", start)
  if (end === -1) throw new Error("CAPABILITY_FIELDS array literal not terminated")
  const block = source.slice(start, end)
  const map = new Map<string, string[]>()
  const rowRe = /\(\s*"([^"]+)"\s*,\s*&\[([^\]]*)\]\s*\)/g
  let match: RegExpExecArray | null
  while ((match = rowRe.exec(block)) !== null) {
    const cap = match[1]
    const fields = (match[2].match(/"([^"]+)"/g) ?? []).map((s) => s.slice(1, -1)).sort()
    map.set(cap, fields)
  }
  return map
}

/** Stable, diff-friendly rendering of a capability → fields map. */
function fieldEntries(map: Map<string, string[]>): Array<[string, string]> {
  return [...map.entries()]
    .map(([cap, fields]): [string, string] => [cap, fields.join(",")])
    .sort((a, b) => a[0].localeCompare(b[0]))
}

describe("Rust CLI ↔ TS validator parity", () => {
  it("VALID_CAPABILITIES matches CANONICAL_PLUGIN_CAPABILITIES", () => {
    const rust = extractList(RUST_LINT, "VALID_CAPABILITIES")
    const ts = new Set<string>(CANONICAL_PLUGIN_CAPABILITIES)
    expect(sorted(rust)).toEqual(sorted(ts))
  })

  it("VALID_PERMISSIONS matches the TS validator list", () => {
    const rust = extractList(RUST_LINT, "VALID_PERMISSIONS")
    const ts = new Set<string>(CANONICAL_PLUGIN_PERMISSIONS)
    expect(sorted(rust)).toEqual(sorted(ts))
  })

  it("VALID_PLUGIN_TYPES matches the TS validator list", () => {
    const rust = extractList(RUST_LINT, "VALID_PLUGIN_TYPES")
    const ts = new Set<string>(CANONICAL_PLUGIN_TYPES)
    expect(sorted(rust)).toEqual(sorted(ts))
  })

  it("CAPABILITY_FIELDS matches PLUGIN_CAPABILITY_CONTRACTS array fields", () => {
    // The app's cross-check (validation.ts) iterates PLUGIN_CAPABILITY_CONTRACTS
    // directly: every contract with a non-empty `manifestFields` drives the
    // field_missing / field_undeclared checks — EXCEPT `python`, whose fields
    // are entry-point strings validated by the type block. The Rust CLI
    // hand-copies this into CAPABILITY_FIELDS; drift means `cognia plugin lint`
    // and the app disagree on which fields gate which capability (a false
    // field_missing warning here, a silently-missed one there).
    const expected = new Map<string, string[]>()
    for (const c of PLUGIN_CAPABILITY_CONTRACTS) {
      if (c.manifestFields.length === 0) continue
      if (c.id === "python") continue
      expected.set(c.id, [...c.manifestFields].sort())
    }
    const actual = extractCapabilityFields(RUST_LINT)
    expect(fieldEntries(actual)).toEqual(fieldEntries(expected))
  })

  it("api_bridge capability_table permissions are a subset of VALID_PERMISSIONS", () => {
    const advertised = extractCapabilityTablePermissions(API_BRIDGE)
    const valid = new Set<string>(CANONICAL_PLUGIN_PERMISSIONS)
    expect(advertised.size).toBeGreaterThan(0)
    const offenders = [...advertised].filter((p) => !valid.has(p))
    expect(offenders).toEqual([])
  })
})
