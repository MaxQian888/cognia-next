#!/usr/bin/env node

/**
 * PROTOTYPE integration verifier. It never touches the real Codex App.
 * It drives the shim as a fake desktop client and uses fake-codex.mjs as the
 * only child App Server.
 */

import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"

import { isExpectedBrowserSmokeAnswer } from "./relay-state.mjs"
import { fetchRelay, readSecret, relayPaths, sleep, waitFor } from "./shared.mjs"

const stateDir = await mkdtemp(join(tmpdir(), "cognia-relay-simulator-"))
const port = 44000 + Math.floor(Math.random() * 1000)
const shim = new URL("./relay-shim.mjs", import.meta.url).pathname
const fakeCodex = new URL("./fake-codex.mjs", import.meta.url).pathname
const paths = relayPaths(stateDir)
const appMessages = []
let nextAppId = 0
let child

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sendApp(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

function appRequest(method, params = {}) {
  const id = ++nextAppId
  sendApp({ id, method, params })
  return id
}

async function waitForAppMessage(predicate, description) {
  return waitFor(() => appMessages.find(predicate), {
    timeoutMs: 5000,
    intervalMs: 25,
    description,
  })
}

try {
  assert(
    isExpectedBrowserSmokeAnswer("BROWSER_OK:EXACT", "EXACT"),
    "Exact Browser answer was rejected"
  )
  assert(
    !isExpectedBrowserSmokeAnswer(
      'User prompt contained "BROWSER_OK:EXACT" but Browser was unavailable',
      "EXACT"
    ),
    "Prompt echo produced a false Browser pass"
  )
  child = spawn(process.execPath, [shim, "-c", "features.code_mode_host=true", "app-server"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_RELAY_REAL_CLI: fakeCodex,
      CODEX_RELAY_STATE_DIR: stateDir,
      CODEX_RELAY_PORT: String(port),
      CODEX_RELAY_WORKSPACE: process.cwd(),
    },
    stdio: ["pipe", "pipe", "pipe"],
  })

  let _stderr = ""
  child.stderr.on("data", (chunk) => {
    _stderr += chunk
  })
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line)
    appMessages.push(message)
    if (message.method === "item/commandExecution/requestApproval") {
      sendApp({ id: message.id, result: { decision: "accept" } })
    }
  })

  const initializeId = appRequest("initialize", {
    clientInfo: { name: "simulated_codex_desktop", version: "0.0.0" },
    capabilities: { experimentalApi: true, requestAttestation: true },
  })
  await waitForAppMessage((message) => message.id === initializeId, "initialize response")
  const resumeId = appRequest("thread/resume", { threadId: "thread_simulated_desktop" })
  await waitForAppMessage((message) => message.id === resumeId, "thread/resume response")

  await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null)
      return response?.ok
    },
    { timeoutMs: 5000, description: "relay health endpoint" }
  )
  const token = await readSecret(paths.token)

  const preflight = await fetch(`http://127.0.0.1:${port}/api/state`, {
    method: "OPTIONS",
    headers: {
      origin: "http://127.0.0.1:3000",
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
  })
  assert(preflight.status === 204, "Cognia Web CORS preflight was rejected")
  assert(
    preflight.headers.get("access-control-allow-origin") === "http://127.0.0.1:3000",
    "Cognia Web origin was not returned by CORS preflight"
  )
  const rejectedOrigin = await fetch(`http://127.0.0.1:${port}/api/state`, {
    headers: { authorization: `Bearer ${token}`, origin: "https://remote.example" },
  })
  assert(rejectedOrigin.status === 403, "A non-allowlisted Web origin reached the relay")

  const cdpDisabled = await fetch(`http://127.0.0.1:${port}/api/bootstrap-task`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      prompt: "This must not launch anything",
      browserUrl: "https://example.com/",
    }),
  })
  assert(cdpDisabled.status === 500, "CDP bootstrap was accepted without explicit CDP enablement")

  const readResult = await fetchRelay("/api/request", {
    port,
    token,
    method: "POST",
    body: { method: "thread/read", params: { threadId: "thread_simulated_desktop" } },
  })
  assert(readResult.thread?.id === "thread_simulated_desktop", "Cognia response routing failed")
  assert(
    !appMessages.some((message) => String(message.id ?? "").startsWith("cognia:")),
    "Cognia response leaked into desktop stdout"
  )

  const smoke = await fetchRelay("/api/browser-smoke", {
    port,
    token,
    method: "POST",
    body: {},
  })
  assert(smoke.status === "running", "Browser smoke did not start")
  await waitForAppMessage(
    (message) => message.method === "item/commandExecution/requestApproval",
    "desktop-owned approval request"
  )

  const completedState = await waitFor(
    async () => {
      const current = await fetchRelay("/api/state", { port, token })
      return current.browserSmoke?.status === "passed" ? current : null
    },
    { timeoutMs: 5000, intervalMs: 50, description: "simulated Browser smoke" }
  )

  assert(
    completedState.events.some((event) => event.source === "server-request"),
    "Server request was not mirrored"
  )
  assert(
    completedState.events.some((event) => event.source === "cognia"),
    "Cognia request was not represented in relay state"
  )
  assert(completedState.activeThreadId === "thread_simulated_desktop", "Active task was lost")

  process.stdout.write(
    `${JSON.stringify(
      {
        result: "PASS",
        question:
          "Can one desktop connection carry App and Cognia requests without a second runtime?",
        stateDir,
        port,
        checks: {
          appInitializeForwarded: true,
          initializeResponseMarksRelayReady: true,
          activeTaskObserved: completedState.activeThreadId,
          cogniaResponseHiddenFromApp: true,
          approvalRoutedToDesktop: true,
          cogniaWebCorsPreflight: true,
          externalWebOriginRejected: true,
          cdpBootstrapDisabledByDefault: true,
          browserSmokeProjection: completedState.browserSmoke.status,
          eventSources: [...new Set(completedState.events.map((event) => event.source))],
        },
      },
      null,
      2
    )}\n`
  )
} finally {
  child?.kill("SIGTERM")
  await sleep(100)
  await rm(stateDir, { recursive: true, force: true })
}
