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
 *   { script, group, runtime = "node", blocking = true, resource? }
 *
 *   script   — a package.json script name, invoked as `pnpm run <script>`.
 *   group    — the parallel CI job this gate belongs to. Groups exist so one
 *              CI run surfaces EVERY failure instead of stopping at the first.
 *   runtime  — toolchain the gate needs: "node" | "python" | "rust". CI
 *              provisions a group's union of runtimes; local runs can filter
 *              with `--runtime node` to skip the heavy ones.
 *   blocking — false marks an advisory gate: it runs and reports, but never
 *              fails the build.
 *   resource — optional local mutex for gates that write the same generated
 *              outputs (for example package builds or Cargo's target dir).
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
 *   pnpm check:all                       # every gate, up to 4 groups in parallel
 *   pnpm check:all -- --runtime node     # skip the python/rust gates
 *   pnpm check:all -- --group audit      # one CI group
 *   pnpm check:all -- --jobs 2           # override local concurrency
 *   pnpm check:all -- --bail             # stop at the first failure
 *   node scripts/gates/check-all.mjs --list-groups --json
 */

import { spawn } from "node:child_process"
import { appendFileSync } from "node:fs"
import { availableParallelism } from "node:os"

/** Toolchains a gate can require. CI provisions these per group. */
export const RUNTIMES = ["node", "python", "rust"]

/** Keep enough parallelism for speed without launching every heavy gate at once. */
export function defaultJobCount(parallelism = availableParallelism()) {
  return Math.min(4, Math.max(1, parallelism))
}

/** Resolve requested concurrency against the work that can actually overlap. */
export function effectiveJobCount(gates, requestedJobs, bail) {
  if (bail) return 1
  const groupCount = new Set(gates.map((gate) => gate.group)).size
  return Math.max(1, Math.min(requestedJobs, groupCount))
}

/**
 * The registry. Order is meaningful: it is the order `check:all` runs them
 * in, cheapest and most-likely-to-fail first.
 *
 * @type {Array<{ script: string, group: string, runtime?: string, blocking?: boolean, resource?: string }>}
 */
const REGISTRY = [
  // Fast feedback first — these catch the majority of everyday breakage.
  { script: "lint", group: "lint" },
  { script: "format:check", group: "format" },

  { script: "typecheck", group: "types", resource: "package-build" },
  { script: "knip", group: "types", resource: "package-build" },
  // The root `typecheck` excludes `web` (tsconfig `exclude`), so the marketing
  // workspace needs its own run. This is not optional bookkeeping: ADR-0092 §5
  // chose a typed `SiteCopy` over an i18n bundle precisely because "a missing
  // or extra key in either locale fails typecheck" — and until this entry
  // existed, nothing on a PR ever ran that check.
  { script: "web:typecheck", group: "types" },

  { script: "lint:i18n", group: "i18n" },
  { script: "i18n:build:check", group: "i18n" },

  // Generated / derived artifacts must be in sync with their sources.
  { script: "build:packages", group: "artifacts", resource: "package-build" },
  { script: "skills:check", group: "artifacts" },
  { script: "plugin-node:check", group: "artifacts" },
  // The mobile settings contract: one classification table generates the Rust
  // write-allowlist and the OpenAPI patch enum. Before it existed those two
  // were hand-maintained and had drifted (dead keys, fields writable up but
  // never mirrored down, transport config classified backwards).
  { script: "settings-sync:check", group: "artifacts" },
  // The bundled model price catalog is derived from LiteLLM's cost map by
  // `pnpm pricing:sync`. This check is OFFLINE on purpose — it validates the
  // committed artifact's shape, ordering, formatting and size ceiling rather
  // than re-fetching, so an unreachable third-party host cannot fail the build.
  // The size ceiling matters because the same static export ships to phones.
  { script: "pricing:catalog:check", group: "artifacts" },
  // The bundled Pi extension is pinned by SHA-256 and refused when the digest
  // does not match, so a forgotten re-pin ships an extension that blocks every
  // Pi session on the user's machine. Its own docstring said this had to fail
  // in CI; until now nothing ran it (ADR-0119).
  { script: "pi:extension:pin:check", group: "artifacts" },
  { script: "companion-api:check", group: "artifacts" },
  { script: "plugin-convert:check", group: "artifacts" },
  { script: "plugin:contract:check", group: "artifacts" },
  { script: "ide:check", group: "artifacts" },
  // The declarations `cognia plugin new` vendors must match the packages they
  // came from; a stale bundle ships authors a type surface the host no longer
  // has. Shares `package-build` because it rebuilds the same packages.
  { script: "author-types:check", group: "artifacts", resource: "package-build" },

  // Repo-specific structural audits (see the ADRs each one cites).
  { script: "audit:slots", group: "audit" },
  { script: "audit:plugin-surfaces", group: "audit" },
  { script: "audit:ai-elements", group: "audit" },
  // Local persistence governance rejects schema/catalog, TypeScript/Rust sync,
  // version-order, and generated-documentation drift.
  { script: "audit:data-governance", group: "audit" },
  // ADR-0090: unified execution paths must stay vendor-neutral (no
  // GLM/Kimi/provider-name branches in dispatch logic).
  { script: "check:provider-name-branches", group: "audit" },
  // ADR-0090 Phase 5: certification staleness inputs must match real pins.
  { script: "check:runtime-versions", group: "audit" },
  // Stable ACP v1 methods, updates, versions, and SDK pins must stay aligned
  // with the checked-in schema contract.
  { script: "check:acp-v1-contract", group: "audit" },
  // The Agent SDK's public surface must stay fully triaged. `anthropic.mjs`
  // builds `query()` options from an explicit allowlist, so a new SDK option
  // is otherwise invisible — no break, no warning, the capability just does
  // not exist. Same for a new Query method, SDKMessage variant or HookEvent.
  { script: "check:sdk-surface", group: "audit" },
  // The live session-control surface is hand-declared in four files across
  // three languages. This binds all four to protocol/agent-control-methods.json
  // and refuses to let a still-`planned` control reach a live Query object.
  { script: "audit:adapter-capabilities", group: "audit" },
  { script: "audit:agent-control-methods", group: "audit" },
  { script: "audit:trusted-publishers", group: "audit" },
  { script: "audit:silent-flags", group: "audit" },
  { script: "audit:pii-boundaries", group: "audit" },
  { script: "audit:command-parity", group: "audit" },
  { script: "audit:companion-command-manifest", group: "audit" },
  // The manifest gate above compares NAME SETS only — its whole schema check is
  // `if (!command.inputSchema)`. So a dispatch arm could drop half its
  // command's arguments and stay green (it did: `custom_headers`,
  // `command_id`, `helper_path`). This one parses the `#[tauri::command]`
  // signatures themselves — the artifact no generator in this repo reads — and
  // holds the RPC arms and the enforced contract schemas to them.
  { script: "audit:rpc-semantic-parity", group: "audit" },
  // Every gate above asks "does the same command exist, with the same
  // payload". None asks "can this host actually reach it" — a command can be
  // registered, manifested and semantically faithful and still 503 on one
  // host. This one inventories the headless↔desktop capability gap: seam
  // bypasses, host-keyed UI, one-sided dispatch arms, and capability tables
  // that disagree with the manifest. Report-only until the first paydown
  // batch lands (ADR-0059).
  { script: "audit:host-parity", group: "audit" },
  // Host parity's blind spot: it inventories the RPC surface and the UI, but a
  // brain that reaches every arm still runs nothing if the effect is wired
  // only into a React provider. ADR-0059's closing rule ("new runtime
  // side-effects must register through the headless bootstrap registry") was
  // enforced by an advisory subagent until this gate; two subsystems shipped
  // desktop-only in the interim.
  { script: "audit:headless-registry", group: "audit" },
  { script: "audit:e2e-governance", group: "audit" },
  { script: "audit:docs-links", group: "audit" },
  { script: "audit:adr-catalog", group: "audit" },
  { script: "audit:colocated-tests", group: "audit" },
  { script: "audit:loading-states", group: "audit" },
  { script: "audit:unreachable-components", group: "audit" },
  { script: "audit:root-loading", group: "audit" },
  { script: "lint:static-export", group: "audit" },
  { script: "lint:plugin-sdk-wit", group: "audit" },
  { script: "lint:frozen-wasm-api", group: "audit" },
  { script: "lint:claude-md", group: "audit" },
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
  // `node --test` over mobile/scripts/ — the iOS project/plist configurators
  // `mobile:sync:ios` runs. Jest ignores `scripts/**/*.test.mjs`, so these had
  // no runner at all and their assertions never executed.
  { script: "scripts:test:mobile", group: "gate-tests" },
  // `node --test` over web/scripts/ — the evidence pipeline and the two capture
  // scripts. Introduced by ADR-0092 but never registered, so it ran nowhere.
  { script: "web:test:scripts", group: "gate-tests" },
  { script: "test:coverage:runner:test", group: "gate-tests" },
  { script: "sidecar:codeserver-agent:test", group: "gate-tests" },

  // The plugin SDK's cross-language contract surface.
  { script: "sdk:ts:build", group: "plugin-sdk", resource: "package-build" },
  { script: "sdk:ts:pack:test", group: "plugin-sdk" },
  { script: "sdk:scaffold:test", group: "plugin-sdk" },
  { script: "sdk:python:test", group: "plugin-sdk", runtime: "python" },
  { script: "sdk:rust:test", group: "plugin-sdk", runtime: "rust", resource: "cargo" },

  // Rust quality. The workspace had never been linted or format-checked —
  // only the two standalone services under services/ ran clippy at all.
  { script: "rust:fmt:check", group: "rust", runtime: "rust" },
  { script: "rust:clippy", group: "rust", runtime: "rust", resource: "cargo" },

  // Supply-chain checks are blocking. Missing scanners must fail locally too;
  // otherwise check:all can report success without performing the audit.
  { script: "audit:deps", group: "supply-chain" },
  {
    script: "rust:deny",
    group: "supply-chain",
    runtime: "rust",
    resource: "cargo",
  },
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
 * Run each gate group as one ordered lane while allowing independent groups
 * to make progress concurrently. Results are returned in registry order so
 * the summary remains deterministic regardless of completion order.
 *
 * @param {typeof GATES} gates
 * @param {{ jobs: number, bail?: boolean, executeGate: (gate: (typeof GATES)[number]) => Promise<boolean> }} options
 */
export async function runGatePlan(gates, { jobs, bail = false, executeGate }) {
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error("jobs must be a positive integer")

  if (bail) {
    const results = []
    for (let i = 0; i < gates.length; i += 1) {
      const gate = gates[i]
      const ok = await executeGate(gate)
      results.push({ name: gate.script, ok, blocking: gate.blocking })
      if (!ok && gate.blocking) {
        for (const rest of gates.slice(i + 1)) {
          results.push({ name: rest.script, ok: false, skipped: true, blocking: rest.blocking })
        }
        break
      }
    }
    return results
  }

  const lanes = []
  const lanesByGroup = new Map()
  for (const gate of gates) {
    let lane = lanesByGroup.get(gate.group)
    if (!lane) {
      lane = []
      lanesByGroup.set(gate.group, lane)
      lanes.push(lane)
    }
    lane.push(gate)
  }

  const laneStates = lanes.map((lane) => ({ gates: lane, next: 0, running: false }))
  const results = new Map()
  const activeResources = new Set()
  const activeTasks = new Set()

  while (results.size < gates.length) {
    for (const lane of laneStates) {
      if (activeTasks.size >= jobs) break
      if (lane.running || lane.next >= lane.gates.length) continue

      const gate = lane.gates[lane.next]
      if (gate.resource && activeResources.has(gate.resource)) continue

      lane.running = true
      if (gate.resource) activeResources.add(gate.resource)

      let task
      task = (async () => {
        try {
          const ok = await executeGate(gate)
          results.set(gate.script, { name: gate.script, ok, blocking: gate.blocking })
          lane.next += 1
        } finally {
          lane.running = false
          if (gate.resource) activeResources.delete(gate.resource)
          activeTasks.delete(task)
        }
      })()
      activeTasks.add(task)
    }

    if (activeTasks.size === 0) {
      throw new Error("gate plan deadlocked: no runnable gate remains")
    }
    await Promise.race(activeTasks)
  }

  return gates.map((gate) => results.get(gate.script))
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
 * @returns {{ group?: string, runtime?: string, jobs?: number, listGroups: boolean, json: boolean, bail: boolean }}
 */
export function parseArgs(argv) {
  const args = {
    listGroups: false,
    json: false,
    bail: argv.includes("--bail"),
    jobs: undefined,
  }
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
    } else if (arg === "--jobs") {
      const value = argv[++i]
      const jobs = Number(value)
      if (!value || !Number.isInteger(jobs) || jobs < 1) {
        throw new Error("--jobs requires a positive integer")
      }
      args.jobs = jobs
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

/** Run one pnpm script and retain its output as one readable log block. */
export function runGate(name) {
  return new Promise((resolve) => {
    const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
    const child = spawn(command, ["run", name], { stdio: ["ignore", "pipe", "pipe"] })
    const chunks = []
    let settled = false

    child.stdout.on("data", (chunk) => chunks.push(chunk))
    child.stderr.on("data", (chunk) => chunks.push(chunk))
    child.on("error", (error) => {
      if (settled) return
      settled = true
      chunks.push(Buffer.from(`[check:all] could not start ${name}: ${error.message}\n`))
      resolve({ ok: false, output: Buffer.concat(chunks).toString("utf8") })
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      resolve({ ok: code === 0, output: Buffer.concat(chunks).toString("utf8") })
    })
  })
}

export async function main(argv) {
  const args = parseArgs(argv)

  if (args.listGroups) {
    const manifest = groupManifest()
    process.stdout.write(
      args.json ? `${JSON.stringify(manifest)}\n` : `${manifest.map((m) => m.group).join("\n")}\n`
    )
    return 0
  }

  const selected = selectGates({ group: args.group, runtime: args.runtime })
  const jobs = effectiveJobCount(selected, args.jobs ?? defaultJobCount(), args.bail)
  process.stdout.write(
    `check:all — ${selected.length} gate(s), ${jobs} concurrent group lane(s)` +
      `${args.bail ? " (--bail: sequential)" : ""}\n`
  )

  const results = await runGatePlan(selected, {
    jobs,
    bail: args.bail,
    executeGate: async (gate) => {
      const startedAt = Date.now()
      process.stdout.write(`\n=== ${gate.script} (${gate.group}) [started] ===\n`)
      const { ok, output } = await runGate(gate.script)
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
      process.stdout.write(
        `\n=== ${gate.script} (${gate.group}) [${ok ? "passed" : "FAILED"} in ${seconds}s] ===\n`
      )
      if (output) process.stdout.write(output.endsWith("\n") ? output : `${output}\n`)
      return ok
    },
  })
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
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode
    })
    .catch((error) => {
      process.stderr.write(`[check:all] ${error.stack ?? error.message}\n`)
      process.exitCode = 1
    })
}
