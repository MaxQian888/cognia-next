#!/usr/bin/env node
/**
 * Run full Jest coverage in isolated shards, then merge and gate the result.
 *
 * A monolithic coverage process retains the union of thousands of instrumented
 * modules until exit and can exhaust the V8 heap even when workers recycle.
 * Separate shard processes release that memory between bounded waves while two
 * concurrent shards keep the machine busy. Thresholds are checked only after
 * merging because no individual shard owns the complete coverage map.
 */

import { spawn } from "node:child_process"
import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const POSITIVE_INTEGER = /^[1-9]\d*$/

function positiveInteger(flag, value) {
  if (!POSITIVE_INTEGER.test(value ?? "")) {
    throw new Error(`${flag} requires a positive integer`)
  }
  return Number(value)
}

export function parseArgs(argv) {
  const args = { shards: 8, jobs: 2, maxOldSpaceSize: 8192, out: "coverage", only: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--") continue
    if (arg === "--shards") args.shards = positiveInteger(arg, argv[++i])
    else if (arg === "--jobs") args.jobs = positiveInteger(arg, argv[++i])
    else if (arg === "--max-old-space-size") {
      args.maxOldSpaceSize = positiveInteger(arg, argv[++i])
    } else if (arg === "--out") {
      const value = argv[++i]
      if (!value) throw new Error("--out requires a directory")
      args.out = value
    } else if (arg === "--only") {
      const value = argv[++i]
      if (!value) throw new Error("--only requires a comma-separated shard list")
      const shards = value.split(",").map((item) => positiveInteger(arg, item))
      args.only = [...new Set(shards)]
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

export function effectiveJobCount(shards, jobs) {
  return Math.min(shards, jobs)
}

export function buildCoveragePlan({ shards, out, only }) {
  const shardRoot = path.join(out, "shards")
  const shardPlans = Array.from({ length: shards }, (_, index) => {
    const shard = index + 1
    const coverageDirectory = path.join(shardRoot, `shard-${shard}`)
    return {
      label: `shard ${shard}/${shards}`,
      command: "pnpm",
      args: [
        "exec",
        "jest",
        "--coverage",
        "--silent",
        "--maxWorkers=4",
        "--testTimeout=120000",
        `--shard=${shard}/${shards}`,
        `--coverageDirectory=${coverageDirectory}`,
        "--coverageReporters=json",
        "--coverageThreshold={}",
      ],
      coverageDirectory,
      junitOutputName: `junit-shard-${shard}.xml`,
    }
  })
  if (only?.some((shard) => shard > shards)) {
    throw new Error(`--only shard numbers must be within 1-${shards}`)
  }
  return {
    shardRoot,
    shards: only ? shardPlans.filter((_, index) => only.includes(index + 1)) : shardPlans,
    merge: {
      label: "coverage merge and threshold gate",
      command: process.execPath,
      args: [
        "scripts/test/merge-coverage.mjs",
        "--check",
        "--out",
        out,
        ...shardPlans.map((shard) => shard.coverageDirectory),
      ],
    },
  }
}

function runProcess(spec, { maxOldSpaceSize }) {
  const nodeOptions = [process.env.NODE_OPTIONS, `--max-old-space-size=${maxOldSpaceSize}`]
    .filter(Boolean)
    .join(" ")
  console.log(`[coverage] starting ${spec.label}`)
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      stdio: "inherit",
      env: {
        ...process.env,
        JEST_COVERAGE: "1",
        JEST_JUNIT_OUTPUT_NAME: spec.junitOutputName ?? "junit.xml",
        NODE_OPTIONS: nodeOptions,
      },
    })
    child.once("error", (error) => {
      console.error(`[coverage] ${spec.label} failed to start: ${error.message}`)
      resolve(1)
    })
    child.once("exit", (code, signal) => {
      if (signal) console.error(`[coverage] ${spec.label} terminated by ${signal}`)
      resolve(code ?? 1)
    })
  })
}

export async function executeShardPlan(shards, { jobs, run }) {
  let nextIndex = 0
  let failure
  const worker = async () => {
    while (failure === undefined && nextIndex < shards.length) {
      const spec = shards[nextIndex++]
      const status = await run(spec)
      if (status !== 0 && failure === undefined) failure = spec
    }
  }
  await Promise.all(Array.from({ length: effectiveJobCount(shards.length, jobs) }, worker))
  if (failure) throw new Error(`${failure.label} failed`)
}

function prepareShardRoot(shardRoot, { preserve }) {
  const resolved = path.resolve(shardRoot)
  const relative = path.relative(process.cwd(), resolved)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to clear shard directory outside the repository: ${resolved}`)
  }
  if (!preserve) rmSync(resolved, { recursive: true, force: true })
  mkdirSync(resolved, { recursive: true })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const plan = buildCoveragePlan(args)
  prepareShardRoot(plan.shardRoot, { preserve: args.only !== undefined })
  const run = (spec) => runProcess(spec, args)
  await executeShardPlan(plan.shards, { jobs: args.jobs, run })
  const mergeStatus = await run(plan.merge)
  if (mergeStatus !== 0) throw new Error(`${plan.merge.label} failed`)
  console.log(
    `[coverage] ${plan.shards.length} selected shard(s) passed; all ${args.shards} maps merged with ${effectiveJobCount(plan.shards.length, args.jobs)} concurrent job(s)`
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[coverage] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
