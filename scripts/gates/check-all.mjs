#!/usr/bin/env node
/**
 * Local aggregate gate — runs every read-only CI check in one command and
 * prints a single pass/fail summary so you see all failures at once instead
 * of fixing them one `pnpm run …` at a time.
 *
 * Gates (all read-only — none mutate the working tree):
 *   typecheck · lint · lint:i18n · i18n:build:check · audit:slots
 *   audit:trusted-publishers · audit:silent-flags · audit:command-parity
 *   lint:static-export
 *   lint:plugin-sdk-wit · release:sync-keys:check · version:sync:check
 *   config:sync:check
 *
 * Note: `i18n:sort:check` is intentionally NOT here — the message files are
 * not yet key-sorted, so it would always fail. Run `pnpm i18n:sort` once and
 * add it to GATES below if/when you adopt sorted message files.
 *
 * Behaviour:
 *   - Default: continue-on-error. Every gate runs; the summary lists ✓/✗ for
 *     each. Process exits 1 if any gate failed, 0 otherwise.
 *   - `--bail`: stop at the first failing gate (faster feedback loop).
 *
 * Usage:
 *   pnpm check:all
 *   pnpm check:all -- --bail
 */

import { spawnSync } from "node:child_process"

/** The ordered list of read-only gates. Each entry is a pnpm script name. */
export const GATES = [
  "typecheck",
  "lint",
  "lint:i18n",
  "i18n:build:check",
  "skills:check",
  "audit:slots",
  "audit:trusted-publishers",
  "audit:silent-flags",
  "audit:command-parity",
  "lint:static-export",
  "lint:plugin-sdk-wit",
  "release:sync-keys:check",
  "version:sync:check",
  "config:sync:check",
]

/**
 * Reduce raw gate results into an exit code + human summary.
 * Pure (no I/O) so it can be unit-tested.
 *
 * @param {Array<{ name: string, ok: boolean, skipped?: boolean }>} results
 * @returns {{ exitCode: number, summary: string }}
 */
export function summarize(results) {
  const lines = results.map((r) => {
    const mark = r.skipped ? "∅" : r.ok ? "✓" : "✗"
    const note = r.skipped ? " (skipped)" : ""
    return `  ${mark} ${r.name}${note}`
  })
  const failed = results.filter((r) => !r.skipped && !r.ok)
  const ran = results.filter((r) => !r.skipped)
  const header = failed.length
    ? `check:all — ${failed.length}/${ran.length} gate(s) FAILED`
    : `check:all — all ${ran.length} gate(s) passed`
  return {
    exitCode: failed.length ? 1 : 0,
    summary: [header, ...lines].join("\n"),
  }
}

/** Run a single pnpm script, inheriting stdio so its output streams live. */
function runGate(name) {
  // `pnpm` resolves to pnpm.cmd on Windows; shell:true lets the .cmd shim run.
  const res = spawnSync("pnpm", ["run", name], { stdio: "inherit", shell: true })
  return res.status === 0
}

function main(argv) {
  const bail = argv.includes("--bail")
  const results = []
  for (const name of GATES) {
    process.stdout.write(`\n=== ${name} ===\n`)
    const ok = runGate(name)
    results.push({ name, ok })
    if (!ok && bail) {
      // Mark the rest as skipped so the summary is honest about what ran.
      for (const rest of GATES.slice(GATES.indexOf(name) + 1)) {
        results.push({ name: rest, ok: false, skipped: true })
      }
      break
    }
  }
  const { exitCode, summary } = summarize(results)
  process.stdout.write(`\n${summary}\n`)
  process.exit(exitCode)
}

// Only auto-run when invoked directly (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-all.mjs")) {
  main(process.argv.slice(2))
}
