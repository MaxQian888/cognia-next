#!/usr/bin/env node

/** Schedules rollback in launchd so it survives the relayed App exiting. */

import {
  commandResult,
  ensurePrivateDirectory,
  launchctlJobExists,
  parseCommonOptions,
  relayPaths,
  ROLLBACK_LABEL_PREFIX,
  workerPath,
  writeJsonAtomic,
} from "./shared.mjs"

const argv = process.argv.slice(2)
if (!argv.includes("--confirm-rollback-codex-app")) {
  throw new Error(
    "Refusing to restart Codex App. Re-run with the exact flag --confirm-rollback-codex-app"
  )
}
const options = parseCommonOptions(argv)
const delayIndex = argv.indexOf("--delay-seconds")
const delaySeconds = delayIndex >= 0 ? Number(argv[delayIndex + 1]) : 10
if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 5 || delaySeconds > 120) {
  throw new Error("--delay-seconds must be an integer between 5 and 120")
}

const paths = relayPaths(options.stateDir)
const label = `${ROLLBACK_LABEL_PREFIX}.${process.getuid()}`
const launcher = workerPath("one-shot-launcher.mjs")
const workerArgs = [
  workerPath("rollback-worker.mjs"),
  "--port",
  String(options.port),
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
    `${JSON.stringify(
      {
        dryRun: true,
        mutatesApp: false,
        label,
        delaySeconds,
        launchctl: [
          "/bin/launchctl",
          "submit",
          "-l",
          label,
          "-o",
          paths.rollbackStdout,
          "-e",
          paths.rollbackStderr,
          "--",
          process.execPath,
          launcher,
          "--label",
          label,
          "--",
          process.execPath,
          ...workerArgs,
        ],
      },
      null,
      2
    )}\n`
  )
  process.exit(0)
}

await ensurePrivateDirectory(paths.root)
if (launchctlJobExists(label)) throw new Error(`Rollback job already exists: ${label}`)

await writeJsonAtomic(paths.rollbackResult, {
  status: "armed",
  label,
  scheduledAt: new Date().toISOString(),
  delaySeconds,
})

const submitted = commandResult("/bin/launchctl", [
  "submit",
  "-l",
  label,
  "-o",
  paths.rollbackStdout,
  "-e",
  paths.rollbackStderr,
  "--",
  process.execPath,
  launcher,
  "--label",
  label,
  "--",
  process.execPath,
  ...workerArgs,
])
if (!submitted.ok) {
  throw new Error(submitted.stderr || submitted.error || "Unable to submit rollback job")
}

process.stdout.write(
  `Normal Codex App rollback is scheduled in ${delaySeconds}s via ${label}.\n` +
    `Result: ${paths.rollbackResult}\n`
)
