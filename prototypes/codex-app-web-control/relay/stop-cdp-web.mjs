#!/usr/bin/env node

import { unlink } from "node:fs/promises"

import { cdpWebLabel } from "./cdp-web-service.mjs"
import {
  commandResult,
  defaultStateDir,
  launchctlDomain,
  launchctlJobExists,
  relayPaths,
  waitFor,
} from "./shared.mjs"

const argv = process.argv.slice(2)
const stateIndex = argv.indexOf("--state-dir")
const stateDir =
  stateIndex >= 0 ? argv[stateIndex + 1] : (process.env.CODEX_RELAY_STATE_DIR ?? defaultStateDir())
const label = cdpWebLabel()
const paths = relayPaths(stateDir)

if (launchctlJobExists(label)) {
  commandResult("/bin/launchctl", ["kill", "SIGTERM", `${launchctlDomain()}/${label}`])
  await waitFor(() => !launchctlJobExists(label), {
    timeoutMs: 10_000,
    intervalMs: 200,
    description: "Cognia Codex relay shutdown",
  }).catch(() => {})
  commandResult("/bin/launchctl", ["remove", label])
}
await unlink(paths.cdpWebDescriptor).catch(() => {})
process.stdout.write("Cognia Codex relay stopped. Codex App was left running.\n")
