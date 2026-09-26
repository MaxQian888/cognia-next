/** Keeps a submitted launchd service alive until one child run completes, then unloads it. */

import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"

import { commandResult } from "./shared.ts"

export interface OneShotArgs {
  label: string
  command: string
  args: string[]
}

/** `--label <label> -- <command> [args…]`. */
export function parseOneShotArgs(argv: readonly string[]): OneShotArgs {
  const labelIndex = argv.indexOf("--label")
  const separatorIndex = argv.indexOf("--")
  const label = labelIndex >= 0 ? argv[labelIndex + 1] : undefined
  const command = separatorIndex >= 0 ? argv[separatorIndex + 1] : undefined
  const args = separatorIndex >= 0 ? argv.slice(separatorIndex + 2) : []
  if (!label) throw new Error("--label is required")
  if (!command) throw new Error("A command is required after --")
  return { label, command, args }
}

export interface OneShotDependencies {
  spawn: (command: string, args: readonly string[], options: { stdio: "inherit" }) => ChildProcess
  commandResult: typeof commandResult
  writeStderr: (text: string) => void
}

/** Run the child once, remove the launchd service, and return the exit status to report. */
export async function runOneShot(
  argv: readonly string[],
  injected: Partial<OneShotDependencies> = {}
): Promise<number> {
  const dependencies: OneShotDependencies = {
    spawn,
    commandResult,
    writeStderr: (text) => process.stderr.write(text),
    ...injected,
  }
  const { label, command, args } = parseOneShotArgs(argv)
  const child = dependencies.spawn(command, args, { stdio: "inherit" })
  const outcome = await new Promise<{
    status: number
    error?: Error
    signal?: NodeJS.Signals | null
  }>((resolve) => {
    child.once("error", (error) => resolve({ status: 1, error }))
    child.once("exit", (status, signal) => resolve({ status: status ?? 1, signal }))
  })

  if (outcome.error) dependencies.writeStderr(`${outcome.error.message}\n`)
  if (outcome.signal) dependencies.writeStderr(`Worker exited from signal ${outcome.signal}\n`)

  // Removing the service may terminate this launcher before the call returns.
  // The worker has already finished, so there is no remaining cleanup to lose.
  const removed = dependencies.commandResult("/bin/launchctl", ["remove", label])
  if (!removed.ok) {
    dependencies.writeStderr(`${removed.stderr || removed.error || `Unable to remove ${label}`}\n`)
  }
  return outcome.status
}
