#!/usr/bin/env node

/** Detached rollback worker. Never invoke directly; use rollback.mjs. */

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
const delaySeconds = delayIndex >= 0 ? Number(argv[delayIndex + 1]) : 10
const paths = relayPaths(options.stateDir)

async function record(status, details = {}) {
  await writeJsonAtomic(paths.rollbackResult, {
    status,
    at: new Date().toISOString(),
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
      description: "relayed Codex App graceful exit",
    })
  }
  const opened = commandResult("/usr/bin/open", ["--new", options.appPath])
  if (!opened.ok) throw new Error(opened.stderr || opened.error || "Unable to open normal App")
  await waitFor(() => appProcessIds().length === 1, {
    timeoutMs: 30_000,
    intervalMs: 250,
    description: "normal Codex App launch",
  })
  await record("rolled-back", { appPids: appProcessIds() })
} catch (error) {
  await record("rollback-failed", { error: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
}
