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

import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Command, CommanderError } from "commander"
import { execa } from "execa"
import { z } from "zod"

const positiveInteger = (flag) =>
  z.coerce
    .number({ error: `${flag} requires a positive integer` })
    .int({ error: `${flag} requires a positive integer` })
    .positive({ error: `${flag} requires a positive integer` })

const cliSchema = z.object({
  jobs: positiveInteger("--jobs").default(2),
  maxOldSpaceSize: positiveInteger("--max-old-space-size").default(8192),
  only: z
    .string()
    .trim()
    .min(1, "--only requires a comma-separated shard list")
    .transform((value, context) => {
      const shards = value.split(",").map((item) => {
        const result = positiveInteger("--only").safeParse(item)
        if (!result.success) {
          context.addIssue({ code: "custom", message: "--only requires positive integers" })
          return z.NEVER
        }
        return result.data
      })
      return [...new Set(shards)]
    })
    .optional(),
  out: z.string().trim().min(1, "--out requires a directory").default("coverage"),
  shards: positiveInteger("--shards").default(8),
  workers: positiveInteger("--workers").default(4),
})

function createProgram() {
  return new Command()
    .name("pnpm test:coverage")
    .description("Run Jest coverage in bounded shards, then merge and gate the result.")
    .configureOutput({ writeErr: () => {} })
    .showHelpAfterError()
    .exitOverride()
    .option("--shards <count>", "Total Jest shard count.", "8")
    .option("--jobs <count>", "Maximum concurrent shard processes.", "2")
    .option("--workers <count>", "Jest workers per shard.", "4")
    .option("--max-old-space-size <megabytes>", "Node.js heap limit per shard.", "8192")
    .option("--out <directory>", "Coverage output directory.", "coverage")
    .option("--only <shards>", "Comma-separated shard numbers to rerun.")
}

export function parseArgs(argv) {
  const program = createProgram()
  try {
    program.parse(
      argv.filter((argument) => argument !== "--"),
      { from: "user" }
    )
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") return null
    throw error
  }
  const options = cliSchema.parse(program.opts())
  return { ...options, only: options.only }
}

export function effectiveJobCount(shards, jobs) {
  return Math.min(shards, jobs)
}

export function buildCoveragePlan({ shards, workers = 4, out, only }) {
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
        `--maxWorkers=${workers}`,
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

async function runProcess(spec, { maxOldSpaceSize }) {
  const nodeOptions = [process.env.NODE_OPTIONS, `--max-old-space-size=${maxOldSpaceSize}`]
    .filter(Boolean)
    .join(" ")
  console.log(`[coverage] starting ${spec.label}`)
  try {
    const result = await execa(spec.command, spec.args, {
      stdio: "inherit",
      env: {
        ...process.env,
        JEST_COVERAGE: "1",
        JEST_JUNIT_OUTPUT_NAME: spec.junitOutputName ?? "junit.xml",
        NODE_OPTIONS: nodeOptions,
      },
      reject: false,
    })
    if (result.signal) console.error(`[coverage] ${spec.label} terminated by ${result.signal}`)
    return result.exitCode ?? 1
  } catch (error) {
    console.error(`[coverage] ${spec.label} failed to start: ${error.message}`)
    return 1
  }
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
  if (!args) return
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
