#!/usr/bin/env node
/**
 * Gate: clippy, ratcheted.
 *
 * The main workspace — 24 crates, ~200k lines of Rust — had never been linted.
 * 23 of them are linted here; `cognia-next` is excluded (see below).
 * `share-server` and `signaling-server` (two small standalone services) were
 * the only things in the repo running `clippy -D warnings`.
 *
 * A cold `-D warnings` would fail on ~250 findings, so this gate does what
 * the i18n and co-located-test gates do: record the current state and refuse
 * to let it get worse.
 *
 * ## Fingerprint choice
 *
 * The baseline counts warnings per (target, lint) pair — NOT per file:line.
 * A line-based fingerprint churns on every unrelated edit above it, which
 * makes the baseline noisy and trains people to regenerate it blindly. A pair
 * count is stable under refactoring while still catching "fixed five
 * `needless_borrow`s and introduced five `unwrap_used`s", which a bare total
 * would wave through.
 *
 * `cognia-next` (src-tauri) is excluded for the same reason as in the cargo
 * test job: its `tauri::generate_context!()` needs the Next.js static export
 * to exist at compile time.
 *
 * Usage:
 *   pnpm rust:clippy                              # check
 *   pnpm rust:clippy -- --write-baseline          # after fixing warnings
 *   pnpm rust:clippy -- --from-file clippy.json   # reuse a captured run
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
export const BASELINE_FILE = join(REPO_ROOT, "scripts", "gates", "clippy-baseline.json")

export const CARGO_ARGS = [
  "clippy",
  "--locked",
  "--workspace",
  "--exclude",
  "cognia-next",
  "--all-targets",
  "--message-format=json",
]

/**
 * Extract clippy warnings from `cargo --message-format=json` NDJSON. Pure.
 *
 * @param {string} ndjson
 * @returns {Array<{ target: string, lint: string }>}
 */
export function parseClippyWarnings(ndjson) {
  const warnings = []
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue // cargo interleaves non-JSON progress lines on some terminals
    }
    if (msg.reason !== "compiler-message") continue
    const diagnostic = msg.message
    if (!diagnostic || diagnostic.level !== "warning") continue
    // The rollup ("N warnings emitted") carries no code — counting it would
    // double-count everything it summarizes.
    const lint = diagnostic.code?.code
    if (!lint) continue
    warnings.push({ target: msg.target?.name ?? "unknown", lint })
  }
  return warnings
}

/**
 * Count warnings per (target, lint) pair. Pure.
 * @param {Array<{ target: string, lint: string }>} warnings
 * @returns {{ total: number, pairs: Record<string, number> }}
 */
export function tally(warnings) {
  const pairs = {}
  for (const w of warnings) {
    const key = `${w.target}::${w.lint}`
    pairs[key] = (pairs[key] ?? 0) + 1
  }
  const sorted = Object.fromEntries(Object.entries(pairs).sort(([a], [b]) => a.localeCompare(b)))
  return { total: warnings.length, pairs: sorted }
}

/**
 * Ratchet comparison. Pure.
 * @returns {{ regressions: Array<{ key: string, from: number, to: number }>, improvements: Array<{ key: string, from: number, to: number }> }}
 */
export function diffTally(current, baseline) {
  const regressions = []
  const improvements = []
  const keys = new Set([...Object.keys(current.pairs), ...Object.keys(baseline.pairs ?? {})])
  for (const key of [...keys].sort()) {
    const to = current.pairs[key] ?? 0
    const from = baseline.pairs?.[key] ?? 0
    if (to > from) regressions.push({ key, from, to })
    else if (to < from) improvements.push({ key, from, to })
  }
  return { regressions, improvements }
}

export function readBaseline(file = BASELINE_FILE) {
  if (!existsSync(file)) return { version: 1, total: 0, pairs: {} }
  return JSON.parse(readFileSync(file, "utf8"))
}

export function writeBaseline(counts, file = BASELINE_FILE) {
  const payload = {
    version: 1,
    note:
      "Pre-existing clippy warnings per (cargo target, lint) pair, recorded " +
      "when the gate landed. Counts may only go down: `pnpm rust:clippy` " +
      "fails if any pair grows or a new pair appears. Regenerate with " +
      "`pnpm rust:clippy -- --write-baseline` after fixing warnings.",
    total: counts.total,
    pairs: counts.pairs,
  }
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
  return payload
}

/** Run cargo clippy and return its NDJSON stdout. */
function runClippy() {
  const res = spawnSync("cargo", CARGO_ARGS, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 256e6,
    stdio: ["ignore", "pipe", "inherit"],
  })
  if (res.error) throw res.error
  // A non-zero exit means clippy hit a hard ERROR (not a warning) — the code
  // does not compile. That is never something to baseline.
  if (res.status !== 0) {
    console.error("[clippy] cargo clippy failed to complete — see the errors above.")
    process.exit(res.status ?? 1)
  }
  return res.stdout
}

export function main(argv = []) {
  const fromFileIndex = argv.indexOf("--from-file")
  const ndjson = fromFileIndex === -1 ? runClippy() : readFileSync(argv[fromFileIndex + 1], "utf8")

  const counts = tally(parseClippyWarnings(ndjson))

  if (argv.includes("--write-baseline")) {
    writeBaseline(counts)
    console.log(
      `[clippy] baseline written: ${counts.total} warning(s) across ` +
        `${Object.keys(counts.pairs).length} (target, lint) pair(s)`
    )
    return 0
  }

  const baseline = readBaseline()
  const { regressions, improvements } = diffTally(counts, baseline)

  if (improvements.length) {
    const fixed = improvements.reduce((n, i) => n + (i.from - i.to), 0)
    console.log(
      `[clippy] ${fixed} warning(s) fixed since the baseline — run ` +
        "`pnpm rust:clippy -- --write-baseline` to lock the gain in."
    )
  }

  if (regressions.length) {
    const added = regressions.reduce((n, r) => n + (r.to - r.from), 0)
    console.error(`[clippy] ${added} new warning(s) across ${regressions.length} lint(s):`)
    for (const r of regressions) {
      const [target, lint] = r.key.split("::")
      console.error(`  ${target}  ${lint}  ${r.from} → ${r.to}`)
    }
    console.error(
      "\n  Fix the new warnings. The baseline records pre-existing debt only\n" +
        "  and may not grow — see scripts/gates/clippy-baseline.json."
    )
    return 1
  }

  console.log(
    `[clippy] OK: ${counts.total} warning(s), none new (baseline holds ${baseline.total}).`
  )
  return 0
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-clippy.mjs")
) {
  process.exit(main(process.argv.slice(2)))
}
