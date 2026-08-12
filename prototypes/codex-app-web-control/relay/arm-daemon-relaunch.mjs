#!/usr/bin/env node

/** Schedules a restart into the shared Unix App Server runtime. */

import { createReadStream } from "node:fs"

import { defaultControlSocketPath, sharedRuntimeLabels } from "./daemon-control.mjs"
import {
  APP_EXECUTABLE,
  appProcessIds,
  assertExecutable,
  commandResult,
  ensurePrivateDirectory,
  launchctlJobExists,
  parseCommonOptions,
  relayPaths,
  workerPath,
  writeJsonAtomic,
} from "./shared.mjs"

const argv = process.argv.slice(2)
if (!argv.includes("--confirm-restart-codex-app")) {
  throw new Error("Refusing to restart Codex App without --confirm-restart-codex-app")
}
const options = parseCommonOptions(argv)
const paths = relayPaths(options.stateDir)
const labels = sharedRuntimeLabels()
const socketPath = defaultControlSocketPath()
const delayIndex = argv.indexOf("--delay-seconds")
const delaySeconds = delayIndex >= 0 ? Number(argv[delayIndex + 1]) : 15
if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 10 || delaySeconds > 120) {
  throw new Error("--delay-seconds must be an integer between 10 and 120")
}

async function fileContains(path, text) {
  const needle = Buffer.from(text)
  let tail = Buffer.alloc(0)
  for await (const chunk of createReadStream(path)) {
    const combined = Buffer.concat([tail, chunk])
    if (combined.indexOf(needle) >= 0) return true
    tail = combined.subarray(Math.max(0, combined.length - needle.length + 1))
  }
  return false
}

await assertExecutable(APP_EXECUTABLE)
await assertExecutable(options.realCli)
if (appProcessIds().length !== 1) throw new Error("Exactly one Codex App process must be running")
if (launchctlJobExists(labels.daemon) || launchctlJobExists(labels.relaunch)) {
  throw new Error("A shared-runtime daemon or relaunch job already exists")
}
const appAsar = `${options.appPath}/Contents/Resources/app.asar`
for (const marker of ["CODEX_APP_SERVER_USE_LOCAL_DAEMON", "CODEX_APP_SERVER_FORCE_CLI"]) {
  if (!(await fileContains(appAsar, marker))) throw new Error(`Installed App lacks ${marker}`)
}

const workerArgs = [
  workerPath("daemon-relaunch-worker.mjs"),
  "--state-dir",
  options.stateDir,
  "--real-cli",
  options.realCli,
  "--app-path",
  options.appPath,
  "--socket",
  socketPath,
  "--delay-seconds",
  String(delaySeconds),
]
const launchArgs = [
  "submit",
  "-l",
  labels.relaunch,
  "-o",
  paths.daemonRelaunchStdout,
  "-e",
  paths.daemonRelaunchStderr,
  "--",
  process.execPath,
  workerPath("one-shot-launcher.mjs"),
  "--label",
  labels.relaunch,
  "--",
  process.execPath,
  ...workerArgs,
]

if (argv.includes("--dry-run")) {
  process.stdout.write(
    `${JSON.stringify({ dryRun: true, mutatesApp: false, delaySeconds, socketPath, labels, launchctl: ["/bin/launchctl", ...launchArgs], automaticRollback: true }, null, 2)}\n`
  )
  process.exit(0)
}

await ensurePrivateDirectory(paths.root)
await writeJsonAtomic(paths.daemonRelaunchResult, {
  status: "armed",
  at: new Date().toISOString(),
  delaySeconds,
  socketPath,
  labels,
})
const submitted = commandResult("/bin/launchctl", launchArgs)
if (!submitted.ok)
  throw new Error(submitted.stderr || submitted.error || "Unable to submit relaunch job")
process.stdout.write(
  `Shared-runtime relaunch is armed in ${delaySeconds}s.\nResult: ${paths.daemonRelaunchResult}\n` +
    `If Codex App remains open, quit it manually within 3 minutes; the detached worker will continue.\n` +
    `Automatic normal-App rollback is enabled after the shared runtime starts.\n`
)
