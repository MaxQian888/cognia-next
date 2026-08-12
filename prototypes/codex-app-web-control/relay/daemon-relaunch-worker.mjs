#!/usr/bin/env node

/** Detached worker for the shared UDS runtime experiment. Use arm-daemon-relaunch.mjs. */

import { dirname } from "node:path"

import {
  moveStaleSocketAside,
  probeAppServer,
  restoreStaleSocket,
  sharedRuntimeLabels,
} from "./daemon-control.mjs"
import { buildDaemonAppOpenArgs } from "./launch-config.mjs"
import {
  APP_BUNDLE_ID,
  appProcessIds,
  commandResult,
  launchctlJobExists,
  parseCommonOptions,
  relayPaths,
  sleep,
  waitFor,
  writeJsonAtomic,
} from "./shared.mjs"

const argv = process.argv.slice(2)
const options = parseCommonOptions(argv)
const paths = relayPaths(options.stateDir)
const labels = sharedRuntimeLabels()
const socketPath = argv[argv.indexOf("--socket") + 1]
const delaySeconds = Number(argv[argv.indexOf("--delay-seconds") + 1] ?? 15)
let staleSocketBackup = null
let sharedRuntimeStarted = false

async function record(status, details = {}) {
  await writeJsonAtomic(paths.daemonRelaunchResult, {
    status,
    at: new Date().toISOString(),
    socketPath,
    labels,
    ...details,
  })
}

async function requestQuit() {
  if (appProcessIds().length === 0) return
  const quit = commandResult("/usr/bin/osascript", [
    "-e",
    `tell application id "${APP_BUNDLE_ID}" to quit`,
  ])
  await record("waiting-for-app-exit", {
    quitRequest: quit.ok ? "accepted" : "manual-quit-required",
    quitError: quit.ok ? null : quit.stderr || quit.error,
    currentAppPids: appProcessIds(),
  })
  await waitFor(() => appProcessIds().length === 0, {
    timeoutMs: 180_000,
    intervalMs: 250,
    description: "Codex App graceful or manual exit",
  })
}

function submitSharedRuntime() {
  if (launchctlJobExists(labels.daemon))
    throw new Error(`Daemon job already exists: ${labels.daemon}`)
  const submitted = commandResult("/bin/launchctl", [
    "submit",
    "-l",
    labels.daemon,
    "-o",
    paths.daemonStdout,
    "-e",
    paths.daemonStderr,
    "--",
    options.realCli,
    "-c",
    "features.code_mode_host=true",
    "app-server",
    "--listen",
    "unix://",
    "--analytics-default-enabled",
  ])
  if (!submitted.ok) {
    throw new Error(submitted.stderr || submitted.error || "Unable to submit App Server job")
  }
}

function removeSharedRuntime() {
  if (!launchctlJobExists(labels.daemon)) return
  const removed = commandResult("/bin/launchctl", ["remove", labels.daemon])
  if (!removed.ok)
    throw new Error(removed.stderr || removed.error || "Unable to stop App Server job")
}

function openAppWithDaemon() {
  const opened = commandResult(
    "/usr/bin/open",
    buildDaemonAppOpenArgs({ appPath: options.appPath, nodeDirectory: dirname(process.execPath) })
  )
  if (!opened.ok)
    throw new Error(opened.stderr || opened.error || "Unable to launch daemon-mode App")
}

function openAppNormally() {
  const opened = commandResult("/usr/bin/open", ["--new", options.appPath])
  if (!opened.ok) throw new Error(opened.stderr || opened.error || "Unable to restore normal App")
}

function appOwnedAppServerPids() {
  const appPids = new Set(appProcessIds())
  const listed = commandResult("/bin/ps", ["-axo", "pid=,ppid=,command="])
  if (!listed.ok) throw new Error(listed.stderr || listed.error || "Unable to inspect App children")
  return listed.stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter((match) => appPids.has(Number(match?.[2])) && match?.[3]?.startsWith(options.realCli))
    .map((match) => Number(match[1]))
}

async function stopRuntimeAndRestoreSocket() {
  removeSharedRuntime()
  await waitFor(
    async () => {
      try {
        await probeAppServer(socketPath, 500)
        return false
      } catch {
        return true
      }
    },
    { timeoutMs: 15_000, intervalMs: 250, description: "shared App Server shutdown" }
  )
  await restoreStaleSocket(socketPath, staleSocketBackup)
}

async function autoRollback(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (!sharedRuntimeStarted) {
    await record("restart-cancelled-app-still-normal", {
      error: message,
      currentAppPids: appProcessIds(),
    })
    return
  }
  await record("shared-runtime-health-failed", { error: message })
  try {
    await requestQuit()
    await stopRuntimeAndRestoreSocket()
    openAppNormally()
    await record("auto-rolled-back", { sharedRuntimeError: message })
  } catch (rollbackError) {
    await record("rollback-blocked", {
      sharedRuntimeError: message,
      rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
    })
  }
}

await record("countdown", { delaySeconds, currentAppPids: appProcessIds() })
await sleep(delaySeconds * 1000)

try {
  await record("quitting-current-app", { currentAppPids: appProcessIds() })
  await requestQuit()
  staleSocketBackup = await moveStaleSocketAside(socketPath)
  await record("launching-shared-runtime", { staleSocketBackup })
  submitSharedRuntime()
  sharedRuntimeStarted = true
  const serverInfo = await waitFor(() => probeAppServer(socketPath, 1_500).catch(() => null), {
    timeoutMs: 60_000,
    intervalMs: 500,
    description: "shared App Server control socket",
  })
  const daemonVersion = commandResult(options.realCli, ["app-server", "daemon", "version"], {
    timeout: 5_000,
  })
  if (!daemonVersion.ok) {
    throw new Error(daemonVersion.stderr || daemonVersion.error || "Daemon version probe failed")
  }
  await record("launching-daemon-mode-app", { serverInfo, daemonVersion: daemonVersion.stdout })
  openAppWithDaemon()
  await waitFor(() => appProcessIds().length === 1, {
    timeoutMs: 30_000,
    intervalMs: 250,
    description: "daemon-mode Codex App launch",
  })
  await waitFor(() => appOwnedAppServerPids().length === 0, {
    timeoutMs: 15_000,
    intervalMs: 500,
    description: "Codex App attachment to shared runtime",
  })
  await writeJsonAtomic(paths.daemonState, {
    status: "ready",
    at: new Date().toISOString(),
    socketPath,
    staleSocketBackup,
    labels,
    serverInfo,
    daemonVersion: JSON.parse(daemonVersion.stdout),
    appPids: appProcessIds(),
    appOwnedAppServerPids: appOwnedAppServerPids(),
  })
  await record("ready", {
    serverInfo,
    daemonVersion: JSON.parse(daemonVersion.stdout),
    appPids: appProcessIds(),
    appOwnedAppServerPids: appOwnedAppServerPids(),
  })
} catch (error) {
  await autoRollback(error)
  process.exitCode = 1
}
