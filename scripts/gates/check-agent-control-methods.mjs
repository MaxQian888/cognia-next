#!/usr/bin/env node
/**
 * Gate: the live session-control surface must agree across all four places it
 * is declared, and each declaration must match `protocol/agent-control-methods.json`.
 *
 * Why: the same eight method names are hand-written in four files, in three
 * languages —
 *   1. `SessionControlMethod`            packages/agent-config-types/src/index.ts
 *   2. `CONTROL_METHODS`                 sidecar/dispatch/control.mjs
 *   3. `is_allowed_control_method`       src-tauri/src/claude/commands.rs
 *   4. `allows_only_known_control_methods` (the Rust test re-types them again)
 * — and the SDK-parity work adds 17 more. Four hand-maintained copies of a
 * growing list is four drift sources; the sibling `companion-commands.json`
 * already proved the manifest-plus-gate shape works here.
 *
 * Three things this catches that a plain string diff would not:
 *
 * - **The `steer` trap.** `steer` sits on the control allowlist but is NOT an
 *   SDK `Query` method — the host intercepts it in `routeSteer()`. Anyone
 *   regenerating the allowlist from `sdk.d.ts` would silently delete steering.
 *   The manifest marks it `kind: "host"` and the gate asserts it is absent
 *   from the SDK surface.
 * - **Phantom SDK methods.** Anything marked `kind: "sdk"` must actually exist
 *   in `protocol/agent-sdk-surface.json`, so a typo or a method the SDK
 *   dropped fails here rather than at runtime as `unknown_method`.
 * - **Premature allowlisting.** A method still marked `planned` must not
 *   appear in any runtime site. Allowlisting a control before it is wired is
 *   the "built but dormant" failure in its most dangerous form: the call
 *   reaches a live `Query` object.
 *
 * Usage: pnpm audit:agent-control-methods
 */

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

const SITES = {
  "packages/agent-config-types/src/index.ts": extractTsUnion,
  "sidecar/dispatch/control.mjs": extractSidecarSet,
  "src-tauri/src/claude/commands.rs": extractRustAllowlist,
  "src-tauri/src/claude/commands.rs::test": extractRustTestList,
}

/** `export type SessionControlMethod = | "a" | "b"` */
export function extractTsUnion(source) {
  const m = source.match(/export type SessionControlMethod =([\s\S]*?)(?:\n\n|\n\/\*)/)
  if (!m) throw new Error("could not locate `export type SessionControlMethod`")
  return new Set([...m[1].matchAll(/"([A-Za-z_][\w]*)"/g)].map((x) => x[1]))
}

/** `export const CONTROL_METHODS = new Set([ ... ])` */
export function extractSidecarSet(source) {
  const m = source.match(/export const CONTROL_METHODS = new Set\(\[([\s\S]*?)\]\)/)
  if (!m) throw new Error("could not locate `CONTROL_METHODS`")
  return new Set([...m[1].matchAll(/"([A-Za-z_][\w]*)"/g)].map((x) => x[1]))
}

/** `pub fn is_allowed_control_method(...) { matches!(method, "a" | "b") }` */
export function extractRustAllowlist(source) {
  const m = source.match(/pub fn is_allowed_control_method[\s\S]*?matches!\(([\s\S]*?)\n {4}\)/)
  if (!m) throw new Error("could not locate `is_allowed_control_method`")
  return new Set([...m[1].matchAll(/"([A-Za-z_][\w]*)"/g)].map((x) => x[1]))
}

/**
 * The Rust test's own copy. It also carries a deliberate NEGATIVE list
 * (`"close"`, `"__proto__"`, …) asserting those are rejected, so only the
 * positive array is read.
 */
export function extractRustTestList(source) {
  const m = source.match(
    /fn allows_only_known_control_methods\(\)[\s\S]*?for \w+ in \[([\s\S]*?)\n {8}\]/
  )
  if (!m) throw new Error("could not locate `allows_only_known_control_methods` positive list")
  return new Set([...m[1].matchAll(/"([A-Za-z_][\w]*)"/g)].map((x) => x[1]))
}

/** `AGENT_CAPABILITY_IDS: readonly AgentCapabilityId[] = [ … ]` */
export function extractCapabilityIds(source) {
  const m = source.match(/AGENT_CAPABILITY_IDS[^=]*=\s*\[([\s\S]*?)\n\]/)
  if (!m) throw new Error("could not locate `AGENT_CAPABILITY_IDS`")
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]))
}

const EXPOSURES = new Set(["control", "dedicated-command", "planned"])
const KINDS = new Set(["sdk", "host"])

function diff(a, b) {
  return [...a].filter((x) => !b.has(x)).sort()
}

/**
 * @param {{ manifest: any, sites: Record<string, Set<string>>, sdkQueryMethods: Set<string>, capabilityIds: Set<string> }} input
 * @returns {string[]}
 */
export function verify({ manifest, sites, sdkQueryMethods, capabilityIds }) {
  const errors = []

  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.methods)) {
    return ["manifest must have schemaVersion 1 and a methods array"]
  }

  const seen = new Set()
  for (const entry of manifest.methods) {
    const label = entry?.name ?? "<unnamed>"
    if (typeof entry?.name !== "string" || !entry.name) {
      errors.push(`${label}: name must be a non-empty string`)
      continue
    }
    if (seen.has(entry.name)) errors.push(`${label}: duplicate entry`)
    seen.add(entry.name)

    if (!KINDS.has(entry.kind)) errors.push(`${label}: kind must be sdk|host`)
    if (!EXPOSURES.has(entry.exposure)) {
      errors.push(`${label}: exposure must be ${[...EXPOSURES].join("|")}`)
    }
    if (!capabilityIds.has(entry.capability)) {
      errors.push(`${label}: capability "${entry.capability}" is not a known AgentCapabilityId`)
    }

    // An `sdk` method must really be on the SDK; a `host` one must really not
    // be, or the "regenerate from sdk.d.ts" hazard is back.
    if (entry.kind === "sdk" && !sdkQueryMethods.has(entry.name)) {
      errors.push(`${label}: marked kind "sdk" but absent from protocol/agent-sdk-surface.json`)
    }
    if (entry.kind === "host" && sdkQueryMethods.has(entry.name)) {
      errors.push(
        `${label}: marked kind "host" but the SDK now HAS a Query method of that name — ` +
          `re-decide which one the control frame should reach`
      )
    }
  }

  const expected = new Set(
    manifest.methods.filter((m) => m.exposure === "control").map((m) => m.name)
  )
  const planned = new Set(
    manifest.methods.filter((m) => m.exposure === "planned").map((m) => m.name)
  )

  for (const [site, names] of Object.entries(sites)) {
    const missing = diff(expected, names)
    const extra = diff(names, expected)
    if (missing.length) errors.push(`${site}: missing ${missing.join(", ")}`)
    if (extra.length)
      errors.push(`${site}: has ${extra.join(", ")} which the manifest does not expose`)

    const premature = [...names].filter((n) => planned.has(n)).sort()
    if (premature.length) {
      errors.push(
        `${site}: allowlists ${premature.join(", ")}, still marked "planned" — ` +
          `a control must not be reachable before it is wired`
      )
    }
  }

  return errors
}

export function loadAndVerify(read = (p) => readFileSync(resolve(REPO_ROOT, p), "utf8")) {
  const manifest = JSON.parse(read("protocol/agent-control-methods.json"))
  const surface = JSON.parse(read("protocol/agent-sdk-surface.json"))
  const capabilityIds = extractCapabilityIds(
    read("packages/agent-config-types/src/agent-execution.ts")
  )

  const sites = {}
  for (const [site, extract] of Object.entries(SITES)) {
    sites[site] = extract(read(site.replace("::test", "")))
  }

  return verify({
    manifest,
    sites,
    sdkQueryMethods: new Set(Object.keys(surface.surface.queryMethods)),
    capabilityIds,
  })
}

export function main() {
  const errors = loadAndVerify()
  if (errors.length) {
    console.error("[agent-control-methods] the control surface drifted:")
    for (const e of errors) console.error(`  ${e}`)
    console.error(
      "\n  protocol/agent-control-methods.json is the source. Update it first,\n" +
        "  then bring the four declaration sites into line."
    )
    return 1
  }

  const manifest = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "protocol/agent-control-methods.json"), "utf8")
  )
  const counts = manifest.methods.reduce((acc, m) => {
    acc[m.exposure] = (acc[m.exposure] ?? 0) + 1
    return acc
  }, {})
  console.log(
    `[agent-control-methods] OK — ${manifest.methods.length} methods ` +
      `(${Object.entries(counts)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")}) agree across ${Object.keys(SITES).length} sites`
  )
  return 0
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-agent-control-methods.mjs")
) {
  process.exit(main())
}
