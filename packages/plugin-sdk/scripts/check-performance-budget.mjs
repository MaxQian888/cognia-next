#!/usr/bin/env node

import { readFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

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

/** Measure the unique ESM closure shared by the public SDK's hot entrypoints. */
export function measureEsmChunkClosure(
  distDir,
  entries = ["index.js", "context.js", "browser.js"]
) {
  const pending = [...entries]
  const seen = new Set()
  const chunks = []
  while (pending.length > 0) {
    const file = basename(pending.pop())
    if (seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(resolve(distDir, file))
    chunks.push(source)
    const text = source.toString("utf8")
    for (const match of text.matchAll(/(?:from\s*|import\s*\()\s*["']\.\/([^"']+\.js)["']/g)) {
      if (!seen.has(match[1])) pending.push(match[1])
    }
  }
  const combined = Buffer.concat(chunks.flatMap((chunk) => [chunk, Buffer.from("\n")]))
  return {
    files: [...seen].sort(),
    rawBytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    gzipBytes: gzipSync(combined).byteLength,
  }
}

function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const args = process.argv.slice(2)
  const defaultBaselinePath = resolve(scriptDir, "../contract/performance-baseline.json")
  if (args.length === 0) {
    const baseline = JSON.parse(readFileSync(defaultBaselinePath, "utf8"))
    const chunk = measureEsmChunkClosure(resolve(scriptDir, "../dist"))
    const errors = checkPerformanceBudget(baseline, { lifecycle: {}, chunk })
    if (errors.length > 0) {
      throw new Error(
        `Plugin performance budget failed:\n${errors.map((error) => `- ${error}`).join("\n")}`
      )
    }
    process.stdout.write(
      `Plugin performance budget passed (${chunk.rawBytes} raw / ${chunk.gzipBytes} gzip bytes across ${chunk.files.length} chunks).\n`
    )
    return
  }
  const { baselinePath, candidatePath } = resolvePerformanceFiles(
    args,
    process.cwd(),
    defaultBaselinePath
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
