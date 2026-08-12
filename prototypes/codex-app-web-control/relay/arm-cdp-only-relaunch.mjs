#!/usr/bin/env node

/** Schedules a normal Codex App restart with loopback CDP enabled. */

import { createServer } from "node:net"

import {
  APP_EXECUTABLE,
  CDP_ONLY_RELAUNCH_LABEL_PREFIX,
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
const options = parseCommonOptions([
  ...argv,
  ...(argv.includes("--cdp-port") ? [] : ["--cdp-port", "9229"]),
])
const paths = relayPaths(options.stateDir)
const label = `${CDP_ONLY_RELAUNCH_LABEL_PREFIX}.${process.getuid()}`
const delayIndex = argv.indexOf("--delay-seconds")
const delaySeconds = delayIndex >= 0 ? Number(argv[delayIndex + 1]) : 15
if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 10 || delaySeconds > 120) {
  throw new Error("--delay-seconds must be an integer between 10 and 120")
}

async function portAvailable(port) {
  return new Promise((resolveAvailable) => {
    const server = createServer()
    server.once("error", () => resolveAvailable(false))
    server.listen(port, "127.0.0.1", () => server.close(() => resolveAvailable(true)))
  })
}

await assertExecutable(APP_EXECUTABLE)
await assertExecutable(options.realCli)
if (appProcessIds().length !== 1) throw new Error("Exactly one Codex App process must be running")
if (launchctlJobExists(label)) throw new Error(`A CDP-only relaunch job already exists: ${label}`)
if (!(await portAvailable(options.cdpPort))) {
  throw new Error(`CDP port is already in use: 127.0.0.1:${options.cdpPort}`)
}
const openHelp = commandResult("/usr/bin/open", ["--help"])
if (!`${openHelp.stdout}\n${openHelp.stderr}`.includes("--args")) {
  throw new Error("Installed /usr/bin/open does not support --args")
}

const workerArgs = [
  workerPath("cdp-only-relaunch-worker.mjs"),
  "--state-dir",
  options.stateDir,
  "--real-cli",
  options.realCli,
  "--app-path",
  options.appPath,
  "--cdp-port",
  String(options.cdpPort),
  "--delay-seconds",
  String(delaySeconds),
]
const launchArgs = [
  "submit",
  "-l",
  label,
  "-o",
  paths.cdpOnlyRelaunchStdout,
  "-e",
  paths.cdpOnlyRelaunchStderr,
  "--",
  process.execPath,
  workerPath("one-shot-launcher.mjs"),
  "--label",
  label,
  "--",
  process.execPath,
  ...workerArgs,
]

if (argv.includes("--dry-run")) {
  process.stdout.write(
    `${JSON.stringify(
      {
        dryRun: true,
        mutatesApp: false,
        delaySeconds,
        cdpAddress: `127.0.0.1:${options.cdpPort}`,
        label,
        launchctl: ["/bin/launchctl", ...launchArgs],
        cliOverride: false,
        sharedDaemon: false,
        automaticRollback: true,
      },
      null,
      2
    )}\n`
  )
  process.exit(0)
}

await ensurePrivateDirectory(paths.root)
await writeJsonAtomic(paths.cdpOnlyRelaunchResult, {
  status: "armed",
  at: new Date().toISOString(),
  delaySeconds,
  cdpAddress: `127.0.0.1:${options.cdpPort}`,
  label,
})
const submitted = commandResult("/bin/launchctl", launchArgs)
if (!submitted.ok)
  throw new Error(submitted.stderr || submitted.error || "Unable to submit relaunch job")
process.stdout.write(
  `CDP-only relaunch is armed in ${delaySeconds}s.\nResult: ${paths.cdpOnlyRelaunchResult}\n` +
    "If Codex App remains open, quit it manually within 3 minutes; the detached worker will continue.\n" +
    "No CLI override or shared App Server will be installed. Automatic normal-App rollback is enabled.\n"
)
