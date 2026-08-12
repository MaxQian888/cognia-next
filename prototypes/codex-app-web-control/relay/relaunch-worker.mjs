#!/usr/bin/env node

/** Detached launchd worker. Never invoke directly; use arm-relaunch.mjs. */

import { dirname, resolve } from "node:path"

import { discoverCodexRenderer } from "./cdp-bootstrap.mjs"
import { buildRelayOpenArgs } from "./launch-config.mjs"
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
  workerPath,
} from "./shared.mjs"

const argv = process.argv.slice(2)
const options = parseCommonOptions(argv)
const paths = relayPaths(options.stateDir)

function valueAfter(name, fallback = null) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : fallback
}

const shim = resolve(valueAfter("--shim"))
const workspace = resolve(valueAfter("--workspace", process.cwd()))
const delaySeconds = Number(valueAfter("--delay-seconds", "15"))
const runBrowserSmoke = argv.includes("--run-browser-smoke")
const runCdpBootstrapSmoke = argv.includes("--run-cdp-bootstrap-smoke")

async function record(status, details = {}) {
  await writeJsonAtomic(paths.relaunchResult, {
    status,
    at: new Date().toISOString(),
    ...details,
  })
}

async function requestQuit() {
  if (appProcessIds().length === 0) return
  const quit = commandResult("/usr/bin/osascript", [
    "-e",
    `tell application id "${APP_BUNDLE_ID}" to quit`,
  ])
  if (!quit.ok) throw new Error(quit.stderr || quit.error || "Unable to request App quit")
  await waitFor(() => appProcessIds().length === 0, {
    timeoutMs: 30_000,
    intervalMs: 250,
    description: "Codex App graceful exit",
  })
}

function openAppWithRelay() {
  const args = buildRelayOpenArgs({
    appPath: options.appPath,
    cdpPort: options.cdpPort,
    nodeDirectory: dirname(process.execPath),
    port: options.port,
    realCli: options.realCli,
    shim,
    stateDir: options.stateDir,
    workspace,
  })
  const opened = commandResult("/usr/bin/open", args)
  if (!opened.ok) throw new Error(opened.stderr || opened.error || "Unable to launch relay App")
}

function openAppNormally() {
  const opened = commandResult("/usr/bin/open", ["--new", options.appPath])
  if (!opened.ok) throw new Error(opened.stderr || opened.error || "Unable to restore normal App")
}

async function autoRollback(error) {
  await record("relay-health-failed", {
    error: error instanceof Error ? error.message : String(error),
  })
  try {
    await requestQuit()
  } catch (quitError) {
    await record("rollback-blocked", {
      relayError: error instanceof Error ? error.message : String(error),
      quitError: quitError instanceof Error ? quitError.message : String(quitError),
    })
    return
  }
  openAppNormally()
  await record("auto-rolled-back", {
    relayError: error instanceof Error ? error.message : String(error),
  })
}

await record("countdown", { delaySeconds, currentAppPids: appProcessIds() })
await sleep(delaySeconds * 1000)

try {
  await record("quitting-current-app", { currentAppPids: appProcessIds() })
  await requestQuit()
  await record("launching-relay-app", { shim, workspace, port: options.port })
  openAppWithRelay()
  const health = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${options.port}/healthz`, {
        signal: AbortSignal.timeout(1500),
      }).catch(() => null)
      if (!response?.ok) return null
      const payload = await response.json().catch(() => null)
      return payload?.status === "ready" ? payload : null
    },
    { timeoutMs: 60_000, intervalMs: 500, description: "relay health endpoint" }
  )
  await record("ready", { health, appPids: appProcessIds() })
  if (options.cdpPort != null) {
    const cdpTarget = await waitFor(
      () => discoverCodexRenderer(options.cdpPort).catch(() => null),
      { timeoutMs: 30_000, intervalMs: 250, description: "Codex renderer CDP target" }
    )
    const listener = inspectTcpListener(options.cdpPort)
    if (!listener.loopbackOnly) {
      throw new Error(
        `CDP listener is not loopback-only: ${listener.addresses.join(", ") || "none"}`
      )
    }
    await record("ready", {
      health,
      appPids: appProcessIds(),
      cdp: {
        port: options.cdpPort,
        rendererId: cdpTarget.id,
        rendererUrl: cdpTarget.url,
        listener,
      },
    })
  }
  if (runCdpBootstrapSmoke) {
    if (options.cdpPort == null) throw new Error("CDP bootstrap smoke requires --cdp-port")
    const browserCheck = commandResult(
      process.execPath,
      [
        workerPath("cdp-bootstrap-smoke.mjs"),
        "--confirm-create-codex-task",
        "--port",
        String(options.port),
        "--cdp-port",
        String(options.cdpPort),
        "--state-dir",
        options.stateDir,
        "--real-cli",
        options.realCli,
        "--app-path",
        options.appPath,
      ],
      { timeout: 260_000, maxBuffer: 2 * 1024 * 1024 }
    )
    await writeJsonAtomic(paths.liveTestResult, {
      status: browserCheck.ok ? "passed" : "failed",
      mode: "app-originated-cdp-bootstrap",
      at: new Date().toISOString(),
      stdout: browserCheck.stdout,
      stderr: browserCheck.stderr,
      exitStatus: browserCheck.status,
      signal: browserCheck.signal,
      error: browserCheck.error,
    })
    if (!browserCheck.ok) {
      throw new Error("App-owned CDP Browser bootstrap failed; restoring normal App startup")
    }
  }
  if (runBrowserSmoke) {
    await waitFor(
      async () => {
        const response = await fetch(`http://127.0.0.1:${options.port}/healthz`, {
          signal: AbortSignal.timeout(1500),
        }).catch(() => null)
        const payload = await response?.json().catch(() => null)
        return payload?.activeThreadId ? payload : null
      },
      { timeoutMs: 45_000, intervalMs: 500, description: "desktop active task restoration" }
    )
    const browserCheck = commandResult(
      process.execPath,
      [
        workerPath("browser-smoke.mjs"),
        "--confirm-run-browser-smoke",
        "--port",
        String(options.port),
        "--state-dir",
        options.stateDir,
        "--real-cli",
        options.realCli,
        "--app-path",
        options.appPath,
      ],
      { timeout: 200_000, maxBuffer: 2 * 1024 * 1024 }
    )
    await writeJsonAtomic(paths.liveTestResult, {
      status: browserCheck.ok ? "passed" : "failed",
      at: new Date().toISOString(),
      stdout: browserCheck.stdout,
      stderr: browserCheck.stderr,
      exitStatus: browserCheck.status,
      signal: browserCheck.signal,
      error: browserCheck.error,
    })
    if (!browserCheck.ok) {
      throw new Error("App-owned Browser smoke failed; restoring normal App startup")
    }
  }
} catch (error) {
  await autoRollback(error)
  process.exitCode = 1
}
