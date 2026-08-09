#!/usr/bin/env node

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const DEFAULT_LATENCY_REGRESSION_RATIO = 0.05
export const DEFAULT_CHUNK_REGRESSION_RATIO = 0.02

export function percentile(samples, percentileValue) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("performance samples must be a non-empty array")
  }
  const sorted = samples.map(Number).sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1)
  return sorted[Math.max(0, index)]
}

export function summarizeLifecycleSamples(samples) {
  return Object.fromEntries(
    Object.entries(samples).map(([phase, values]) => [
      phase,
      { p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95) },
    ])
  )
}

export function checkPerformanceBudget(baseline, candidate) {
  const errors = []
  const latencyRatio = baseline.budgets?.latencyRegressionRatio ?? DEFAULT_LATENCY_REGRESSION_RATIO
  const chunkRatio = baseline.budgets?.chunkRegressionRatio ?? DEFAULT_CHUNK_REGRESSION_RATIO
  for (const [phase, expected] of Object.entries(baseline.lifecycle)) {
    const actual = candidate.lifecycle?.[phase]
    if (!actual) {
      errors.push(`missing lifecycle phase ${phase}`)
      continue
    }
    for (const metric of ["p50Ms", "p95Ms"]) {
      const limit = expected[metric] * (1 + latencyRatio)
      if (actual[metric] > limit) {
        errors.push(`${phase}.${metric} ${actual[metric]}ms exceeds ${limit.toFixed(3)}ms`)
      }
    }
  }
  for (const metric of ["rawBytes", "gzipBytes"]) {
    const limit = baseline.chunk[metric] * (1 + chunkRatio)
    if (candidate.chunk?.[metric] > limit) {
      errors.push(`chunk.${metric} ${candidate.chunk[metric]} exceeds ${Math.floor(limit)}`)
    }
  }
  return errors
}

export function resolvePerformanceFiles(args, cwd, defaultBaselinePath) {
  if (args.length === 1) {
    return {
      baselinePath: defaultBaselinePath,
      candidatePath: resolve(cwd, args[0]),
    }
  }
  if (args.length === 2) {
    return {
      baselinePath: resolve(cwd, args[0]),
      candidatePath: resolve(cwd, args[1]),
    }
  }
  throw new Error("usage: check-performance-budget.mjs [baseline.json] <candidate.json>")
}

function main() {
  const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)))
  const { baselinePath, candidatePath } = resolvePerformanceFiles(
    process.argv.slice(2),
    process.cwd(),
    resolve(scriptDir, "../contract/performance-baseline.json")
  )
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"))
  const candidate = JSON.parse(readFileSync(candidatePath, "utf8"))
  const errors = checkPerformanceBudget(baseline, candidate)
  if (errors.length > 0) {
    throw new Error(
      `Plugin performance budget failed:\n${errors.map((error) => `- ${error}`).join("\n")}`
    )
  }
  process.stdout.write("Plugin performance budget passed.\n")
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
