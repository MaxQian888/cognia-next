#!/usr/bin/env node

/**
 * Verifies the shim against the bundled real App Server without starting a
 * thread, model turn, plugin, Browser action, or desktop relaunch.
 */

import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"

import { DEFAULT_REAL_CLI, fetchRelay, readSecret, relayPaths, sleep, waitFor } from "./shared.mjs"

const stateDir = await mkdtemp(join(tmpdir(), "cognia-relay-real-protocol-"))
const port = 45000 + Math.floor(Math.random() * 1000)
const shim = new URL("./relay-shim.mjs", import.meta.url).pathname
const paths = relayPaths(stateDir)
const messages = []
let child

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

try {
  child = spawn(process.execPath, [shim, "app-server", "--listen", "stdio://"], {
    env: {
      ...process.env,
      CODEX_RELAY_REAL_CLI: DEFAULT_REAL_CLI,
      CODEX_RELAY_STATE_DIR: stateDir,
      CODEX_RELAY_PORT: String(port),
      CODEX_RELAY_WORKSPACE: process.cwd(),
    },
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stderr = ""
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-20_000)
  })
  createInterface({ input: child.stdout }).on("line", (line) => {
    messages.push(JSON.parse(line))
  })

  send({
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "cognia_relay_real_protocol_check", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    },
  })
  const initialized = await waitFor(() => messages.find((message) => message.id === 1), {
    timeoutMs: 15_000,
    intervalMs: 25,
    description: "real App Server initialize response",
  })
  if (initialized.error) throw new Error(JSON.stringify(initialized.error))
  send({ method: "initialized" })

  await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null)
      return response?.ok
    },
    { timeoutMs: 5000, description: "real App Server relay health" }
  )
  const token = await readSecret(paths.token)
  const listed = await fetchRelay("/api/request", {
    port,
    token,
    method: "POST",
    body: { method: "thread/list", params: { limit: 1 } },
    timeoutMs: 15_000,
  })
  if (!Array.isArray(listed.data)) {
    throw new Error(`Unexpected thread/list response: ${JSON.stringify(listed)}`)
  }
  if (messages.some((message) => String(message.id ?? "").startsWith("cognia:"))) {
    throw new Error("A Cognia string-ID response leaked to the desktop stream")
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        result: "PASS",
        mutatesApp: false,
        startedThread: false,
        startedTurn: false,
        userAgent: initialized.result?.userAgent ?? null,
        codexHome: initialized.result?.codexHome ?? null,
        cogniaStringRequestIdAccepted: true,
        cogniaResponseHiddenFromDesktop: true,
        threadListShapeAccepted: true,
        stderrTail: stderr.trim().slice(-1000),
      },
      null,
      2
    )}\n`
  )
} finally {
  child?.kill("SIGTERM")
  await sleep(200)
  await rm(stateDir, { recursive: true, force: true })
}
