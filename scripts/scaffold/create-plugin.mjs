#!/usr/bin/env node
/**
 * Backward-compatible adapter for `pnpm plugin:create`.
 *
 * The Rust CLI owns all templates. This wrapper only translates the historical
 * JavaScript command-line flags and delegates to `cognia plugin new`.
 */

import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"

const UNSUPPORTED_FLAGS = new Set(["--force", "--no-config", "--capabilities"])

export function toCanonicalCliArgs(argv) {
  const args = ["plugin", "new"]
  let name
  let type

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--") continue
    if (UNSUPPORTED_FLAGS.has(arg)) {
      throw new Error(`${arg} is not supported; use 'cognia plugin new --help'`)
    }
    if (arg === "--yes" || arg === "-y") {
      args.push("--yes")
      continue
    }
    if (!arg.startsWith("-")) {
      if (name) throw new Error(`unexpected positional argument: ${arg}`)
      name = arg
      continue
    }

    const value = argv[index + 1]
    if (!value || value.startsWith("-")) throw new Error(`missing value for ${arg}`)
    index += 1
    switch (arg) {
      case "--name":
        name = value
        break
      case "--type":
      case "--kind":
        type = value
        break
      case "--dir":
      case "--author":
      case "--author-email":
      case "--description":
        args.push(arg, value)
        break
      default:
        throw new Error(`unknown option: ${arg}`)
    }
  }

  if (name) args.push(name)
  if (type) args.push("--kind", type === "frontend" ? "ts" : type)
  return args
}

export function runCanonicalCli(argv, { spawn = spawnSync, executable = "cognia" } = {}) {
  const args = toCanonicalCliArgs(argv)
  const result = spawn(executable, args, { stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`cognia plugin new exited with status ${result.status ?? "unknown"}`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCanonicalCli(process.argv.slice(2), {
      executable: process.env.COGNIA_PLUGIN_CLI || "cognia",
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
