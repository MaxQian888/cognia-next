/**
 * Entry point of the bundled CLI (`dist/cognia-status-admin.mjs`): wires the
 * real process environment, fetch, `cloudflared` and terminal prompt into
 * `run()`.
 */

import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline/promises"

import type { CommandRunner } from "./auth"
import { run } from "./cli"

const runCommand: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: 60_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(error)
          return
        }
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const prompt = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await prompt.question(question)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    prompt.close()
  }
}

const code = await run(process.argv.slice(2), {
  env: process.env,
  fetch: (input, init) => fetch(input, init),
  run: runCommand,
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  confirm,
  newOperationId: () => `op-${randomUUID()}`,
})
process.exitCode = code
