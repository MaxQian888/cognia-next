#!/usr/bin/env node

/** Verifies user launchd detachment without touching Codex App. */

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { commandResult, launchctlJobExists, waitFor, workerPath } from "./shared.mjs"

const directory = await mkdtemp(join(tmpdir(), "cognia-relay-launchd-check-"))
const marker = join(directory, "marker")
const stdout = join(directory, "stdout.log")
const stderr = join(directory, "stderr.log")
const label = `com.cognia.codex-relay-poc.verify.${process.getuid()}.${process.pid}`

try {
  const script = [
    "const fs = require('node:fs');",
    "setTimeout(() => fs.writeFileSync(process.argv[1], String(process.ppid)), 150);",
  ].join("")
  const submitted = commandResult("/bin/launchctl", [
    "submit",
    "-l",
    label,
    "-o",
    stdout,
    "-e",
    stderr,
    "--",
    process.execPath,
    workerPath("one-shot-launcher.mjs"),
    "--label",
    label,
    "--",
    process.execPath,
    "-e",
    script,
    marker,
  ])
  if (!submitted.ok) {
    throw new Error(submitted.stderr || submitted.error || "launchctl submit verification failed")
  }
  const parentPid = await waitFor(
    async () => {
      const value = await readFile(marker, "utf8").catch(() => "")
      return value.trim() || null
    },
    { timeoutMs: 5000, intervalMs: 25, description: "detached launchd marker" }
  )
  await waitFor(() => !launchctlJobExists(label), {
    timeoutMs: 5000,
    intervalMs: 25,
    description: "one-shot launchd service unload",
  })
  process.stdout.write(
    `${JSON.stringify(
      {
        result: "PASS",
        mutatesApp: false,
        label,
        detachedWorkerParentPid: Number(parentPid),
        markerWritten: true,
        serviceUnloadedAfterWorkerExit: true,
      },
      null,
      2
    )}\n`
  )
} finally {
  if (launchctlJobExists(label)) commandResult("/bin/launchctl", ["remove", label])
  await rm(directory, { recursive: true, force: true })
}
