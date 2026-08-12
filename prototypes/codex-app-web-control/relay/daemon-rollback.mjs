#!/usr/bin/env node

/** Schedules a safe return from the shared UDS runtime to normal App startup. */

import { sharedRuntimeLabels } from "./daemon-control.mjs"
import {
  commandResult,
  ensurePrivateDirectory,
  launchctlJobExists,
  parseCommonOptions,
  relayPaths,
  workerPath,
  writeJsonAtomic,
} from "./shared.mjs"

const argv = process.argv.slice(2)
if (!argv.includes("--confirm-rollback-codex-app")) {
  throw new Error("Refusing to restart Codex App without --confirm-rollback-codex-app")
}
const options = parseCommonOptions(argv)
const paths = relayPaths(options.stateDir)
const labels = sharedRuntimeLabels()
const delayIndex = argv.indexOf("--delay-seconds")
const delaySeconds = delayIndex >= 0 ? Number(argv[delayIndex + 1]) : 10
if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 5 || delaySeconds > 120) {
  throw new Error("--delay-seconds must be an integer between 5 and 120")
}
if (launchctlJobExists(labels.rollback))
  throw new Error(`Rollback job already exists: ${labels.rollback}`)

const launchArgs = [
  "submit",
  "-l",
  labels.rollback,
  "-o",
  paths.daemonRollbackStdout,
  "-e",
  paths.daemonRollbackStderr,
  "--",
  process.execPath,
  workerPath("one-shot-launcher.mjs"),
  "--label",
  labels.rollback,
  "--",
  process.execPath,
  workerPath("daemon-rollback-worker.mjs"),
  "--state-dir",
  options.stateDir,
  "--real-cli",
  options.realCli,
  "--app-path",
  options.appPath,
  "--delay-seconds",
  String(delaySeconds),
]

if (argv.includes("--dry-run")) {
  process.stdout.write(
    `${JSON.stringify({ dryRun: true, mutatesApp: false, delaySeconds, labels, launchctl: ["/bin/launchctl", ...launchArgs] }, null, 2)}\n`
  )
  process.exit(0)
}

await ensurePrivateDirectory(paths.root)
await writeJsonAtomic(paths.daemonRollbackResult, {
  status: "armed",
  at: new Date().toISOString(),
  delaySeconds,
  labels,
})
const submitted = commandResult("/bin/launchctl", launchArgs)
if (!submitted.ok)
  throw new Error(submitted.stderr || submitted.error || "Unable to submit rollback job")
process.stdout.write(
  `Shared-runtime rollback is armed in ${delaySeconds}s.\nResult: ${paths.daemonRollbackResult}\n`
)
