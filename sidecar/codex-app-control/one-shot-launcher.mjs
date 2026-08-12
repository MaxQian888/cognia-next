#!/usr/bin/env node

/** Keeps a submitted launchd service alive until one child run completes, then unloads it. */

import { spawn } from "node:child_process"

import { commandResult } from "./shared.mjs"

const argv = process.argv.slice(2)
const labelIndex = argv.indexOf("--label")
const separatorIndex = argv.indexOf("--")
const label = labelIndex >= 0 ? argv[labelIndex + 1] : null
const command = separatorIndex >= 0 ? argv[separatorIndex + 1] : null
const args = separatorIndex >= 0 ? argv.slice(separatorIndex + 2) : []

if (!label) throw new Error("--label is required")
if (!command) throw new Error("A command is required after --")

const child = spawn(command, args, { stdio: "inherit" })
const outcome = await new Promise((resolve) => {
  child.once("error", (error) => resolve({ status: 1, error }))
  child.once("exit", (status, signal) => resolve({ status: status ?? 1, signal }))
})

if (outcome.error) process.stderr.write(`${outcome.error.message}\n`)
if (outcome.signal) process.stderr.write(`Worker exited from signal ${outcome.signal}\n`)

// Removing the service may terminate this launcher before the call returns.
// The worker has already finished, so there is no remaining cleanup to lose.
const removed = commandResult("/bin/launchctl", ["remove", label])
if (!removed.ok) {
  process.stderr.write(`${removed.stderr || removed.error || `Unable to remove ${label}`}\n`)
}
process.exitCode = outcome.status
