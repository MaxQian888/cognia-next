#!/usr/bin/env node

/**
 * PROTOTYPE — transparent single-connection relay for the Codex desktop App.
 *
 * Question: can Cognia inject and observe requests through the desktop App's
 * existing stdio App Server connection without creating a second runtime or a
 * second App Server client?
 */

import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { appendFile, readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { createInterface } from "node:readline"

import { createBootstrapTracker } from "./bootstrap-state.mjs"
import { bootstrapCodexTask } from "./cdp-bootstrap.mjs"
import { buildAppServerEnvironment } from "./launch-config.mjs"
import {
  appendRelayEvent,
  createCogniaRequestId,
  createRelayState,
  isExpectedBrowserSmokeAnswer,
  observeAppMessage,
  publicRelayState,
  routeServerMessage,
} from "./relay-state.mjs"
import {
  DEFAULT_PORT,
  DEFAULT_REAL_CLI,
  corsHeadersForOrigin,
  ensurePrivateDirectory,
  relayPaths,
  writeJsonAtomic,
  writeSecret,
} from "./shared.mjs"

const APP_SERVER_SUBCOMMANDS = new Set([
  "daemon",
  "proxy",
  "generate-ts",
  "generate-json-schema",
  "generate-zod",
])
const WEB_METHOD_ALLOWLIST = new Set([
  "thread/list",
  "thread/read",
  "thread/turns/list",
  "thread/items/list",
  "thread/resume",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "thread/unsubscribe",
])

function shouldRelayAppServer(args) {
  const index = args.indexOf("app-server")
  if (index < 0) return false
  const next = args[index + 1]
  return next == null || next.startsWith("-") || !APP_SERVER_SUBCOMMANDS.has(next)
}

function passthrough(realCli, args) {
  const child = spawn(realCli, args, { stdio: "inherit", env: process.env })
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => child.kill(signal))
  }
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 1)
  })
}

function parsePort(value) {
  const port = Number(value ?? DEFAULT_PORT)
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid CODEX_RELAY_PORT: ${String(value)}`)
  }
  return port
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function json(response, status, value, extraHeaders = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  })
  response.end(JSON.stringify(value))
}

async function readBody(request, limit = 256 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error("Request body is too large")
    chunks.push(chunk)
  }
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

function findBrowserSkill(value, seen = new WeakSet()) {
  if (value == null || typeof value !== "object") return null
  if (seen.has(value)) return null
  seen.add(value)
  if (
    typeof value.name === "string" &&
    typeof value.path === "string" &&
    (value.name === "control-in-app-browser" || value.name.endsWith(":control-in-app-browser")) &&
    value.enabled !== false
  ) {
    return { name: value.name, path: value.path }
  }
  for (const entry of Array.isArray(value) ? value : Object.values(value)) {
    const match = findBrowserSkill(entry, seen)
    if (match) return match
  }
  return null
}

const args = process.argv.slice(2)
const realCli = resolve(process.env.CODEX_RELAY_REAL_CLI ?? DEFAULT_REAL_CLI)
if (!shouldRelayAppServer(args)) {
  passthrough(realCli, args)
} else {
  await runRelay(realCli, args)
}

async function runRelay(realCliPath, cliArgs) {
  const port = parsePort(process.env.CODEX_RELAY_PORT)
  const cdpPort = process.env.CODEX_RELAY_CDP_PORT
    ? parsePort(process.env.CODEX_RELAY_CDP_PORT)
    : null
  const paths = relayPaths()
  const workspace = resolve(process.env.CODEX_RELAY_WORKSPACE ?? process.cwd())
  const token = randomBytes(32).toString("base64url")
  const state = createRelayState()
  const pendingCogniaRequests = new Map()
  const sseClients = new Set()
  let browserSmoke = null
  let stateWrite = Promise.resolve()
  const bootstrapTracker = createBootstrapTracker({
    onChange(record) {
      const event = appendRelayEvent(state, "bootstrap", {
        method: "bootstrap/updated",
        params: record,
      })
      broadcast(event)
      persistState()
    },
  })

  await ensurePrivateDirectory(paths.root)
  await writeSecret(paths.token, token)

  const log = (level, message, details = {}) => {
    const entry = `${JSON.stringify({ at: new Date().toISOString(), level, message, ...details })}\n`
    appendFile(paths.log, entry, { mode: 0o600 }).catch(() => {})
  }

  const child = spawn(realCliPath, cliArgs, {
    cwd: process.cwd(),
    env: buildAppServerEnvironment(process.env),
    stdio: ["pipe", "pipe", "pipe"],
  })

  function publicState() {
    return publicRelayState(state, {
      shimPid: process.pid,
      appPid: process.ppid,
      appServerPid: child.pid ?? null,
      port,
      workspace,
      browserSmoke,
      cdp: {
        enabled: cdpPort != null,
        port: cdpPort,
      },
      bootstraps: bootstrapTracker.list(),
      latestBootstrap: bootstrapTracker.latest(),
      realCli: realCliPath,
      startedAt: startedAt.toISOString(),
    })
  }

  function persistState() {
    const snapshot = publicState()
    stateWrite = stateWrite
      .catch(() => {})
      .then(() => writeJsonAtomic(paths.state, snapshot))
      .catch((error) => log("warning", "state_write_failed", { error: error.message }))
  }

  function broadcast(event) {
    if (!event) return
    const line = `event: relay\ndata: ${JSON.stringify(event)}\n\n`
    for (const response of sseClients) response.write(line)
  }

  function writeToServer(message) {
    if (!child.stdin.writable) throw new Error("App Server stdin is not writable")
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  function injectRequest(method, params = {}, timeoutMs = 60_000) {
    if (!state.initialized) throw new Error("Desktop App has not completed initialization")
    const id = createCogniaRequestId()
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pendingCogniaRequests.delete(id)
        rejectRequest(new Error(`Timed out waiting for ${method}`))
      }, timeoutMs)
      pendingCogniaRequests.set(id, {
        method,
        resolve: (result) => {
          clearTimeout(timer)
          resolveRequest(result)
        },
        reject: (error) => {
          clearTimeout(timer)
          rejectRequest(error)
        },
      })
      const message = { id, method, params }
      const event = appendRelayEvent(state, "cognia", message)
      broadcast(event)
      persistState()
      writeToServer(message)
    })
  }

  async function startTurn(prompt) {
    if (!state.activeThreadId) throw new Error("No active desktop task; open a task in Codex App")
    return injectRequest("turn/start", {
      threadId: state.activeThreadId,
      input: [{ type: "text", text: prompt }],
    })
  }

  async function startBrowserSmoke() {
    if (!state.activeThreadId) throw new Error("No active desktop task; open a task in Codex App")
    if (state.activeTurnId) throw new Error("The active desktop task already has a running turn")
    const cwd = state.activeThreadCwd ?? workspace
    const skills = await injectRequest("skills/list", { cwds: [cwd], forceReload: true })
    const browserSkill = findBrowserSkill(skills)
    if (!browserSkill) throw new Error("The App-owned runtime did not return the Browser skill")

    const code = `COGNIA-BROWSER-${randomBytes(6).toString("hex").toUpperCase()}`
    const targetUrl = `http://127.0.0.1:${port}/browser-target?code=${encodeURIComponent(code)}`
    const prompt = [
      "Use the attached Browser skill and the Codex in-app Browser only.",
      `Open ${targetUrl}, read the visible verification code, and reply exactly BROWSER_OK:${code}.`,
      "Do not use shell commands, curl, web search, Computer Use, or an external browser.",
    ].join(" ")
    const result = await injectRequest("turn/start", {
      threadId: state.activeThreadId,
      input: [
        { type: "skill", name: browserSkill.name, path: browserSkill.path },
        { type: "text", text: prompt },
      ],
    })
    browserSmoke = {
      status: "running",
      code,
      targetUrl,
      threadId: state.activeThreadId,
      turnId: result?.turn?.id ?? null,
      browserSkill,
      output: "",
      finalAnswer: null,
      toolErrors: [],
      startedAt: new Date().toISOString(),
      completedAt: null,
    }
    persistState()
    return browserSmoke
  }

  function observeBrowserSmoke(message) {
    if (!browserSmoke || browserSmoke.status !== "running") return
    const params = message?.params ?? {}
    const sameThread = !params.threadId || params.threadId === browserSmoke.threadId
    const sameTurn = !params.turnId || !browserSmoke.turnId || params.turnId === browserSmoke.turnId
    if (!sameThread || !sameTurn) return

    if (message.method === "item/agentMessage/delta") {
      browserSmoke.output = `${browserSmoke.output}${params.delta ?? ""}`.slice(-20_000)
    } else if (message.method === "item/completed") {
      const item = params.item ?? {}
      if (item.type === "agentMessage" && item.phase === "final_answer") {
        browserSmoke.finalAnswer = typeof item.text === "string" ? item.text : ""
      } else if (item.type === "mcpToolCall" && item.status === "failed") {
        const resultText = Array.isArray(item.result?.content)
          ? item.result.content
              .filter((entry) => entry?.type === "text")
              .map((entry) => entry.text)
              .join("\n")
          : ""
        browserSmoke.toolErrors = [
          ...browserSmoke.toolErrors,
          {
            server: item.server ?? null,
            tool: item.tool ?? null,
            message: String(item.error ?? resultText ?? "Tool call failed").slice(0, 4000),
          },
        ].slice(-10)
      }
    } else if (message.method === "turn/completed") {
      browserSmoke.completedAt = new Date().toISOString()
      browserSmoke.status = isExpectedBrowserSmokeAnswer(
        browserSmoke.finalAnswer,
        browserSmoke.code
      )
        ? "passed"
        : "failed"
    }
  }

  const startedAt = new Date()
  log("info", "relay_starting", {
    realCli: realCliPath,
    args: cliArgs,
    port,
    workspace,
    appPid: process.ppid,
    shimPid: process.pid,
    appServerPid: child.pid,
  })

  const appInput = createInterface({ input: process.stdin })
  appInput.on("line", (line) => {
    const message = parseJsonLine(line)
    if (message) {
      observeAppMessage(state, message)
      bootstrapTracker.observeApp(message)
      persistState()
    }
    child.stdin.write(`${line}\n`)
  })
  appInput.once("close", () => child.stdin.end())
  child.stdin.on("error", (error) => {
    log("warning", "app_server_stdin_error", { error: error.message })
  })

  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = parseJsonLine(line)
    if (!message) {
      process.stdout.write(`${line}\n`)
      return
    }

    observeBrowserSmoke(message)
    bootstrapTracker.observeServer(message)
    const route = routeServerMessage(state, message)
    if (route.cogniaResponseId) {
      const pending = pendingCogniaRequests.get(route.cogniaResponseId)
      pendingCogniaRequests.delete(route.cogniaResponseId)
      if (pending) {
        if (message.error)
          pending.reject(new Error(`${message.error.code}: ${message.error.message}`))
        else pending.resolve(message.result)
      }
    }
    if (route.forwardToApp) process.stdout.write(`${line}\n`)
    broadcast(route.event)
    persistState()
  })

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk)
    appendFile(paths.log, chunk, { mode: 0o600 }).catch(() => {})
  })

  const operatorHtml = await readFile(new URL("./operator.html", import.meta.url), "utf8")
  const allowedOrigins = new Set(
    (
      process.env.CODEX_RELAY_ALLOWED_ORIGINS ??
      `http://127.0.0.1:${port},http://localhost:${port},http://127.0.0.1:3000,http://localhost:3000`
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  )

  function authenticated(request, url) {
    const authorization = request.headers.authorization
    const queryToken = url.searchParams.get("token")
    return authorization === `Bearer ${token}` || queryToken === token
  }

  function originAllowed(request) {
    const origin = request.headers.origin
    return origin == null || allowedOrigins.has(origin)
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`)
    const corsHeaders = corsHeadersForOrigin(allowedOrigins, request.headers.origin)
    const respondJson = (status, value, extraHeaders = {}) =>
      json(response, status, value, { ...corsHeaders, ...extraHeaders })
    try {
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        })
        response.end(operatorHtml)
        return
      }
      if (request.method === "GET" && url.pathname === "/healthz") {
        json(response, state.initialized ? 200 : 503, {
          status: state.initialized ? "ready" : "starting",
          phase: state.phase,
          activeThreadId: state.activeThreadId,
          shimPid: process.pid,
          appServerPid: child.pid ?? null,
        })
        return
      }
      if (request.method === "GET" && url.pathname === "/browser-target") {
        const code = url.searchParams.get("code") ?? "MISSING_CODE"
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        })
        response.end(
          `<!doctype html><title>Cognia Browser relay verification</title><main><h1>Browser relay verification</h1><p id="verification-code">${code.replace(/[<>&]/g, "")}</p></main>`
        )
        return
      }
      if (!url.pathname.startsWith("/api/")) {
        respondJson(404, { error: "not_found" })
        return
      }
      if (!originAllowed(request)) {
        respondJson(403, { error: "origin_not_allowed" })
        return
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, corsHeaders)
        response.end()
        return
      }
      if (!authenticated(request, url)) {
        respondJson(401, { error: "unauthorized" })
        return
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        respondJson(200, publicState())
        return
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
          ...corsHeaders,
        })
        response.write(`event: snapshot\ndata: ${JSON.stringify(state.events)}\n\n`)
        sseClients.add(response)
        request.once("close", () => sseClients.delete(response))
        return
      }
      if (request.method === "POST" && url.pathname === "/api/request") {
        const input = await readBody(request)
        const method = String(input.method ?? "")
        if (!WEB_METHOD_ALLOWLIST.has(method)) {
          respondJson(403, { error: `method_not_allowed:${method}` })
          return
        }
        respondJson(200, await injectRequest(method, input.params ?? {}))
        return
      }
      if (request.method === "POST" && url.pathname === "/api/turn") {
        const input = await readBody(request)
        const prompt = String(input.prompt ?? "").trim()
        if (!prompt) throw new Error("Prompt must not be empty")
        respondJson(202, await startTurn(prompt))
        return
      }
      if (request.method === "POST" && url.pathname === "/api/browser-smoke") {
        respondJson(202, await startBrowserSmoke())
        return
      }
      if (request.method === "POST" && url.pathname === "/api/bootstrap-task") {
        if (cdpPort == null) throw new Error("Relay was not launched with CDP enabled")
        const input = await readBody(request)
        const verifyBrowser = input.verifyBrowser === true
        const nonce = `cognia-${randomBytes(12).toString("hex")}`
        const verificationCode = verifyBrowser
          ? `COGNIA-BROWSER-${randomBytes(6).toString("hex").toUpperCase()}`
          : null
        const browserUrl = verifyBrowser
          ? `http://127.0.0.1:${port}/browser-target?code=${encodeURIComponent(verificationCode)}`
          : String(input.browserUrl ?? "").trim()
        const prompt = verifyBrowser
          ? [
              "Use the Browser sidebar that Codex App opened for this task.",
              "Read the verification code visible on the page and reply with exactly BROWSER_OK:<code>.",
              "Do not use shell commands, curl, web search, Computer Use, or an external browser.",
            ].join(" ")
          : String(input.prompt ?? "").trim()
        if (!prompt) throw new Error("Prompt must not be empty")
        if (!browserUrl) throw new Error("browserUrl must not be empty")
        const record = bootstrapTracker.begin({
          nonce,
          expectedAnswer: verificationCode ? `BROWSER_OK:${verificationCode}` : null,
          browserUrl,
        })
        bootstrapCodexTask({ prompt, browserUrl, workspace, nonce }, { cdpPort })
          .then((result) => bootstrapTracker.markUiSubmitted(nonce, result))
          .catch((error) => bootstrapTracker.fail(nonce, error))
        respondJson(202, record)
        return
      }
      respondJson(404, { error: "not_found" })
    } catch (error) {
      respondJson(500, { error: error instanceof Error ? error.message : String(error) })
    }
  })

  server.on("error", (error) => {
    log("error", "broker_listen_failed", { error: error.message })
    state.phase = "broker-error"
    persistState()
  })
  server.listen(port, "127.0.0.1", () => {
    log("info", "broker_listening", { port })
    persistState()
  })

  child.once("exit", async (code, signal) => {
    state.phase = "exited"
    state.appConnected = false
    for (const pending of pendingCogniaRequests.values()) {
      pending.reject(new Error("App Server exited"))
    }
    pendingCogniaRequests.clear()
    persistState()
    log("info", "app_server_exited", { code, signal })
    server.close()
    await stateWrite.catch(() => {})
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 1)
  })

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => child.kill(signal))
  }
}
