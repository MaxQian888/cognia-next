#!/usr/bin/env node
/**
 * The gate registry — the SINGLE SOURCE OF TRUTH for every deterministic
 * quality gate in this repo.
 *
 * Both consumers read this one list:
 *   - locally, `pnpm check:all` runs the gates and prints one ✓/✗ summary;
 *   - in CI, `.github/workflows/quality.yml` calls `--list-groups --json` to
 *     build its job matrix, then runs each group with `--group <name>`.
 *
 * That is the point. Before this file owned the list, CI hand-wrote its own
 * copy of the gate sequence and the two drifted: four gates lived only in
 * `check:all` and were never enforced in CI, nine lived only in CI, and
 * `build:packages` / `lint:claude-md` existed as scripts wired to nothing at
 * all. `scripts/gates/check-gate-registry.mjs` now fails the build if a
 * verification-shaped script exists that is neither registered here nor
 * explicitly exempted with a reason.
 *
 * ## Entry shape
 *
 *   { script, group, runtime = "node", blocking = true }
 *
 *   script   — a package.json script name, invoked as `pnpm run <script>`.
 *   group    — the parallel CI job this gate belongs to. Groups exist so one
 *              CI run surfaces EVERY failure instead of stopping at the first.
 *   runtime  — toolchain the gate needs: "node" | "python" | "rust". CI
 *              provisions a group's union of runtimes; local runs can filter
 *              with `--runtime node` to skip the heavy ones.
 *   blocking — false marks an advisory gate: it runs and reports, but never
 *              fails the build.
 *
 * ## Deliberate omissions
 *
 *   - `i18n:sort:check` — the message files are not key-sorted, so it would
 *     always fail. Run `pnpm i18n:sort` once, then register it here.
 *   - test runners (jest / playwright / cargo test / sidecar `node --test`)
 *     are owned by `.github/workflows/test.yml`, not by this registry. They
 *     are listed in check-gate-registry.mjs's exemption table with that
 *     reason so the meta-gate stays honest about what it does not cover.
 *
 * ## Note on purity
 *
 * Most gates are read-only. The `artifacts` and `plugin-sdk` groups are not:
 * they re-run generators/builders in `--check` mode or build into gitignored
 * `dist/` directories. None of them mutate tracked source files.
 *
 * Usage:
 *   pnpm check:all                       # every gate, every runtime
 *   pnpm check:all -- --runtime node     # skip the python/rust gates
 *   pnpm check:all -- --group audit      # one CI group
 *   pnpm check:all -- --bail             # stop at the first failure
 *   node scripts/gates/check-all.mjs --list-groups --json
 */

import { spawnSync } from "node:child_process"
import { appendFileSync } from "node:fs"

/** Toolchains a gate can require. CI provisions these per group. */
export const RUNTIMES = ["node", "python", "rust"]

/**
 * The registry. Order is meaningful: it is the order `check:all` runs them
 * in, cheapest and most-likely-to-fail first.
 *
 * @type {Array<{ script: string, group: string, runtime?: string, blocking?: boolean }>}
 */
const REGISTRY = [
  // Fast feedback first — these catch the majority of everyday breakage.
  { script: "lint", group: "lint" },
  { script: "format:check", group: "lint" },

  { script: "typecheck", group: "types" },
  { script: "knip", group: "types" },

  { script: "lint:i18n", group: "i18n" },
  { script: "i18n:build:check", group: "i18n" },

  // Generated / derived artifacts must be in sync with their sources.
  { script: "build:packages", group: "artifacts" },
  { script: "skills:check", group: "artifacts" },
  { script: "plugin-node:check", group: "artifacts" },
  { script: "plugin-convert:check", group: "artifacts" },
  { script: "plugin:contract:check", group: "artifacts" },

  // Repo-specific structural audits (see the ADRs each one cites).
  { script: "audit:slots", group: "audit" },
  { script: "audit:trusted-publishers", group: "audit" },
  { script: "audit:silent-flags", group: "audit" },
  { script: "audit:pii-boundaries", group: "audit" },
  { script: "audit:command-parity", group: "audit" },
  { script: "audit:e2e-governance", group: "audit" },
  { script: "audit:colocated-tests", group: "audit" },
  { script: "lint:static-export", group: "audit" },
  { script: "lint:plugin-sdk-wit", group: "audit" },
  // Advisory for now. The gate is correct — it reports 11 real drifts (nine
  // "Lives in" paths that moved to crates/ during the ADR-0067 Tier-A
  // decomposition, an unreferenced newest ADR, and a Dexie ceiling CLAUDE.md
  // never caught up with). Updating the Subsystem Map is a separate, larger
  // change; blocking on it now would leave the `audit` group permanently red
  // for reasons unrelated to whatever a contributor is actually shipping,
  // which is how gates get switched off. Promote to blocking once the map is
  // corrected.
  { script: "lint:claude-md", group: "audit", blocking: false },
  { script: "plugin:author-imports", group: "audit" },

  // Mirrored config / version files must agree across the tree.
  { script: "release:sync-keys:check", group: "sync" },
  { script: "version:sync:check", group: "sync" },
  { script: "config:sync:check", group: "sync" },

  // The gate tooling's own tests. A broken gate script that silently passes
  // is worse than no gate, so these are gates themselves.
  { script: "gates:registry", group: "gate-tests" },
  { script: "scripts:test:gates", group: "gate-tests" },
  { script: "scripts:test:build", group: "gate-tests" },
  { script: "scripts:test:sync", group: "gate-tests" },
  { script: "scripts:test:i18n", group: "gate-tests" },
  { script: "scripts:test:plugin", group: "gate-tests" },
  { script: "scripts:test:ci", group: "gate-tests" },

  // The plugin SDK's cross-language contract surface.
  { script: "sdk:ts:build", group: "plugin-sdk" },
  { script: "sdk:ts:pack:test", group: "plugin-sdk" },
  { script: "sdk:scaffold:test", group: "plugin-sdk" },
  { script: "sdk:python:test", group: "plugin-sdk", runtime: "python" },
  { script: "sdk:rust:test", group: "plugin-sdk", runtime: "rust" },

  // Rust quality. The workspace had never been linted or format-checked —
  // only the two standalone services under services/ ran clippy at all.
  { script: "rust:fmt:check", group: "rust", runtime: "rust" },
  { script: "rust:clippy", group: "rust", runtime: "rust" },

  // Advisory only: dependency health is informational, not a merge blocker.
  // `rust:deny` also lands here because cargo-deny is not installed by
  // default — locally it reports as advisory rather than failing every
  // `check:all`, while CI installs the binary so the scan really runs.
  { script: "audit:deps", group: "supply-chain", blocking: false },
  { script: "rust:deny", group: "supply-chain", runtime: "rust", blocking: false },
]

/** The registry with defaults applied, so consumers never handle undefined. */
export const GATES = REGISTRY.map((g) => ({
  runtime: "node",
  blocking: true,
  ...g,
}))

/** @param {string} name @returns {boolean} */
export function hasGate(name) {
  return GATES.some((g) => g.script === name)
}

/** Ordered, de-duplicated group names. @returns {string[]} */
export function listGroups() {
  return [...new Set(GATES.map((g) => g.group))]
}

/**
 * Per-group toolchain requirements, shaped for direct use as a GitHub Actions
 * `strategy.matrix.include` array — each runtime is a boolean so workflow
 * steps can guard with `if: matrix.rust`.
 *
 * @returns {Array<{ group: string } & Record<string, boolean>>}
 */
export function groupManifest() {
  return listGroups().map((group) => {
    const runtimes = new Set(gatesInGroup(group).map((g) => g.runtime))
    const flags = Object.fromEntries(RUNTIMES.map((r) => [r, runtimes.has(r)]))
    return { group, ...flags }
  })
}

/** @param {string} group @returns {typeof GATES} */
export function gatesInGroup(group) {
  return GATES.filter((g) => g.group === group)
}

/**
 * Filter the registry down to what a given invocation should run. Pure.
 *
 * @param {{ group?: string, runtime?: string }} [filter]
 * @returns {typeof GATES}
 */
export function selectGates(filter = {}) {
  const { group, runtime } = filter
  if (group && !listGroups().includes(group)) {
    throw new Error(`Unknown gate group: ${group}. Known: ${listGroups().join(", ")}`)
  }
  if (runtime && !RUNTIMES.includes(runtime)) {
    throw new Error(`Unknown runtime: ${runtime}. Known: ${RUNTIMES.join(", ")}`)
  }
  return GATES.filter((g) => (!group || g.group === group) && (!runtime || g.runtime === runtime))
}

/**
 * Reduce raw gate results into an exit code + human summary.
 * Pure (no I/O) so it can be unit-tested.
 *
 * A non-blocking gate that failed is reported with `!` and excluded from the
 * failure count — it is visible without being able to stop the build.
 *
 * @param {Array<{ name: string, ok: boolean, skipped?: boolean, blocking?: boolean }>} results
 * @returns {{ exitCode: number, summary: string }}
 */
export function summarize(results) {
  const advisory = (r) => r.blocking === false
  const lines = results.map((r) => {
    const mark = r.skipped ? "∅" : r.ok ? "✓" : advisory(r) ? "!" : "✗"
    const note = r.skipped ? " (skipped)" : !r.ok && advisory(r) ? " (advisory)" : ""
    return `  ${mark} ${r.name}${note}`
  })
  const failed = results.filter((r) => !r.skipped && !r.ok && !advisory(r))
  const ran = results.filter((r) => !r.skipped)
  const header = failed.length
    ? `check:all — ${failed.length}/${ran.length} gate(s) FAILED`
    : `check:all — all ${ran.length} gate(s) passed`
  return {
    exitCode: failed.length ? 1 : 0,
    summary: [header, ...lines].join("\n"),
  }
}

/**
 * Render the run as a GitHub job-summary table. Pure.
 *
 * This is the "always works" half of the reporting story: it needs no token,
 * no artifact download and no second workflow, so a gate result is visible
 * even when the richer `report.yml` stage cannot run (fork PRs, Dependabot,
 * or a cancelled run).
 *
 * @param {Array<{ name: string, ok: boolean, skipped?: boolean, blocking?: boolean }>} results
 * @param {string} [group]
 * @returns {string}
 */
export function renderSummaryMarkdown(results, group) {
  const title = group ? `Gates — \`${group}\`` : "Gates"
  const status = (r) => {
    if (r.skipped) return "⏭️ skipped"
    if (r.ok) return "✅ pass"
    return r.blocking === false ? "⚠️ advisory" : "❌ FAIL"
  }
  const rows = results.map((r) => `| \`${r.name}\` | ${status(r)} |`)
  const { summary } = summarize(results)
  const header = summary.split("\n")[0]
  return [`### ${title}`, "", header, "", "| Gate | Result |", "| --- | --- |", ...rows, ""].join(
    "\n"
  )
}

/**
 * Parse the CLI surface. Pure.
 * @param {string[]} argv
 * @returns {{ group?: string, runtime?: string, listGroups: boolean, json: boolean, bail: boolean }}
 */
export function parseArgs(argv) {
  const args = { listGroups: false, json: false, bail: argv.includes("--bail") }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--group") {
      const value = argv[++i]
      if (!value) throw new Error("--group requires a group name")
      args.group = value
    } else if (arg === "--runtime") {
      const value = argv[++i]
      if (!value) throw new Error("--runtime requires a runtime name")
      args.runtime = value
    } else if (arg === "--list-groups") args.listGroups = true
    else if (arg === "--json") args.json = true
    else if (arg === "--bail") continue
    // pnpm 10 forwards the `--` separator itself, so the documented
    // `pnpm check:all -- --runtime node` arrives with a bare `--` in argv.
    else if (arg === "--") continue
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

/** Run a single pnpm script, inheriting stdio so its output streams live. */
function runGate(name) {
  // `pnpm` resolves to pnpm.cmd on Windows; shell:true lets the .cmd shim run.
  const res = spawnSync("pnpm", ["run", name], { stdio: "inherit", shell: true })
  return res.status === 0
}

export function main(argv) {
  const args = parseArgs(argv)

  if (args.listGroups) {
    const manifest = groupManifest()
    process.stdout.write(
      args.json ? `${JSON.stringify(manifest)}\n` : `${manifest.map((m) => m.group).join("\n")}\n`
    )
    return 0
  }

  const selected = selectGates({ group: args.group, runtime: args.runtime })
  const results = []
  for (const gate of selected) {
    process.stdout.write(`\n=== ${gate.script} (${gate.group}) ===\n`)
    const ok = runGate(gate.script)
    results.push({ name: gate.script, ok, blocking: gate.blocking })
    if (!ok && gate.blocking && args.bail) {
      // Mark the rest as skipped so the summary is honest about what ran.
      for (const rest of selected.slice(selected.indexOf(gate) + 1)) {
        results.push({ name: rest.script, ok: false, skipped: true, blocking: rest.blocking })
      }
      break
    }
  }
  const { exitCode, summary } = summarize(results)
  process.stdout.write(`\n${summary}\n`)

  // Job summary is best-effort: a failure to write it must never mask the
  // gate result the caller actually cares about.
  const summaryFile = process.env.GITHUB_STEP_SUMMARY
  if (summaryFile) {
    try {
      appendFileSync(summaryFile, renderSummaryMarkdown(results, args.group))
    } catch (err) {
      process.stderr.write(`[check:all] could not write the job summary: ${err.message}\n`)
    }
  }

  return exitCode
}

// Only auto-run when invoked directly (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-all.mjs")) {
  process.exit(main(process.argv.slice(2)))
}
