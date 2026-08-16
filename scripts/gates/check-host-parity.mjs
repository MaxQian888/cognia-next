#!/usr/bin/env node
/**
 * Gate: the inventory of everything that makes a headless/cloud host less
 * capable than the desktop — kept honest, and prevented from growing.
 *
 * ## Why the existing gates cannot catch this
 *
 * Five gates already compare the command surface:
 *   - `audit:command-parity`             invoke("x") ⟷ generate_handler!
 *   - `audit:companion-command-manifest` manifest ⟷ generate_handler! ⟷ KNOWN_COMMANDS
 *   - `companion-api:check`              committed OpenAPI bytes ⟷ regenerated
 *   - `audit:rpc-semantic-parity`        #[tauri::command] signature ⟷ RPC arm payload
 *   - `audit:adapter-capabilities`       two runtime-capability tables ⟷ each other
 *
 * Every one of them asks "does the same command exist, with the same payload".
 * None asks "can this host actually reach it". A command can be registered,
 * manifested, semantically faithful, and still 503 on one host — which is the
 * entire subject here.
 *
 * ## What this checks
 *
 * Four independent classes of host-parity gap, plus a cross-table consistency
 * check. A/B/C/E are crisp, per-item, and ratcheted. D is a map, not a rule —
 * see below.
 *
 *   A. transport-seam bypass — a renderer file importing `invoke`/`listen`
 *      straight from `@tauri-apps/api/*` instead of going through the swappable
 *      seam. `lib/tauri.ts` calls itself "the SOLE authoritative seam"; every
 *      bypass throws on a non-Tauri host by construction.
 *   B. UI hard-coded to a host — `desktopOnly: true` sections. Even after a
 *      backend reaches parity, a host-keyed UI keeps the feature hidden.
 *   C. one-sided RPC arms — `host.tauri_app(name)?` (desktop-only) and
 *      `host.headless().ok_or_else(RpcError::headless_unsupported)`
 *      (headless-only). Reported in BOTH directions: the asymmetry runs both
 *      ways, and the headless-only arms that are `target=execution` are
 *      reachable by a remote client, which makes them a live defect rather
 *      than bookkeeping.
 *   E. capability tables vs. the manifest — `protocol/companion-commands.json`
 *      is the single source of truth (ADR-0059). A feature that claims a host
 *      it cannot serve, or serves a host it does not claim, is a lie in one
 *      direction or the other.
 *
 * ## Class D is a map, deliberately un-ratcheted
 *
 * `isTauri()` / `isHeadlessHost()` / `usePlatform()` run to ~1k call sites in
 * shipped source across ~500 files. Most are legitimate — a genuine desktop
 * feature SHOULD check. Baselining that number would ratchet noise and say
 * nothing about parity, so class D is emitted as a per-subsystem census for the
 * audit report and never gates. What DOES gate is that every subsystem the
 * census finds carries an annotation in `host-parity-annotations.json`
 * classifying it (see `CLASSIFICATIONS`). That is the judgment this inventory
 * exists to record, and an unannotated subsystem means a gap nobody has looked
 * at.
 *
 * ## Ratchet, not a cliff — and not yet a cliff at all
 *
 * Same contract as `check-colocated-tests.mjs` and
 * `check-unreachable-components.mjs`: findings live in
 * `host-parity-baseline.json` and THE LIST MAY ONLY SHRINK.
 *
 * REPORT-ONLY FOR NOW. New findings print loudly and exit 0. Flip
 * `ENFORCE_RATCHET` to `true` once the first paydown batch lands (see
 * ADR-0059, "headless ↔ desktop capability parity"); everything else is
 * already wired for it. Leaving the buffer open indefinitely defeats the
 * point, so the switch is a one-line change with its own test.
 *
 * Usage:
 *   pnpm audit:host-parity                     # check (report-only today)
 *   pnpm audit:host-parity:report              # full inventory, grouped
 *   pnpm audit:host-parity:baseline            # after paying debt down
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { parseRegisteredCommands } from "./lib/generate-handler.mjs"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

export const BASELINE_FILE = join(REPO_ROOT, "scripts/gates/host-parity-baseline.json")
export const ANNOTATIONS_FILE = join(REPO_ROOT, "scripts/gates/host-parity-annotations.json")

/**
 * Flip to `true` to make new findings fail the build. See the module docstring.
 * The switch is deliberately a named constant, not a CLI flag: a buffer period
 * that anyone can extend per-invocation never ends.
 */
export const ENFORCE_RATCHET = false

/** The four hosts `lib/platform/detect.ts` models. */
export const HOSTS = Object.freeze(["tauri", "headless", "mobile", "web"])

/**
 * How a subsystem's host guards are to be read.
 *
 * `seam-infrastructure` is the fourth category the original three missed:
 * `lib/tauri` alone carries 121 guards, and they are not a parity gap — they
 * ARE the host-detection and transport-selection layer. Forcing it into
 * "unmigrated" would demand migrating the seam onto itself.
 */
export const CLASSIFICATIONS = Object.freeze([
  "physically-impossible",
  "unmigrated",
  "ui-assumption",
  "seam-infrastructure",
])

/**
 * Files allowed to import `@tauri-apps/api/*` directly, because they ARE the
 * seam (or own an equivalent swappable one). Anything else is a bypass.
 *
 * Keep this list minimal and justified — every entry is a place where the
 * "one implementation, two hosts" property rests on a hand-written swap.
 */
export const SEAM_OWNERS = Object.freeze([
  // The authoritative transport seam (ADR-0059).
  "lib/tauri/transport-tauri.ts",
  // Owns `setConnectorCommandInvoker` — the connectors' own swappable invoker.
  "lib/connectors/tauri/commands.ts",
  // Owns `setConnectorListen` — the connectors' own swappable event seam.
  "lib/connectors/events.ts",
])

const TAURI_IMPORT_RE = /from\s+["']@tauri-apps\/api\/(core|event)["']/
/**
 * `id: "x"` … `desktopOnly: true` within the SAME entry. The span forbids a
 * second `id:`, otherwise a lazy match happily reaches past the end of its own
 * object and pins the flag on whichever entry came before the real one.
 */
const DESKTOP_ONLY_RE =
  /id:\s*["']([a-z0-9-]+)["'](?:(?!id:\s*["'])[\s\S]){0,400}?desktopOnly:\s*true/g
/**
 * A dispatch arm label, including the multi-pattern form `"a" | "b" | "c" =>`.
 * Matching only `"name" =>` silently drops every name but the last, and there
 * are 9 such arms in `rpc/` — each one a command that would look ungated.
 */
const RUST_ARM_RE = /((?:"[a-z][a-z0-9_]*"\s*\|\s*)*"[a-z][a-z0-9_]*")\s*=>/g

/**
 * Two idioms mean "this arm needs the desktop", and they read almost alike:
 *
 *   let app = host.tauri_app(name)?;                       // the common one
 *   if host.headless().is_some() { return Err(…) }         // belt-and-braces,
 *                                                          // e.g. automation_consent_*
 *
 * And exactly one idiom means the opposite — "this arm is headless-only":
 *
 *   host.headless().ok_or_else(|| RpcError::headless_host_required(name))?
 *
 * The discriminator is `.ok_or_else(` vs `.is_some()`. Matching `host.headless()`
 * loosely conflates them and reports the same arm on both sides.
 *
 * BOTH error constructors are accepted on the headless-only side. The arms were
 * originally written with `headless_unsupported` in both directions — so a
 * desktop caller was told to "use the desktop app" while running on it — and the
 * split into `headless_host_required` renames roughly a hundred arms without
 * changing one thing about their availability. Keying the gate on the error name
 * alone would read that rename as a hundred closed gaps.
 *
 * rustfmt breaks the builder across lines once it exceeds the width —
 *
 *   let services = host
 *       .headless()
 *       .ok_or_else(|| RpcError::headless_unsupported(name))?;
 *
 * so every receiver/method boundary below tolerates whitespace. Matching
 * `host\.headless\(\)` literally silently missed 4 of every 5 real gates.
 */
const H = String.raw`host\s*\.\s*`
const TAURI_APP_GATE_RE = new RegExp(`${H}tauri_app\\s*\\(`, "g")
const HEADLESS_REJECT_RE = new RegExp(`${H}headless\\s*\\(\\)\\s*\\.\\s*is_some\\s*\\(\\)`, "g")
const HEADLESS_GATE_RE = new RegExp(
  `${H}headless\\s*\\(\\)\\s*\\.\\s*ok_or_else\\s*\\(\\s*\\|\\|\\s*RpcError::` +
    `(?:headless_unsupported|headless_host_required)`,
  "g"
)
const GUARD_RE = /\b(isTauri|isHeadlessHost|usePlatform)\s*\(/g

/** @returns {string[]} tracked repo-relative paths */
function trackedFiles() {
  return execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64e6 })
    .split("\n")
    .filter(Boolean)
}

/** A file that exists to be tested or previewed, never shipped as a host path. */
export function isAuxiliaryFile(path) {
  return /\.(test|spec|stories)\.[tj]sx?$/.test(path) || path.includes("/__mocks__/")
}

/** Renderer source we expect to run on every host. */
export function isRendererSource(path) {
  if (isAuxiliaryFile(path)) return false
  if (!/\.[tj]sx?$/.test(path)) return false
  return /^(lib|components|hooks|stores|app|packages|plugins)\//.test(path)
}

/**
 * Subsystem key for a repo path: the first two segments, which lines up with
 * CLAUDE.md's Subsystem Map (`lib/connectors`, `components/settings`, …).
 *
 * @param {string} path
 * @returns {string}
 */
export function subsystemOf(path) {
  const parts = path.split("/")
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0]
}

// ---------------------------------------------------------------------------
// Class A — transport-seam bypass
// ---------------------------------------------------------------------------

/**
 * @param {string[]} files
 * @param {{ read: (p: string) => string }} io
 * @returns {string[]} finding keys
 */
export function findSeamBypasses(files, io) {
  const owners = new Set(SEAM_OWNERS)
  const out = []
  for (const path of files) {
    if (!isRendererSource(path) || owners.has(path)) continue
    if (TAURI_IMPORT_RE.test(io.read(path))) out.push(`A:${path}`)
  }
  return out.sort()
}

// ---------------------------------------------------------------------------
// Class B — UI hard-coded to a host
// ---------------------------------------------------------------------------

/**
 * @param {string} source contents of components/settings/settings-nav-config.ts
 * @returns {string[]} finding keys
 */
export function findDesktopOnlySections(source) {
  const out = []
  for (const match of source.matchAll(DESKTOP_ONLY_RE)) out.push(`B:${match[1]}`)
  return [...new Set(out)].sort()
}

// ---------------------------------------------------------------------------
// Class C — one-sided RPC arms
// ---------------------------------------------------------------------------

/**
 * Attribute each host gate to the dispatch arms it guards.
 *
 * A gate appearing BEFORE the first arm label is a module-level gate (e.g.
 * `rpc/codex_app.rs` gates its whole family at the top of dispatch), so it is
 * attributed to every arm in that file rather than to none.
 *
 * @param {string} source Rust source of one rpc module
 * @returns {Array<{ command: string, side: "desktop-only" | "headless-only" }>}
 */
export function parseHostGatedArms(source) {
  // One label may carry several names (`"a" | "b" =>`); they share an offset,
  // so a gate inside that arm is attributed to every name it dispatches.
  const arms = [...source.matchAll(RUST_ARM_RE)].flatMap((m) =>
    [...m[1].matchAll(/"([a-z][a-z0-9_]*)"/g)].map((n) => ({
      name: n[1],
      at: m.index ?? 0,
    }))
  )
  if (arms.length === 0) return []

  /** @param {RegExp} re @param {"desktop-only"|"headless-only"} side */
  const attribute = (re, side) => {
    const found = []
    for (const gate of source.matchAll(re)) {
      const at = gate.index ?? 0
      const preceding = arms.filter((a) => a.at < at)
      if (preceding.length === 0) {
        // Module-level gate: guards the whole family.
        for (const arm of arms) found.push({ command: arm.name, side })
        continue
      }
      // Every name on the nearest preceding label — a multi-pattern arm
      // dispatches them all through the same gated body.
      const nearest = preceding[preceding.length - 1].at
      for (const arm of preceding.filter((a) => a.at === nearest)) {
        found.push({ command: arm.name, side })
      }
    }
    return found
  }

  return [
    ...attribute(TAURI_APP_GATE_RE, "desktop-only"),
    ...attribute(HEADLESS_REJECT_RE, "desktop-only"),
    ...attribute(HEADLESS_GATE_RE, "headless-only"),
  ]
}

/**
 * `"name" =>` also matches things that are not dispatch arms — `rpc.rs:2519`
 * maps error codes to HTTP status the same way (`"spawn_failed" | … =>`), and
 * those sit close enough to a host gate to be mis-attributed. Cross-checking
 * against the real command surface (manifest ∪ generate_handler!) removes the
 * whole class rather than blacklisting names one at a time.
 *
 * @param {Array<{ path: string, source: string }>} modules
 * @param {Map<string, { target?: string, transports?: string[] }>} manifest
 * @param {Set<string>} knownCommands
 * @returns {{ findings: string[], remotelyReachable: string[] }}
 */
export function findOneSidedArms(modules, manifest, knownCommands = new Set()) {
  /** @type {Map<string, Set<string>>} */
  const bySide = new Map()
  for (const { source } of modules) {
    for (const { command, side } of parseHostGatedArms(source)) {
      if (!bySide.has(side)) bySide.set(side, new Set())
      bySide.get(side).add(command)
    }
  }

  const findings = []
  const remotelyReachable = []
  const isRealCommand = (name) => manifest.has(name) || knownCommands.has(name)
  for (const [side, commands] of bySide) {
    for (const command of commands) {
      if (!isRealCommand(command)) continue
      findings.push(`C:${command}:${side}`)
      // A headless-only arm that a paired device can address over the wire is
      // not bookkeeping — the remote client gets a 503 whose message names the
      // opposite host.
      const entry = manifest.get(command)
      const remote = (entry?.transports ?? []).some((t) =>
        ["http", "websocket", "webrtc"].includes(t)
      )
      if (side === "headless-only" && entry?.target === "execution" && remote) {
        remotelyReachable.push(command)
      }
    }
  }
  return { findings: findings.sort(), remotelyReachable: remotelyReachable.sort() }
}

// ---------------------------------------------------------------------------
// Class D — runtime-guard census (map only, never gates)
// ---------------------------------------------------------------------------

/**
 * @param {string[]} files
 * @param {{ read: (p: string) => string }} io
 * @returns {Map<string, { files: number, sites: number }>} keyed by subsystem
 */
export function censusRuntimeGuards(files, io) {
  /** @type {Map<string, { files: number, sites: number }>} */
  const census = new Map()
  for (const path of files) {
    if (!isRendererSource(path)) continue
    const sites = [...io.read(path).matchAll(GUARD_RE)].length
    if (sites === 0) continue
    const key = subsystemOf(path)
    const row = census.get(key) ?? { files: 0, sites: 0 }
    row.files += 1
    row.sites += sites
    census.set(key, row)
  }
  return census
}

// ---------------------------------------------------------------------------
// Class E — capability tables vs. the manifest
// ---------------------------------------------------------------------------

/**
 * A host feature that gates itself to `tauri` while none of its operations is
 * actually desktop-gated is UNDER-REPORTING: the command works headless and
 * the negotiating client is told it does not.
 *
 * @param {Array<{ feature: string, hosts: string[], operations: string[] }>} features
 * @param {Set<string>} desktopGatedCommands commands behind `host.tauri_app(...)`
 * @returns {string[]} finding keys
 */
export function findCapabilityMisreports(features, desktopGatedCommands) {
  const out = []
  for (const { feature, hosts, operations } of features) {
    const tauriOnly = hosts.length === 1 && hosts[0] === "tauri"
    if (!tauriOnly || operations.length === 0) continue
    const anyDesktopGated = operations.some((op) => desktopGatedCommands.has(op))
    if (!anyDesktopGated) out.push(`E:${feature}:under-reported-headless`)
  }
  return out.sort()
}

// ---------------------------------------------------------------------------
// Baseline plumbing (mirrors check-unreachable-components.mjs)
// ---------------------------------------------------------------------------

export function readBaseline(read = () => readFileSync(BASELINE_FILE, "utf8")) {
  if (!existsSync(BASELINE_FILE)) return { version: 1, findings: [] }
  try {
    const parsed = JSON.parse(read())
    return { version: parsed.version ?? 1, findings: parsed.findings ?? [] }
  } catch {
    return { version: 1, findings: [] }
  }
}

/**
 * @param {string[]} findings
 * @param {string[]} baseline
 * @returns {{ added: string[], fixed: string[] }}
 */
export function diffAgainstBaseline(findings, baseline) {
  const now = new Set(findings)
  const known = new Set(baseline)
  return {
    added: findings.filter((f) => !known.has(f)).sort(),
    fixed: baseline.filter((f) => !now.has(f)).sort(),
  }
}

export function writeBaseline(findings) {
  const payload = {
    version: 1,
    note:
      "Known headless↔desktop parity gaps, recorded when the gate landed. This list may only " +
      "shrink: `pnpm audit:host-parity` reports (and, once ENFORCE_RATCHET flips, fails on) any " +
      "new one. Keys are `A:<path>` seam bypass, `B:<section>` desktop-only UI, " +
      "`C:<command>:<side>` one-sided RPC arm, `E:<feature>:<kind>` capability misreport. " +
      "Regenerate with `pnpm audit:host-parity:baseline` after paying debt down.",
    findings: [...findings].sort(),
  }
  writeFileSync(BASELINE_FILE, `${JSON.stringify(payload, null, 2)}\n`)
  return payload
}

/**
 * Every subsystem the census surfaces must carry a recorded judgment. An
 * unannotated subsystem is a gap nobody has classified.
 *
 * @param {Map<string, unknown>} census
 * @param {Record<string, { classification?: string }>} annotations
 * @returns {{ missing: string[], invalid: string[], stale: string[] }}
 */
export function checkAnnotations(census, annotations) {
  const missing = []
  const invalid = []
  for (const key of census.keys()) {
    const row = annotations[key]
    if (!row) {
      missing.push(key)
      continue
    }
    if (!CLASSIFICATIONS.includes(row.classification)) invalid.push(key)
  }
  const stale = Object.keys(annotations).filter((k) => !census.has(k))
  return { missing: missing.sort(), invalid: invalid.sort(), stale: stale.sort() }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** @returns {{ findings: string[], census: Map<string, {files:number,sites:number}>, remotelyReachable: string[], desktopGated: Set<string> }} */
export function collect(files, io) {
  const findings = [...findSeamBypasses(files, io)]

  const navConfig = io.read("components/settings/settings-nav-config.ts")
  findings.push(...findDesktopOnlySections(navConfig))

  const rpcModules = files
    .filter(
      (p) =>
        /^src-tauri\/src\/companion_api\/rpc(\/|\.rs$)/.test(p) &&
        p.endsWith(".rs") &&
        // rpc/tests.rs enumerates command names as fixtures, not dispatch arms.
        !p.endsWith("/tests.rs")
    )
    .map((path) => ({ path, source: io.read(path) }))

  /** @type {Map<string, any>} */
  const manifest = new Map()
  try {
    const raw = JSON.parse(io.read("protocol/companion-commands.json"))
    for (const cmd of raw.commands ?? []) manifest.set(cmd.name, cmd)
  } catch {
    /* manifest unreadable — class C still reports, just without remote flagging */
  }

  let registered = new Set()
  try {
    registered = new Set(parseRegisteredCommands(io.read("src-tauri/src/lib.rs")))
  } catch {
    /* fall back to manifest-only membership */
  }

  const { findings: armFindings, remotelyReachable } = findOneSidedArms(
    rpcModules,
    manifest,
    registered
  )
  findings.push(...armFindings)

  const desktopGated = new Set(
    armFindings.filter((f) => f.endsWith(":desktop-only")).map((f) => f.split(":")[1])
  )
  findings.push(...findCapabilityMisreports(parseHostFeatures(io), desktopGated))

  return {
    findings: [...new Set(findings)].sort(),
    census: censusRuntimeGuards(files, io),
    remotelyReachable,
    desktopGated,
  }
}

/**
 * Extract per-host feature declarations from `lib/platform/host-feature-manifest.ts`.
 * The file guards each feature with `if (platform === "…")`, so the hosts a
 * feature claims are the platforms named in its enclosing guard.
 *
 * @param {{ read: (p: string) => string }} io
 * @returns {Array<{ feature: string, hosts: string[], operations: string[] }>}
 */
export function parseHostFeatures(io) {
  const source = io.read("lib/platform/host-feature-manifest.ts")
  const out = []
  const blockRe = /if\s*\(([^)]*platform\s*===[^)]*)\)\s*\{([\s\S]*?)\n {2}\}/g
  for (const block of source.matchAll(blockRe)) {
    const hosts = [...block[1].matchAll(/platform\s*===\s*["']([a-z]+)["']/g)].map((m) => m[1])
    for (const feat of block[2].matchAll(
      /features\[["']([^"']+)["']\]\s*=\s*\{([\s\S]*?)\n {4}\}/g
    )) {
      const operations = [...feat[2].matchAll(/["']([a-z][a-z0-9_]*)["']/g)].map((m) => m[1])
      out.push({ feature: feat[1], hosts, operations })
    }
  }
  return out
}

export function main(argv = []) {
  const io = {
    read: (p) => {
      try {
        return readFileSync(join(REPO_ROOT, p), "utf8")
      } catch {
        return ""
      }
    },
  }
  const files = trackedFiles()
  const { findings, census, remotelyReachable } = collect(files, io)

  if (argv.includes("--write-baseline")) {
    const payload = writeBaseline(findings)
    console.log(`[host-parity] baseline written: ${payload.findings.length} known gap(s)`)
    return 0
  }

  const annotations = (() => {
    try {
      return JSON.parse(io.read("scripts/gates/host-parity-annotations.json")).subsystems ?? {}
    } catch {
      return {}
    }
  })()
  const annotationStatus = checkAnnotations(census, annotations)

  if (argv.includes("--report")) {
    printReport(findings, census, remotelyReachable, annotations, annotationStatus)
    return 0
  }

  const baseline = readBaseline()
  const { added, fixed } = diffAgainstBaseline(findings, baseline.findings)

  if (fixed.length) {
    console.log(
      `[host-parity] ${fixed.length} baselined gap(s) are closed — ` +
        "run `pnpm audit:host-parity:baseline` to lock the gain in."
    )
  }
  if (remotelyReachable.length) {
    console.log(
      `[host-parity] NOTE: ${remotelyReachable.length} headless-only arm(s) are ` +
        "`target=execution` over http/ws/webrtc — a remote client on a DESKTOP host reaches " +
        "them and gets a 503 naming the opposite host:"
    )
    for (const c of remotelyReachable) console.log(`    ${c}`)
  }
  if (annotationStatus.missing.length) {
    console.log(
      `[host-parity] ${annotationStatus.missing.length} subsystem(s) have host guards but no ` +
        "recorded classification in host-parity-annotations.json:"
    )
    for (const s of annotationStatus.missing) console.log(`    ${s}`)
  }
  if (annotationStatus.invalid.length) {
    console.error(
      `[host-parity] ${annotationStatus.invalid.length} annotation(s) carry an unknown ` +
        `classification (expected one of ${CLASSIFICATIONS.join(", ")}):`
    )
    for (const s of annotationStatus.invalid) console.error(`    ${s}`)
    return 1
  }

  if (added.length) {
    const verb = ENFORCE_RATCHET ? "FAIL" : "REPORT-ONLY"
    console.error(`[host-parity] ${verb}: ${added.length} new parity gap(s):`)
    for (const f of added) console.error(`  ${f}`)
    console.error(
      "\n  A: route the call through `transport` (lib/tauri) instead of importing\n" +
        "     `invoke`/`listen` directly — a direct import throws on every non-Tauri host.\n" +
        "  B: declare the capability the section needs instead of keying it to the host.\n" +
        "  C: give the arm a host-neutral accessor on `DispatchHost` (see `sidecar_state()`).\n" +
        "  E: the feature works headless — stop gating its declaration to `tauri`.\n" +
        "  If the gap is genuinely physical, record it in host-parity-annotations.json\n" +
        "  and re-baseline."
    )
    return ENFORCE_RATCHET ? 1 : 0
  }

  console.log(
    `[host-parity] OK: ${findings.length} known gap(s), none new ` +
      `(baseline holds ${baseline.findings.length}); ` +
      `${census.size} subsystem(s) carry host guards.`
  )
  return 0
}

function printReport(findings, census, remotelyReachable, annotations, annotationStatus) {
  const byClass = new Map()
  for (const f of findings) {
    const cls = f[0]
    if (!byClass.has(cls)) byClass.set(cls, [])
    byClass.get(cls).push(f)
  }
  const titles = {
    A: "transport-seam bypass (throws on every non-Tauri host)",
    B: "UI hard-coded to a host",
    C: "one-sided RPC arm",
    E: "capability table vs. manifest",
  }
  for (const cls of ["A", "B", "C", "E"]) {
    const rows = byClass.get(cls) ?? []
    console.log(`\n== Class ${cls}: ${titles[cls]} — ${rows.length}`)
    for (const r of rows) console.log(`   ${r.slice(2)}`)
  }
  console.log(`\n== Class D: runtime-guard census (map only, never gates)`)
  const sorted = [...census.entries()].sort((a, b) => b[1].sites - a[1].sites)
  for (const [key, row] of sorted) {
    const cls = annotations[key]?.classification ?? "UNANNOTATED"
    console.log(
      `   ${String(row.sites).padStart(5)} sites / ${String(row.files).padStart(3)} files  ${key}  [${cls}]`
    )
  }
  const totals = sorted.reduce(
    (acc, [, r]) => ({ sites: acc.sites + r.sites, files: acc.files + r.files }),
    { sites: 0, files: 0 }
  )
  console.log(
    `   ----- ${totals.sites} sites across ${totals.files} files, ${census.size} subsystems`
  )
  if (remotelyReachable.length) {
    console.log(`\n== Remotely reachable headless-only arms — ${remotelyReachable.length}`)
    for (const c of remotelyReachable) console.log(`   ${c}`)
  }
  if (annotationStatus.stale.length) {
    console.log(
      `\n== Stale annotations (subsystem no longer has guards) — ${annotationStatus.stale.length}`
    )
    for (const s of annotationStatus.stale) console.log(`   ${s}`)
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-host-parity.mjs")
) {
  process.exit(main(process.argv.slice(2)))
}
