#!/usr/bin/env node
/** Bound script-test file workers independently of Jest and gate-group jobs. */
import { spawn } from "node:child_process"
import { availableParallelism } from "node:os"
import { pathToFileURL } from "node:url"

export function forwardedNodeTestArgs(
  argv,
  env = process.env,
  parallelism = availableParallelism()
) {
  const args = argv[0] === "--" ? argv.slice(1) : argv
  const separator = args.indexOf("--")
  const options = separator === -1 ? args : args.slice(0, separator)
  // Let Node validate explicit CLI values, including missing/invalid values.
  if (options.some((arg) => /^--test-concurrency(?:=|$)/.test(arg))) return ["--test", ...args]

  const requested = env.NODE_TEST_CONCURRENCY
  if (
    requested !== undefined &&
    (!/^[1-9]\d*$/.test(requested) || !Number.isSafeInteger(Number(requested)))
  ) {
    throw new Error("NODE_TEST_CONCURRENCY must be a positive safe integer")
  }
  const concurrency = requested ?? Math.min(2, Math.max(1, parallelism - 1))
  return ["--test", `--test-concurrency=${concurrency}`, ...args]
}

function main() {
  const child = spawn(
    process.execPath,
    [...process.execArgv, ...forwardedNodeTestArgs(process.argv.slice(2))],
    {
      stdio: "inherit",
    }
  )
  const handlers = new Map()
  let receivedSignal
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      receivedSignal ??= signal
      child.kill(signal)
    }
    handlers.set(signal, handler)
    process.on(signal, handler)
  }
  child.on("error", (error) => {
    console.error(error)
    process.exitCode = 1
  })
  child.on("exit", (code, signal) => {
    for (const [name, handler] of handlers) process.off(name, handler)
    // Node's test runner can turn SIGTERM into exit 1 while stopping workers.
    const termination = receivedSignal ?? signal
    if (termination) process.kill(process.pid, termination)
    else process.exitCode = code ?? 1
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
