#!/usr/bin/env node

/**
 * Schedules a detached, delayed relaunch. This file does not quit the App
 * itself; launchd owns relaunch-worker.mjs before the current runtime exits.
 */

import { resolve } from "node:path"

import {
  ensurePrivateDirectory,
  parseCommonOptions,
  relayPaths,
  writeJsonAtomic,
} from "./shared.mjs"
import { runPreflight } from "./preflight.mjs"
import { commandResult, RELAUNCH_LABEL_PREFIX, relayShimPath, workerPath } from "./shared.mjs"

const argv = process.argv.slice(2)
if (!argv.includes("--confirm-restart-codex-app")) {
  throw new Error(
    "Refusing to schedule a restart. Re-run with the exact flag --confirm-restart-codex-app"
  )
}
if (!argv.includes("--dry-run") && !argv.includes("--accept-browser-unavailable")) {
  throw new Error(
    "Refusing to launch the transparent relay: live tests prove it disables the App-owned Browser. Re-run with --accept-browser-unavailable only for protocol experiments."
  )
}

const options = parseCommonOptions(argv)
const delayIndex = argv.indexOf("--delay-seconds")
const delaySeconds = delayIndex >= 0 ? Number(argv[delayIndex + 1]) : 15
const workspaceIndex = argv.indexOf("--workspace")
const workspace = resolve(workspaceIndex >= 0 ? argv[workspaceIndex + 1] : process.cwd())
if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 10 || delaySeconds > 120) {
  throw new Error("--delay-seconds must be an integer between 10 and 120")
}

const preflight = await runPreflight(
  argv.filter((argument) => argument !== "--confirm-restart-codex-app")
)
if (!preflight.ready) {
  process.stderr.write(`${JSON.stringify(preflight, null, 2)}\n`)
  throw new Error("Preflight failed; no restart was scheduled")
}

const paths = relayPaths(options.stateDir)
const label = `${RELAUNCH_LABEL_PREFIX}.${process.getuid()}`
const worker = workerPath("relaunch-worker.mjs")
const launcher = workerPath("one-shot-launcher.mjs")
const workerArgs = [
  worker,
  "--port",
  String(options.port),
  "--state-dir",
  options.stateDir,
  "--real-cli",
  options.realCli,
  "--app-path",
  options.appPath,
  "--shim",
  relayShimPath(),
  "--workspace",
  workspace,
  "--delay-seconds",
  String(delaySeconds),
]
if (options.cdpPort != null) workerArgs.push("--cdp-port", String(options.cdpPort))
if (argv.includes("--run-browser-smoke")) workerArgs.push("--run-browser-smoke")
if (argv.includes("--run-cdp-bootstrap-smoke")) workerArgs.push("--run-cdp-bootstrap-smoke")

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
          paths.relaunchStdout,
          "-e",
          paths.relaunchStderr,
          "--",
          process.execPath,
          launcher,
          "--label",
          label,
          "--",
          process.execPath,
          ...workerArgs,
        ],
        automaticRollback: true,
        cdpPort: options.cdpPort,
        runBrowserSmoke: argv.includes("--run-browser-smoke"),
        runCdpBootstrapSmoke: argv.includes("--run-cdp-bootstrap-smoke"),
      },
      null,
      2
    )}\n`
  )
  process.exit(0)
}

await ensurePrivateDirectory(paths.root)

await writeJsonAtomic(paths.arm, {
  status: "armed",
  label,
  scheduledAt: new Date().toISOString(),
  delaySeconds,
  worker,
  options,
  workspace,
  cdpPort: options.cdpPort,
  runBrowserSmoke: argv.includes("--run-browser-smoke"),
  runCdpBootstrapSmoke: argv.includes("--run-cdp-bootstrap-smoke"),
  acceptsBrowserUnavailable: argv.includes("--accept-browser-unavailable"),
  cancelCommand: `pnpm --dir prototypes/codex-app-web-control relay:cancel`,
})

const submitted = commandResult("/bin/launchctl", [
  "submit",
  "-l",
  label,
  "-o",
  paths.relaunchStdout,
  "-e",
  paths.relaunchStderr,
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
  await writeJsonAtomic(paths.arm, {
    status: "submit-failed",
    label,
    failedAt: new Date().toISOString(),
    error: submitted.stderr || submitted.error,
  })
  throw new Error(submitted.stderr || submitted.error || "launchctl submit failed")
}

process.stdout.write(
  [
    "Relay relaunch is armed in a detached launchd job.",
    `Label: ${label}`,
    `Delay: ${delaySeconds}s`,
    `Cancel before the delay expires: pnpm --dir prototypes/codex-app-web-control relay:cancel`,
    `Worker log: ${paths.relaunchStdout}`,
    "Warning: this transparent relay is known to disable the App-owned Browser for the relayed App session.",
    "If relay health does not pass, the worker will automatically reopen Codex App normally.",
  ].join("\n") + "\n"
)
