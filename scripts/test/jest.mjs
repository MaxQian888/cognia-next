#!/usr/bin/env node
/**
 * The `pnpm test*` entry point: Jest, minus one argument.
 *
 * pnpm forwards `pnpm test -- <args>` with the `--` still in front, and Jest
 * reads every argument after a bare `--` as a test path pattern. So the
 * documented `pnpm test -- path/to/file.test.ts` only worked for paths: any
 * flag after it was silently turned into a pattern too. `pnpm test -- a.test.ts
 * -t name --maxWorkers=1` filtered by no name and capped no workers. `-t` alone
 * matches every path containing "-t", which is over a thousand suites, and they
 * ran on the full default worker pool (75% of cores, about 2 GB each). That
 * was enough to stall a 48 GB machine. `pnpm test -- --listTests` searched for
 * a file named `--listTests`.
 *
 * Dropping that one leading separator makes the forwarded arguments mean what
 * they say. Only a LEADING `--` is dropped: one later in the list was written
 * by the caller on purpose.
 */

import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

/** The arguments to hand Jest, given what pnpm passed this script. */
export function forwardedJestArgs(argv) {
  if (argv[0]?.startsWith("--lane=")) {
    const lane = argv[0].slice("--lane=".length)
    const lanes = {
      unit: ["node", "jsdom"],
      heavy: ["heavy", "build", "pty"],
      build: ["build"],
      pty: ["pty"],
    }
    const projects = Object.hasOwn(lanes, lane) ? lanes[lane] : undefined
    if (!projects) throw new Error(`Unknown Jest lane: ${lane}`)
    const rest = argv.slice(1)
    const forwarded = rest[0] === "--" ? rest.slice(1) : rest
    const explicitWorkers = forwarded.some((arg) =>
      /^(?:--runInBand(?:=|$)|-i$|--maxWorkers(?:=|$)|-w(?:=|\d|$))/.test(arg)
    )
    return [
      "--selectProjects",
      ...projects,
      "--config",
      fileURLToPath(new URL("../../jest.config.ts", import.meta.url)),
      ...(lane === "unit" || explicitWorkers ? [] : ["--maxWorkers=1"]),
      ...forwarded,
    ]
  }
  return argv[0] === "--" ? argv.slice(1) : argv
}

function main() {
  const jestBin = createRequire(import.meta.url).resolve("jest/bin/jest")
  const child = spawn(
    process.execPath,
    [...process.execArgv, jestBin, ...forwardedJestArgs(process.argv.slice(2))],
    { stdio: "inherit" }
  )
  // Ctrl-C reaches the whole foreground group already; forwarding covers a
  // parent that signals only this process, so no Jest run outlives it.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal))
  }
  child.on("exit", (code, signal) => {
    if (signal) {
      process.removeAllListeners(signal)
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 1)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
