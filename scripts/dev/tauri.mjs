#!/usr/bin/env node

import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

export function withFailFastDev(args) {
  if (args[0] !== "dev") return args

  const separator = args.indexOf("--")
  const tauriArgs = separator === -1 ? args : args.slice(0, separator)
  if (tauriArgs.includes("--exit-on-panic") || tauriArgs.includes("--no-watch")) return args

  return ["dev", "--exit-on-panic", ...args.slice(1)]
}

export async function runTauri(args, { env = process.env } = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
  const child = spawn(pnpm, ["exec", "tauri", ...withFailFastDev(args)], {
    cwd: root,
    env,
    stdio: "inherit",
  })

  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({ code, signal }))
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runTauri(process.argv.slice(2))
  if (result.signal) process.kill(process.pid, result.signal)
  process.exit(result.code ?? 1)
}
