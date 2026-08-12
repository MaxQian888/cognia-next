#!/usr/bin/env node

/** Detached rollback worker for the shared UDS runtime. Use daemon-rollback.mjs. */

import {
  defaultControlSocketPath,
  probeAppServer,
  restoreStaleSocket,
  sharedRuntimeLabels,
} from "./daemon-control.mjs"
import {
  APP_BUNDLE_ID,
  appProcessIds,
  commandResult,
  launchctlJobExists,
  parseCommonOptions,
  readJson,
  relayPaths,
  sleep,
  waitFor,
  writeJsonAtomic,
} from "./shared.mjs"

const argv = process.argv.slice(2)
const options = parseCommonOptions(argv)
const paths = relayPaths(options.stateDir)
const state = await readJson(paths.daemonState)
const labels = state?.labels ?? sharedRuntimeLabels()
const socketPath = state?.socketPath ?? defaultControlSocketPath()
const staleSocketBackup = state?.staleSocketBackup ?? null
const delaySeconds = Number(argv[argv.indexOf("--delay-seconds") + 1] ?? 10)

async function record(status, details = {}) {
  await writeJsonAtomic(paths.daemonRollbackResult, {
    status,
    at: new Date().toISOString(),
    socketPath,
    labels,
    ...details,
  })
}

await record("countdown", { delaySeconds, currentAppPids: appProcessIds() })
await sleep(delaySeconds * 1000)

try {
  if (appProcessIds().length > 0) {
    const quit = commandResult("/usr/bin/osascript", [
      "-e",
      `tell application id "${APP_BUNDLE_ID}" to quit`,
    ])
    if (!quit.ok) throw new Error(quit.stderr || quit.error || "Unable to request App quit")
    await waitFor(() => appProcessIds().length === 0, {
      timeoutMs: 30_000,
      intervalMs: 250,
      description: "daemon-mode Codex App graceful exit",
    })
  }
  if (launchctlJobExists(labels.daemon)) {
    const removed = commandResult("/bin/launchctl", ["remove", labels.daemon])
    if (!removed.ok)
      throw new Error(removed.stderr || removed.error || "Unable to stop shared runtime")
  }
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
  const restoredStaleSocket = await restoreStaleSocket(socketPath, staleSocketBackup)
  const opened = commandResult("/usr/bin/open", ["--new", options.appPath])
  if (!opened.ok) throw new Error(opened.stderr || opened.error || "Unable to open normal App")
  await waitFor(() => appProcessIds().length === 1, {
    timeoutMs: 30_000,
    intervalMs: 250,
    description: "normal Codex App launch",
  })
  await record("rolled-back", { restoredStaleSocket, appPids: appProcessIds() })
} catch (error) {
  await record("rollback-failed", { error: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
}
