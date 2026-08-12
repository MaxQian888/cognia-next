#!/usr/bin/env node

/** Starts one Browser turn only after an explicit confirmation flag. */

import { fetchRelay, parseCommonOptions, readSecret, relayPaths, waitFor } from "./shared.mjs"

const argv = process.argv.slice(2)
if (!argv.includes("--confirm-run-browser-smoke")) {
  throw new Error(
    "Refusing to start a Codex turn. Re-run with the exact flag --confirm-run-browser-smoke"
  )
}

const options = parseCommonOptions(argv)
const paths = relayPaths(options.stateDir)
const token = await readSecret(paths.token)
const before = await fetchRelay("/api/state", { port: options.port, token })
if (!before.initialized) throw new Error("Relay is not initialized")
if (!before.activeThreadId)
  throw new Error("Open the target task in Codex App before running smoke")
if (before.activeTurnId) throw new Error(`Task ${before.activeThreadId} already has an active turn`)

const started = await fetchRelay("/api/browser-smoke", {
  port: options.port,
  token,
  method: "POST",
  body: {},
  timeoutMs: 30_000,
})
process.stdout.write(`Browser smoke started on ${started.threadId}, turn ${started.turnId}.\n`)

const finished = await waitFor(
  async () => {
    const state = await fetchRelay("/api/state", { port: options.port, token })
    return ["passed", "failed"].includes(state.browserSmoke?.status) ? state.browserSmoke : null
  },
  { timeoutMs: 180_000, intervalMs: 500, description: "Browser smoke completion" }
)

process.stdout.write(`${JSON.stringify(finished, null, 2)}\n`)
if (finished.status !== "passed") process.exitCode = 1
