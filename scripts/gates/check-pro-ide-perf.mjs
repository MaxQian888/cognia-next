#!/usr/bin/env node
/**
 * The Pro IDE performance gates (compatibility.mdx, "Performance gates").
 *
 * The real-binary E2E (`lib/plugin/ide/real-code-server.e2e.test.ts`) measures
 * one run against a real code-server and writes `target/pro-ide-perf.json`.
 * This compares that run with the committed baseline for the same platform:
 *
 *   - cold readiness: a regression of at most 20% and at most 2 s;
 *   - idle RSS of the host's process tree: at most 20% and at most 150 MiB;
 *   - empty broker RPC p95: at most 30 ms, absolute;
 *   - relay overhead p95 over loopback: at most 75 ms, absolute;
 *   - lifecycle events lost from a burst within the event bus's declared
 *     capacity: none.
 *
 * "At most 20% and 2 s" means both: a slow baseline does not buy a larger
 * absolute regression, and a fast one does not fail on noise below 20%.
 *
 * Baselines are per platform (`<os>-<arch>`): a laptop and a CI runner do not
 * start code-server in the same time. A platform with no baseline still gets
 * the absolute gates; its regression gates fail unless
 * `--allow-missing-baseline` is passed, which says so in the output. Record
 * one with `--write-baseline` from a run on that platform.
 *
 * Usage:
 *   pnpm audit:pro-ide-perf [--result <file>] [--allow-missing-baseline]
 *   pnpm audit:pro-ide-perf --write-baseline
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
export const DEFAULT_RESULT = join(REPO_ROOT, "target", "pro-ide-perf.json")
export const BASELINE_FILE = join(REPO_ROOT, "scripts", "gates", "pro-ide-perf-baseline.json")

/** Regression budgets: relative to the baseline, and capped in absolute units. */
export const REGRESSION_GATES = [
  { metric: "coldReadinessMs", label: "cold readiness", ratio: 0.2, max: 2000, unit: "ms" },
  { metric: "idleRssMb", label: "idle RSS", ratio: 0.2, max: 150, unit: "MiB" },
]

/** Absolute ceilings, independent of any baseline. */
export const ABSOLUTE_GATES = [
  { metric: "emptyRpcP95Ms", label: "empty broker RPC p95", max: 30, unit: "ms" },
  { metric: "relayOverheadP95Ms", label: "relay overhead p95", max: 75, unit: "ms" },
  { metric: "eventLoss", label: "lifecycle events lost", max: 0, unit: "events" },
]

const METRICS = [...REGRESSION_GATES, ...ABSOLUTE_GATES].map((gate) => gate.metric)

/** Every metric present as a finite, non-negative number, or why not. */
export function validateResult(result) {
  if (!result || typeof result !== "object") return ["result is not an object"]
  const problems = []
  if (typeof result.platform !== "string" || result.platform.length === 0) {
    problems.push("result has no platform")
  }
  for (const metric of METRICS) {
    const value = result[metric]
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      problems.push(`${metric} is missing or not a non-negative number`)
    }
  }
  return problems
}

/**
 * Compare one run with its platform's baseline.
 *
 * Returns `{ failures, lines }`: `lines` is the report, one per gate.
 */
export function evaluate(result, baselines, { allowMissingBaseline = false } = {}) {
  const failures = []
  const lines = []
  const baseline = baselines?.[result.platform]
  for (const gate of ABSOLUTE_GATES) {
    const value = result[gate.metric]
    const ok = value <= gate.max
    lines.push(`${ok ? "ok  " : "FAIL"} ${gate.label}: ${value} ${gate.unit} (max ${gate.max})`)
    if (!ok) failures.push(`${gate.label} ${value} ${gate.unit} exceeds ${gate.max} ${gate.unit}`)
  }
  for (const gate of REGRESSION_GATES) {
    const value = result[gate.metric]
    const base = baseline?.[gate.metric]
    if (typeof base !== "number") {
      const note = `no ${result.platform} baseline for ${gate.label}`
      lines.push(
        `${allowMissingBaseline ? "skip" : "FAIL"} ${gate.label}: ${value} ${gate.unit} (${note})`
      )
      if (!allowMissingBaseline) failures.push(`${note}; record one with --write-baseline`)
      continue
    }
    const budget = Math.min(base * gate.ratio, gate.max)
    const regression = value - base
    const ok = regression <= budget
    lines.push(
      `${ok ? "ok  " : "FAIL"} ${gate.label}: ${value} ${gate.unit} vs baseline ${base} (budget +${Math.round(budget)})`
    )
    if (!ok) {
      failures.push(
        `${gate.label} regressed by ${Math.round(regression)} ${gate.unit} (budget ${Math.round(budget)} ${gate.unit}: ${gate.ratio * 100}% of ${base}, at most ${gate.max})`
      )
    }
  }
  return { failures, lines }
}

/** The baseline file with `result` recorded for its platform. */
export function withBaseline(baselines, result) {
  return {
    ...baselines,
    [result.platform]: {
      codeServer: result.codeServer,
      ...Object.fromEntries(METRICS.map((metric) => [metric, result[metric]])),
    },
  }
}

function argument(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

export function main(args = process.argv.slice(2), log = console.log) {
  const resultFile = argument(args, "--result") ?? DEFAULT_RESULT
  if (!existsSync(resultFile)) {
    log(
      `pro-ide perf: ${resultFile} not found. Run the real-binary E2E first (pnpm test:pro-ide:e2e).`
    )
    return 1
  }
  const result = JSON.parse(readFileSync(resultFile, "utf8"))
  const problems = validateResult(result)
  if (problems.length > 0) {
    log(`pro-ide perf: ${resultFile} is not a perf result:\n  ${problems.join("\n  ")}`)
    return 1
  }
  const baselines = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, "utf8")) : {}
  if (args.includes("--write-baseline")) {
    writeFileSync(BASELINE_FILE, `${JSON.stringify(withBaseline(baselines, result), null, 2)}\n`)
    log(`pro-ide perf: recorded the ${result.platform} baseline in ${BASELINE_FILE}`)
    return 0
  }
  const { failures, lines } = evaluate(result, baselines, {
    allowMissingBaseline: args.includes("--allow-missing-baseline"),
  })
  log(`pro-ide perf (${result.platform}, code-server ${result.codeServer ?? "?"}):`)
  for (const line of lines) log(`  ${line}`)
  if (failures.length > 0) {
    log(`\n${failures.length} gate(s) failed:\n  ${failures.join("\n  ")}`)
    return 1
  }
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main()
}
