#!/usr/bin/env node

import { commandResult, readJson, relayPaths, writeJsonAtomic } from "./shared.mjs"

const paths = relayPaths()
const armed = await readJson(paths.arm)
if (!armed?.label) throw new Error(`No armed relaunch was found at ${paths.arm}`)
if (armed.status !== "armed")
  throw new Error(`Relaunch is not cancellable; current status is ${armed.status}`)

const removed = commandResult("/bin/launchctl", ["remove", armed.label])
if (!removed.ok) {
  throw new Error(removed.stderr || removed.error || `Unable to remove ${armed.label}`)
}
await writeJsonAtomic(paths.arm, {
  ...armed,
  status: "cancelled",
  cancelledAt: new Date().toISOString(),
})
process.stdout.write(`Cancelled detached relay relaunch job ${armed.label}.\n`)
