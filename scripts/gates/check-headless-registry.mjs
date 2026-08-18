#!/usr/bin/env node
/**
 * Gate: a runtime side-effect wired only into a React provider initializer is
 * desktop-only, even when the `lib/` code behind it is perfectly host-neutral.
 *
 * ## Why this exists
 *
 * ADR-0059 ("Cloud Deployment — Headless Brain") ends on a hard rule:
 *
 * > new runtime side-effects must register through the headless bootstrap
 * > registry, not raw provider effects — enforce via the wiring audit.
 *
 * That enforcement was the `wiring-auditor` subagent — advisory, invoked by
 * hand, and therefore skipped exactly when a change is large enough to matter.
 * Every other ADR-0059 invariant (command manifest, RPC semantic parity, host
 * parity, capability tables) has a hard gate. This one did not, and the drift
 * was not hypothetical: the whole ADR-0132 issue-tracker runtime — run bridge,
 * four federation sources, notifications, notification commands, GitHub
 * schedule sync, label seeding — booted only in the WebView, so a cloud
 * install ran an issue tracker that never drove a single run. ADR-0045's plan
 * notification actions shipped the same way in the same week.
 *
 * The failure is invisible by construction. Nothing throws: the desktop wires
 * the effect, its tests pass against the desktop wiring, and the brain simply
 * never calls it. Only a reachability question exposes it.
 *
 * ## What this checks
 *
 * For every `components/providers/initializers/*.tsx`, take each symbol it
 * imports from `@/lib/**` whose name reads as a runtime side-effect
 * (`installX` / `startX` / `registerX` / …) AND which the initializer actually
 * calls. That symbol is DORMANT when nothing inside the brain's own module
 * graph calls it.
 *
 * The brain's module graph is computed transitively from the real boot roots —
 * `lib/headless/**` and `cli/src/serve/**` — following static imports AND
 * dynamic `import("…")`, because the headless runtimes deliberately lazy-load
 * their heavy dependencies (`managed-ide-broker` reaches
 * `lib/plugin/ide/broker-runtime` that way).
 *
 * ## Why "is it called", not "is the module reachable"
 *
 * Both weaker rules give wrong answers, in opposite directions:
 *
 *   - Module reachability alone MISSES `installPlanNotificationActions`:
 *     `lib/agent/plan/notify.ts` is reachable from the brain for its other
 *     exports, while the install function itself has one caller — the
 *     provider. Reachable module, dormant effect.
 *   - Call-site search alone (without the reachable set) FLAGS
 *     `ensureEditorLspRuntime`, which is genuinely wired: the brain reaches it
 *     through `managed-ide-broker` → `broker-runtime` → `protocol-runtime`.
 *     Dormant-looking, actually live.
 *
 * The definition that survives both is the one implemented here: called from
 * inside the reachable set.
 *
 * ## Exclusions are per-symbol and carry reasons
 *
 * A genuinely desktop-bound effect (the tray, the selection toolbar, WebView
 * liveness) belongs in `headless-registry-exclusions.json` WITH a reason. This
 * follows `protocol/headless-command-dispositions.json`'s rule, and for the
 * same motive: an unreasoned entry records that someone silenced the gate, not
 * that someone made a decision. A reason under 20 characters is rejected.
 *
 * Exclusions name SYMBOLS, not just files, because the two often mix inside
 * one initializer. `issue-tracker-initializer` boots nine effects: eight are
 * pure brain work, and `installIssueNotificationCommands` needs the App Router
 * to navigate. A file-level excuse would have silenced the eight along with
 * the one — precisely the outcome this gate exists to prevent.
 *
 * Unlike the other ADR-0059 gates this one has no baseline and does not
 * ratchet — it starts clean, because the debt it would have baselined was paid
 * down in the change that introduced it.
 *
 * Usage:
 *   pnpm audit:headless-registry            # check
 *   pnpm audit:headless-registry -- --list  # show every effect and its verdict
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve, relative } from "node:path"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

export const EXCLUSIONS_FILE = join(REPO_ROOT, "scripts/gates/headless-registry-exclusions.json")

/** Where the desktop shell declares its boot effects. */
export const INITIALIZER_DIR = "components/providers/initializers"

/**
 * The brain's boot roots. `lib/headless/**` is the runtime registry and every
 * runtime that registers into it; `cli/src/serve/**` is the `cognia-agent
 * serve` process that imports it. Anything either can reach, the brain runs.
 */
export const BRAIN_ROOTS = ["lib/headless", "cli/src/serve"]

/**
 * Name shapes that read as "this starts something that keeps running".
 *
 * Deliberately verb-prefixed rather than a curated symbol list: a curated list
 * is a second thing to maintain, and the whole point is to catch effects
 * nobody remembered to wire. The `[A-Z]` tail keeps `install` / `start` used
 * as bare local variables out of the match.
 */
export const EFFECT_PATTERN =
  /^(install|start|init|register|schedule|ensure|boot|resume|seed|sync|watch|activate|reconcile|attach|mount|drain|subscribe)[A-Z]/

const SOURCE_EXT = /\.tsx?$/
const TEST_FILE = /\.(test|stories)\.tsx?$/

/**
 * Resolve an import specifier to a file on disk. Handles the `@/` alias and
 * relative paths; bare package specifiers resolve to null (not our graph).
 *
 * @param {string} spec @param {string} fromFile @returns {string | null}
 */
export function resolveSpecifier(spec, fromFile) {
  let base
  if (spec.startsWith("@/")) base = join(REPO_ROOT, spec.slice(2))
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec)
  else return null
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Every in-repo module `file` imports, static or dynamic.
 *
 * @param {string} file @param {(f: string) => string} read @returns {string[]}
 */
export function moduleImports(file, read) {
  let source
  try {
    source = read(file)
  } catch {
    return []
  }
  const out = []
  const patterns = [
    /from\s*["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /require\(\s*["']([^"']+)["']\s*\)/g,
  ]
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      const resolved = resolveSpecifier(m[1], file)
      if (resolved) out.push(resolved)
    }
  }
  return out
}

/** Recursively collect source files under `dir`, skipping tests and stories. */
function collectSources(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) collectSources(p, out)
    else if (SOURCE_EXT.test(entry.name) && !TEST_FILE.test(entry.name)) out.push(p)
  }
  return out
}

/**
 * Transitive closure of the brain's module graph.
 *
 * @param {string[]} roots absolute file paths
 * @param {(f: string) => string} read
 * @returns {Set<string>}
 */
export function reachableFrom(roots, read) {
  const seen = new Set()
  const stack = [...roots]
  while (stack.length) {
    const file = stack.pop()
    if (seen.has(file)) continue
    seen.add(file)
    for (const dep of moduleImports(file, read)) {
      if (!seen.has(dep)) stack.push(dep)
    }
  }
  return seen
}

/**
 * Runtime-effect symbols an initializer imports from `@/lib/**` and calls.
 *
 * Type-only imports are skipped: `import type { StartFooOptions }` is not an
 * effect, and flagging it would train people to silence the gate.
 *
 * @param {string} source @returns {string[]}
 */
export function effectSymbols(source) {
  const found = new Set()
  const importRe = /import\s+(type\s+)?\{([^}]+)\}\s*from\s*["'](@\/lib\/[^"']+)["']/g
  for (const m of source.matchAll(importRe)) {
    if (m[1]) continue
    for (const clause of m[2].split(",")) {
      const trimmed = clause.trim()
      if (!trimmed || trimmed.startsWith("type ")) continue
      const local = trimmed
        .split(/\s+as\s+/)
        .pop()
        .trim()
      if (!EFFECT_PATTERN.test(local)) continue
      // Imported but never invoked is not an effect this gate owns.
      if (!new RegExp(`\\b${local}\\s*\\(`).test(source)) continue
      found.add(local)
    }
  }
  return [...found]
}

/**
 * Is `symbol` invoked anywhere in the brain's reachable set?
 *
 * A module's own `export function symbol(` declaration does not count as a
 * call — otherwise every effect would look wired the moment the brain reached
 * the file that defines it, which is precisely the `installPlanNotificationActions`
 * false negative this gate exists to avoid.
 *
 * @param {string} symbol @param {Map<string, string>} corpus reachable file → contents
 */
export function calledInBrain(symbol, corpus) {
  const call = new RegExp(`\\b${symbol}\\s*\\(`)
  const declaration = new RegExp(
    `export\\s+(async\\s+)?function\\s+${symbol}\\b|export\\s+(const|let)\\s+${symbol}\\b`
  )
  for (const [, source] of corpus) {
    if (!call.test(source)) continue
    if (declaration.test(source)) {
      // The defining module. It counts only if it also calls the symbol
      // somewhere other than the declaration itself.
      const withoutDecl = source.replace(
        new RegExp(
          `export\\s+(async\\s+)?function\\s+${symbol}\\s*\\([^)]*\\)|export\\s+(const|let)\\s+${symbol}\\s*=`,
          "g"
        ),
        ""
      )
      if (!call.test(withoutDecl)) continue
    }
    return true
  }
  return false
}

/** @returns {{ initializers: Record<string, { symbols: string[], reason: string }> }} */
export function readExclusions() {
  if (!existsSync(EXCLUSIONS_FILE)) return { initializers: {} }
  return JSON.parse(readFileSync(EXCLUSIONS_FILE, "utf8"))
}

export const MIN_REASON_LENGTH = 20

/**
 * Split findings into what still violates and what the ledger accounts for.
 * Pure, so the test can drive every branch without touching disk.
 *
 * @param {Array<{ file: string, symbols: string[] }>} findings
 * @param {Record<string, { symbols?: string[], reason?: string }>} exclusions
 */
export function reconcile(findings, exclusions) {
  const violations = []
  for (const finding of findings) {
    const excused = new Set(exclusions[finding.file]?.symbols ?? [])
    const remaining = finding.symbols.filter((s) => !excused.has(s))
    if (remaining.length) violations.push({ file: finding.file, symbols: remaining })
  }

  // A stale row claims a decision about an effect that is no longer dormant —
  // it was wired, renamed, or deleted. Left in place it silences the gate for
  // whatever takes that symbol's name next.
  const stale = []
  for (const [file, entry] of Object.entries(exclusions)) {
    const finding = findings.find((f) => f.file === file)
    if (!finding) {
      stale.push({ file, symbols: entry.symbols ?? [] })
      continue
    }
    const gone = (entry.symbols ?? []).filter((s) => !finding.symbols.includes(s))
    if (gone.length) stale.push({ file, symbols: gone })
  }

  const unreasoned = Object.entries(exclusions)
    .filter(([, v]) => !v.reason || v.reason.trim().length < MIN_REASON_LENGTH)
    .map(([file]) => file)

  const symbolless = Object.entries(exclusions)
    .filter(([, v]) => !Array.isArray(v.symbols) || v.symbols.length === 0)
    .map(([file]) => file)

  return { violations, stale, unreasoned, symbolless }
}

/**
 * Full analysis. Exported so the test can drive it without a fixture repo.
 *
 * @param {{ read?: (f: string) => string }} [opts]
 */
export function analyze(opts = {}) {
  const read = opts.read ?? ((f) => readFileSync(f, "utf8"))
  const cache = new Map()
  const cachedRead = (f) => {
    if (!cache.has(f)) cache.set(f, read(f))
    return cache.get(f)
  }

  const roots = BRAIN_ROOTS.flatMap((r) => collectSources(join(REPO_ROOT, r)))
  const reachable = reachableFrom(roots, cachedRead)

  // Corpus the call-site search runs over: the reachable set minus the
  // initializer directory (a provider calling its own effect proves nothing)
  // and minus tests.
  const initDirAbs = join(REPO_ROOT, INITIALIZER_DIR)
  const corpus = new Map()
  for (const file of reachable) {
    if (file.startsWith(initDirAbs)) continue
    if (TEST_FILE.test(file)) continue
    try {
      corpus.set(file, cachedRead(file))
    } catch {
      /* unreadable file contributes nothing */
    }
  }

  const findings = []
  for (const file of collectSources(initDirAbs)) {
    const source = cachedRead(file)
    const rel = relative(REPO_ROOT, file)
    const dormant = effectSymbols(source).filter((s) => !calledInBrain(s, corpus))
    if (dormant.length) findings.push({ file: rel, symbols: dormant.sort() })
  }
  findings.sort((a, b) => a.file.localeCompare(b.file))
  return { findings, reachableCount: reachable.size }
}

function main(argv) {
  const listAll = argv.includes("--list")
  const { findings, reachableCount } = analyze()
  const exclusions = readExclusions().initializers ?? {}

  if (listAll) {
    console.log(`[headless-registry] brain graph: ${reachableCount} modules\n`)
    for (const f of findings) {
      const excused = new Set(exclusions[f.file]?.symbols ?? [])
      console.log(f.file)
      for (const s of f.symbols) {
        console.log(`         ${excused.has(s) ? "EXCLUDED" : "DORMANT "} ${s}`)
      }
      if (exclusions[f.file]) console.log(`         reason: ${exclusions[f.file].reason}`)
    }
    return 0
  }

  const { violations, stale, unreasoned, symbolless } = reconcile(findings, exclusions)

  let failed = false

  if (symbolless.length) {
    console.error(
      `[headless-registry] ${symbolless.length} exclusion(s) name no symbols — an exclusion ` +
        "excuses specific effects, never a whole file:"
    )
    for (const file of symbolless) console.error(`  ${file}`)
    failed = true
  }

  if (unreasoned.length) {
    console.error(
      `[headless-registry] ${unreasoned.length} exclusion(s) carry no usable reason ` +
        `(minimum ${MIN_REASON_LENGTH} characters):`
    )
    for (const file of unreasoned) console.error(`  ${file}`)
    failed = true
  }

  if (stale.length) {
    console.error(
      `[headless-registry] ${stale.length} exclusion(s) no longer match a dormant effect — ` +
        "the effect was wired, renamed, or deleted. Drop the row or the listed symbols:"
    )
    for (const { file, symbols } of stale) {
      console.error(`  ${file}${symbols.length ? `  [${symbols.join(", ")}]` : ""}`)
    }
    failed = true
  }

  if (violations.length) {
    console.error(
      `[headless-registry] ${violations.length} initializer(s) install runtime effects the ` +
        "headless brain never runs:"
    )
    for (const v of violations) {
      console.error(`  ${v.file}`)
      for (const s of v.symbols) console.error(`      ${s}`)
    }
    console.error(
      "\n  ADR-0059: new runtime side-effects must register through the headless\n" +
        "  bootstrap registry, not raw provider effects. Either register the effect in\n" +
        "  lib/headless/runtimes/ (the provider then stays a thin wrapper), or add the\n" +
        "  initializer to scripts/gates/headless-registry-exclusions.json WITH a reason\n" +
        "  saying why the brain must not run it."
    )
    failed = true
  }

  if (failed) return 1

  console.log(
    `[headless-registry] OK: every provider runtime effect is reachable from the brain ` +
      `(${reachableCount} modules) or excluded with a reason ` +
      `(${Object.keys(exclusions).length} excluded).`
  )
  return 0
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-headless-registry.mjs")
) {
  process.exit(main(process.argv.slice(2)))
}
