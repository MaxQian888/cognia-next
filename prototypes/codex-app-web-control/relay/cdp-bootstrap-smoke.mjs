#!/usr/bin/env node

/** Starts one App-originated Browser task through deep link + CDP. */

import { fetchRelay, parseCommonOptions, readSecret, relayPaths, waitFor } from "./shared.mjs"

const argv = process.argv.slice(2)
if (!argv.includes("--confirm-create-codex-task")) {
  throw new Error("Refusing to create a Codex App task. Re-run with --confirm-create-codex-task")
}

const options = parseCommonOptions(argv)
const paths = relayPaths(options.stateDir)
const token = await readSecret(paths.token)
const before = await fetchRelay("/api/state", { port: options.port, token })
if (!before.initialized) throw new Error("Relay is not initialized")
if (!before.cdp?.enabled) throw new Error("Relay was not launched with CDP enabled")

const started = await fetchRelay("/api/bootstrap-task", {
  port: options.port,
  token,
  method: "POST",
  body: { verifyBrowser: true },
  timeoutMs: 5000,
})
process.stdout.write(`App-owned bootstrap ${started.nonce} started.\n`)

const finished = await waitFor(
  async () => {
    const state = await fetchRelay("/api/state", { port: options.port, token })
    const record = state.bootstraps?.find((entry) => entry.nonce === started.nonce)
    return ["failed", "passed", "completed"].includes(record?.status) ? record : null
  },
  { timeoutMs: 240_000, intervalMs: 500, description: "App-owned Browser bootstrap" }
)

process.stdout.write(`${JSON.stringify(finished, null, 2)}\n`)
if (finished.status !== "passed") process.exitCode = 1
