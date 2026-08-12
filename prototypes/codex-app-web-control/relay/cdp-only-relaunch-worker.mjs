#!/usr/bin/env node

/** Detached worker that preserves App ownership and only enables loopback CDP. */

import { buildCdpOnlyAppOpenArgs } from "./launch-config.mjs"
import { discoverCodexRenderer } from "./cdp-bootstrap.mjs"
import { inspectTcpListener } from "./listener-safety.mjs"
import {
  APP_BUNDLE_ID,
  appProcessIds,
  commandResult,
  parseCommonOptions,
  relayPaths,
  sleep,
  waitFor,
  writeJsonAtomic,
} from "./shared.mjs"

const argv = process.argv.slice(2)
const options = parseCommonOptions(argv)
const delayIndex = argv.indexOf("--delay-seconds")
const delaySeconds = delayIndex >= 0 ? Number(argv[delayIndex + 1]) : 15
const attemptIndex = argv.indexOf("--attempt-id")
const attemptId = attemptIndex >= 0 ? argv[attemptIndex + 1] : null
const paths = relayPaths(options.stateDir)
let appWasStopped = false

async function record(status, details = {}) {
  await writeJsonAtomic(paths.cdpOnlyRelaunchResult, {
    status,
    at: new Date().toISOString(),
    attemptId,
    cdpAddress: `127.0.0.1:${options.cdpPort}`,
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

function openCdpOnlyApp() {
  const opened = commandResult(
    "/usr/bin/open",
    buildCdpOnlyAppOpenArgs({ appPath: options.appPath, cdpPort: options.cdpPort })
  )
  if (!opened.ok) throw new Error(opened.stderr || opened.error || "Unable to launch CDP-only App")
}

function openNormalApp() {
  const opened = commandResult("/usr/bin/open", ["--new", options.appPath])
  if (!opened.ok) throw new Error(opened.stderr || opened.error || "Unable to restore normal App")
}

function normalAppServerChildren() {
  const appPids = new Set(appProcessIds())
  const listed = commandResult("/bin/ps", ["-axo", "pid=,ppid=,command="])
  if (!listed.ok) throw new Error(listed.stderr || listed.error || "Unable to inspect App children")
  return listed.stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter((match) => {
      const command = match?.[3] ?? ""
      return (
        appPids.has(Number(match?.[2])) &&
        command.startsWith(
          `${options.realCli} -c features.code_mode_host=true app-server --analytics-default-enabled`
        ) &&
        !command.includes("--listen") &&
        !command.includes("relay-shim")
      )
    })
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }))
}

async function restoreNormalApp(cdpError) {
  await record("cdp-health-failed", { error: cdpError })
  try {
    await requestQuit()
    openNormalApp()
    await waitFor(() => appProcessIds().length === 1, {
      timeoutMs: 30_000,
      intervalMs: 250,
      description: "normal Codex App rollback launch",
    })
    await record("auto-rolled-back", { cdpError, appPids: appProcessIds() })
  } catch (rollbackError) {
    await record("rollback-blocked", {
      cdpError,
      rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
    })
  }
}

await record("countdown", { delaySeconds, currentAppPids: appProcessIds() })
await sleep(delaySeconds * 1000)

try {
  await record("quitting-current-app", { currentAppPids: appProcessIds() })
  await requestQuit()
  appWasStopped = true
  await record("launching-cdp-only-app")
  openCdpOnlyApp()
  await waitFor(() => appProcessIds().length === 1, {
    timeoutMs: 30_000,
    intervalMs: 250,
    description: "CDP-only Codex App launch",
  })
  const renderer = await waitFor(() => discoverCodexRenderer(options.cdpPort).catch(() => null), {
    timeoutMs: 30_000,
    intervalMs: 250,
    description: "Codex renderer CDP target",
  })
  const listener = await waitFor(
    () => {
      const inspected = inspectTcpListener(options.cdpPort)
      return inspected.loopbackOnly ? inspected : null
    },
    { timeoutMs: 15_000, intervalMs: 250, description: "loopback-only CDP listener" }
  )
  const appServerChildren = await waitFor(
    () => {
      const children = normalAppServerChildren()
      return children.length === 1 ? children : null
    },
    { timeoutMs: 30_000, intervalMs: 250, description: "normal App-owned App Server child" }
  )
  await record("ready", {
    appPids: appProcessIds(),
    renderer: { id: renderer.id, url: renderer.url ?? null },
    listener,
    appServerChildren,
    cliOverride: false,
    sharedDaemon: false,
  })
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (!appWasStopped) {
    await record("restart-cancelled-app-still-normal", {
      error: message,
      currentAppPids: appProcessIds(),
    })
  } else {
    await restoreNormalApp(message)
  }
  process.exitCode = 1
}
