#!/usr/bin/env node

/** Non-mutating readiness check. It never quits or launches Codex App. */

import { createReadStream } from "node:fs"
import { createServer } from "node:net"
import { pathToFileURL } from "node:url"

import {
  APP_BUNDLE_ID,
  APP_EXECUTABLE,
  appProcessIds,
  assertExecutable,
  commandResult,
  launchctlJobExists,
  parseCommonOptions,
  relayPaths,
  relayShimPath,
  RELAUNCH_LABEL_PREFIX,
  ROLLBACK_LABEL_PREFIX,
  workerPath,
} from "./shared.mjs"

const SCRIPT_NAMES = [
  "relay-shim.mjs",
  "relay-state.mjs",
  "bootstrap-state.mjs",
  "cdp-bootstrap.mjs",
  "cdp-relaunch.mjs",
  "cdp-runtime.mjs",
  "cdp-web-service.mjs",
  "attachment-store.mjs",
  "command-registry.mjs",
  "native-folder-picker.mjs",
  "task-index.mjs",
  "launch-config.mjs",
  "unix-websocket.mjs",
  "daemon-control.mjs",
  "listener-safety.mjs",
  "shared.mjs",
  "fake-codex.mjs",
  "verify-simulator.mjs",
  "verify-real-app-server.mjs",
  "verify-detached-worker.mjs",
  "one-shot-launcher.mjs",
  "preflight.mjs",
  "arm-relaunch.mjs",
  "relaunch-worker.mjs",
  "cancel-relaunch.mjs",
  "health.mjs",
  "browser-smoke.mjs",
  "cdp-bootstrap-smoke.mjs",
  "web-dev.mjs",
  "rollback.mjs",
  "rollback-worker.mjs",
  "arm-daemon-relaunch.mjs",
  "daemon-relaunch-worker.mjs",
  "daemon-rollback.mjs",
  "daemon-rollback-worker.mjs",
  "rollout-mirror.mjs",
  "cdp-web.mjs",
  "start-cdp-web.mjs",
  "stop-cdp-web.mjs",
  "arm-cdp-only-relaunch.mjs",
  "cdp-only-relaunch-worker.mjs",
]

async function portAvailable(port) {
  return new Promise((resolveAvailable) => {
    const server = createServer()
    server.once("error", () => resolveAvailable(false))
    server.listen(port, "127.0.0.1", () => server.close(() => resolveAvailable(true)))
  })
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

export async function runPreflight(argv = process.argv.slice(2)) {
  const options = parseCommonOptions(argv)
  const checks = []
  const add = (name, ok, details) => checks.push({ name, ok, details })
  const paths = relayPaths(options.stateDir)
  const uid = process.getuid()
  const relaunchLabel = `${RELAUNCH_LABEL_PREFIX}.${uid}`
  const rollbackLabel = `${ROLLBACK_LABEL_PREFIX}.${uid}`

  add("platform", process.platform === "darwin", `${process.platform}/${process.arch}`)
  add(
    "state-directory-scope",
    paths.root.startsWith("/tmp/cognia-codex-relay-") && paths.root !== "/tmp",
    paths.root
  )

  for (const [name, path] of [
    ["app-executable", APP_EXECUTABLE],
    ["real-codex-cli", options.realCli],
    ["relay-shim", relayShimPath()],
  ]) {
    try {
      await assertExecutable(path)
      add(name, true, path)
    } catch (error) {
      add(name, false, `${path}: ${error.message}`)
    }
  }

  const bundleId = commandResult("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleIdentifier",
    `${options.appPath}/Contents/Info.plist`,
  ])
  add(
    "bundle-id",
    bundleId.ok && bundleId.stdout === APP_BUNDLE_ID,
    bundleId.stdout || bundleId.stderr
  )

  const appVersion = commandResult("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    `${options.appPath}/Contents/Info.plist`,
  ])
  add("app-version", appVersion.ok, appVersion.stdout || appVersion.stderr)

  const cliVersion = commandResult(options.realCli, ["--version"], { timeout: 5000 })
  add("cli-version", cliVersion.ok, cliVersion.stdout || cliVersion.stderr || cliVersion.error)

  const appAsar = `${options.appPath}/Contents/Resources/app.asar`
  try {
    add(
      "desktop-cli-override-hook",
      await fileContains(appAsar, "CODEX_CLI_PATH"),
      `${appAsar}: CODEX_CLI_PATH`
    )
  } catch (error) {
    add("desktop-cli-override-hook", false, `${appAsar}: ${error.message}`)
  }

  try {
    const deepLinkMarkers = ["prefillPrompt", "toggle-browser-panel", "open_in_browser_bridge"]
    const markerResults = await Promise.all(
      deepLinkMarkers.map((marker) => fileContains(appAsar, marker))
    )
    add(
      "desktop-deep-link-bootstrap",
      markerResults.every(Boolean),
      `${appAsar}: ${deepLinkMarkers.join(", ")}`
    )
  } catch (error) {
    add("desktop-deep-link-bootstrap", false, `${appAsar}: ${error.message}`)
  }

  const openHelp = commandResult("/usr/bin/open", ["--help"])
  const openHelpText = `${openHelp.stdout}\n${openHelp.stderr}`
  add("launchservices-env-support", openHelpText.includes("--env"), "open --env VAR=VALUE")
  add("launchservices-args-support", openHelpText.includes("--args"), "open --args ARG...")

  let appPids = []
  try {
    appPids = appProcessIds()
    add(
      "single-running-app",
      appPids.length === 1,
      appPids.length ? appPids.join(", ") : "not running"
    )
  } catch (error) {
    add("single-running-app", false, error.message)
  }

  add("relay-port-free", await portAvailable(options.port), `127.0.0.1:${options.port}`)
  if (options.cdpPort != null) {
    add("cdp-port-free", await portAvailable(options.cdpPort), `127.0.0.1:${options.cdpPort}`)
  }
  add("relaunch-job-free", !launchctlJobExists(relaunchLabel), relaunchLabel)
  add("rollback-job-free", !launchctlJobExists(rollbackLabel), rollbackLabel)

  for (const script of SCRIPT_NAMES) {
    const path = workerPath(script)
    const checked = commandResult(process.execPath, ["--check", path])
    add(`syntax:${script}`, checked.ok, checked.stderr || "ok")
  }

  const result = {
    ready: checks.every((check) => check.ok),
    mutatesApp: false,
    options,
    labels: { relaunchLabel, rollbackLabel },
    checks,
  }
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runPreflight()
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write("Codex relay PoC preflight (non-mutating)\n\n")
    for (const check of result.checks) {
      process.stdout.write(`${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.details}\n`)
    }
    process.stdout.write(`\n${result.ready ? "READY" : "NOT READY"}: no App process was changed.\n`)
  }
  if (!result.ready) process.exitCode = 1
}
