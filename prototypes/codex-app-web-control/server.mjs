/**
 * PROTOTYPE — disposable Web controller for the running Codex desktop App.
 *
 * This intentionally uses the bundled `codex app-server proxy` command so the
 * browser never sees the App's owner-only Unix socket. It is loopback-only and
 * has no production authentication or persistence.
 */
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline"

import { connectUnixWebSocket } from "./relay/unix-websocket.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.CODEX_DEMO_PORT ?? 4317)
const host = "127.0.0.1"
const workspace = process.env.CODEX_DEMO_CWD ?? process.env.INIT_CWD ?? process.cwd()
const codexBin = process.env.CODEX_APP_BIN ?? "/Applications/ChatGPT.app/Contents/Resources/codex"
const socketPath =
  process.env.CODEX_APP_SOCKET ??
  join(
    process.env.CODEX_HOME ?? join(process.env.HOME, ".codex"),
    "app-server-control",
    "app-server-control.sock"
  )
const requestedConnectionMode = process.env.CODEX_APP_CONNECTION ?? "auto"

function socketAcceptsConnections(path) {
  return new Promise((resolve) => {
    const socket = createConnection(path)
    const finish = (available) => {
      socket.destroy()
      resolve(available)
    }
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
    socket.setTimeout(1_000, () => finish(false))
  })
}

class AppServerBridge {
  child
  socket
  nextId = 0
  pending = new Map()
  serverRequests = new Map()
  listeners = new Set()
  events = []
  initialized = false
  serverInfo = null
  threadId = null
  turnId = null
  capabilities = null
  connectionMode = null
  approvalAuthority = null
  handedOff = false

  async connect() {
    if (this.child || this.socket) return
    if (this.handedOff) {
      throw new Error("Runtime was handed off to Codex App; restart the demo to reconnect")
    }
    const socketAvailable =
      requestedConnectionMode === "socket" ||
      (requestedConnectionMode === "auto" && (await socketAcceptsConnections(socketPath)))
    this.connectionMode = socketAvailable ? "live-app-socket" : "bundled-stdio-runtime"
    if (socketAvailable) {
      this.socket = await connectUnixWebSocket(socketPath)
      this.socket.onMessage((message) => this.ingest(message))
      this.socket.onClose((error) => this.transportClosed(error))
    } else {
      const args = [
        "-c",
        "features.code_mode_host=true",
        "app-server",
        "--listen",
        "stdio://",
        "--analytics-default-enabled",
      ]
      this.child = spawn(codexBin, args, {
        cwd: workspace,
        stdio: ["pipe", "pipe", "pipe"],
      })
      this.child.on("exit", (code, signal) => {
        this.publish("bridge/exit", { code, signal })
        this.transportClosed(new Error(`App Server exited (${code ?? signal ?? "unknown"})`))
      })
      createInterface({ input: this.child.stdout }).on("line", (line) => this.ingest(line))
      createInterface({ input: this.child.stderr }).on("line", (line) =>
        this.publish("bridge/stderr", { line })
      )
    }

    this.serverInfo = await this.request("initialize", {
      clientInfo: {
        name: "cognia-web-control-prototype",
        title: "Cognia Web Control Prototype",
        version: "0.0.1",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: true,
      },
    })
    this.notify("initialized")
    this.initialized = true
    this.publish("bridge/ready", {
      serverInfo: this.serverInfo,
      socketPath,
      connectionMode: this.connectionMode,
    })
    await this.refreshCapabilities()
  }

  write(message) {
    const serialized = JSON.stringify(message)
    if (this.socket) {
      this.socket.sendText(serialized)
      return
    }
    if (!this.child?.stdin.writable) throw new Error("App Server transport is not writable")
    this.child.stdin.write(`${serialized}\n`)
  }

  transportClosed(error) {
    this.child = undefined
    this.socket = undefined
    this.initialized = false
    for (const entry of this.pending.values()) {
      entry.reject(error ?? new Error("App Server transport closed"))
    }
    this.pending.clear()
  }

  request(method, params = {}, timeoutMs = 60_000) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (result) => {
          clearTimeout(timer)
          resolve(result)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.write({ id, method, params })
    })
  }

  notify(method, params) {
    this.write(params === undefined ? { method } : { method, params })
  }

  ingest(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.publish("bridge/non-json", { line })
      return
    }
    const hasId = message.id !== undefined && message.id !== null
    if (hasId && message.method) {
      this.serverRequests.set(String(message.id), message)
      this.publish("server/request", message)
      return
    }
    if (hasId) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${message.error.code}: ${message.error.message}`))
      else entry.resolve(message.result)
      return
    }
    if (message.method === "turn/started") this.turnId = message.params?.turn?.id ?? null
    if (message.method === "turn/completed") this.turnId = null
    this.publish(message.method ?? "server/message", message.params ?? message)
  }

  publish(method, params) {
    const event = {
      seq: this.events.length + 1,
      at: new Date().toISOString(),
      method,
      params: summarizeEvent(method, params),
    }
    this.events.push(event)
    if (this.events.length > 500) this.events.shift()
    for (const listener of this.listeners) listener(event)
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async optional(method, params = {}) {
    try {
      return { ok: true, data: await this.request(method, params) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async refreshCapabilities() {
    const [plugins, skills, mcp, apps, installedApps] = await Promise.all([
      this.optional("plugin/list", { cwds: [workspace], forceRefetch: false }),
      this.optional("skills/list", { cwds: [workspace], forceReload: true }),
      this.optional("mcpServerStatus/list", { detail: "toolsAndAuthOnly" }),
      this.optional("app/list", { limit: 100, forceRefetch: false }),
      this.optional("app/installed", { forceRefresh: false }),
    ])
    this.capabilities = { plugins, skills, mcp, apps, installedApps }
    this.publish("bridge/capabilities", this.capabilities)
    return this.capabilities
  }

  browserSkill() {
    const entries = this.capabilities?.skills?.data?.data ?? []
    return entries
      .flatMap((entry) => entry.skills ?? [])
      .find(
        (skill) =>
          skill.enabled &&
          (skill.name === "control-in-app-browser" ||
            skill.name.endsWith(":control-in-app-browser"))
      )
  }

  async startTurn(prompt, options = {}) {
    if (!this.initialized) await this.connect()
    if (!this.threadId || options.newThread) {
      const started = await this.request("thread/start", {
        cwd: workspace,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        developerInstructions:
          "This task was initiated from the Cognia Web control prototype. Use installed local plugins and MCP tools when the user explicitly requests them. Do not replace an explicitly requested Browser action with shell, curl, or web search.",
        threadSource: "cognia-web-control-prototype",
      })
      this.threadId = started?.thread?.id
      if (!this.threadId) throw new Error("thread/start returned no thread id")
      this.approvalAuthority = "web"
      this.publish("bridge/thread-selected", { threadId: this.threadId })
    }

    const input = [{ type: "text", text: prompt }]
    if (options.attachBrowserSkill) {
      const skill = this.browserSkill()
      if (!skill) throw new Error("Browser skill is not visible to this App Server client")
      input.unshift({ type: "skill", name: skill.name, path: skill.path })
    }
    const started = await this.request("turn/start", {
      threadId: this.threadId,
      input,
      cwd: workspace,
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [workspace],
        networkAccess: true,
      },
    })
    this.turnId = started?.turn?.id ?? null
    return { threadId: this.threadId, turnId: this.turnId }
  }

  async resumeThread(threadId, { approvalAuthority = "desktop" } = {}) {
    if (!["desktop", "web"].includes(approvalAuthority)) {
      throw new Error("approvalAuthority must be desktop or web")
    }
    if (!this.initialized) await this.connect()
    const resumed = await this.request("thread/resume", {
      threadId,
      sandbox: "workspace-write",
    })
    this.threadId = resumed?.thread?.id ?? threadId
    this.approvalAuthority = approvalAuthority
    this.publish("bridge/thread-selected", {
      threadId: this.threadId,
      resumed: true,
      approvalAuthority,
    })
    return { threadId: this.threadId, approvalAuthority }
  }

  async releaseThread() {
    if (!this.threadId || !this.initialized) return { released: false, threadId: null }
    const threadId = this.threadId
    await this.request("thread/unsubscribe", { threadId }, 5_000)
    this.threadId = null
    this.turnId = null
    this.approvalAuthority = null
    this.publish("bridge/thread-released", { threadId })
    return { released: true, threadId }
  }

  async handoffToApp() {
    const released = await this.releaseThread()
    this.handedOff = true
    this.initialized = false
    this.child?.kill()
    this.child = undefined
    this.socket?.close()
    this.socket = undefined
    this.publish("bridge/handed-off", released)
    return released
  }

  respond(id, result) {
    if (this.approvalAuthority !== "web") {
      throw new Error("Desktop owns approvals for this resumed task; Web is mirror-only")
    }
    const request = this.serverRequests.get(String(id))
    if (!request) throw new Error(`No pending server request ${id}`)
    this.serverRequests.delete(String(id))
    this.write({ id: request.id, result })
    this.publish("bridge/server-request-resolved", { id, method: request.method, result })
  }

  async interrupt() {
    if (!this.threadId || !this.turnId) throw new Error("No active turn")
    return this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId })
  }
}

const bridge = new AppServerBridge()

function boundedValue(value, depth = 0) {
  if (typeof value === "string") {
    return value.length > 4_000 ? `${value.slice(0, 4_000)}\n… [truncated]` : value
  }
  if (value === null || typeof value !== "object") return value
  if (depth >= 5) return "[max depth]"
  if (Array.isArray(value)) {
    const items = value.slice(0, 30).map((item) => boundedValue(item, depth + 1))
    if (value.length > 30) items.push(`… [${value.length - 30} more items]`)
    return items
  }
  const entries = Object.entries(value)
  const result = Object.fromEntries(
    entries.slice(0, 40).map(([key, item]) => [key, boundedValue(item, depth + 1)])
  )
  if (entries.length > 40) result._truncatedKeys = entries.length - 40
  return result
}

function summarizeEvent(method, params) {
  if (method === "app/list/updated") {
    return { count: params?.data?.length ?? 0 }
  }
  if (method === "bridge/capabilities") {
    const installedPlugins =
      params?.plugins?.data?.marketplaces
        ?.flatMap((marketplace) => marketplace.plugins ?? [])
        .filter((plugin) => plugin.installed)
        .map((plugin) => ({ name: plugin.name, enabled: plugin.enabled })) ?? []
    const mcpServers =
      params?.mcp?.data?.data?.map((server) => ({
        name: server.name,
        toolCount: Object.keys(server.tools ?? {}).length,
      })) ?? []
    return { installedPlugins, mcpServers }
  }
  return boundedValue(params)
}

function json(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  response.end(JSON.stringify(value))
}

async function body(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}
}

const browserVerificationCode = `LOCAL-BROWSER-${Math.random().toString(36).slice(2, 10).toUpperCase()}`

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? `${host}:${port}`}`)
  try {
    if (request.method === "GET" && url.pathname === "/") {
      const html = await readFile(join(here, "public", "index.html"), "utf8")
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(html)
      return
    }
    if (request.method === "GET" && url.pathname === "/browser-target") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(
        `<!doctype html><title>Codex Browser Use Target</title><main><h1>Browser Use verification</h1><p id="verification-code">${browserVerificationCode}</p><p>This value exists only in the rendered local page.</p></main>`
      )
      return
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })
      response.write(`event: snapshot\ndata: ${JSON.stringify(bridge.events)}\n\n`)
      const unsubscribe = bridge.subscribe((event) =>
        response.write(`event: codex\ndata: ${JSON.stringify(event)}\n\n`)
      )
      request.on("close", unsubscribe)
      return
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      if (!bridge.handedOff) await bridge.connect()
      json(response, 200, {
        connected: bridge.initialized,
        connectionMode: bridge.connectionMode,
        serverInfo: bridge.serverInfo,
        socketPath,
        workspace,
        threadId: bridge.threadId,
        turnId: bridge.turnId,
        approvalAuthority: bridge.approvalAuthority,
        pendingServerRequests: [...bridge.serverRequests.values()],
        capabilities: bridge.capabilities,
        browserSkill: bridge.browserSkill() ?? null,
        browserVerificationCode,
      })
      return
    }
    if (request.method === "POST" && url.pathname === "/api/refresh") {
      json(response, 200, await bridge.refreshCapabilities())
      return
    }
    if (request.method === "POST" && url.pathname === "/api/turn") {
      const input = await body(request)
      json(response, 202, await bridge.startTurn(String(input.prompt ?? ""), input))
      return
    }
    if (request.method === "POST" && url.pathname === "/api/resume") {
      const input = await body(request)
      json(
        response,
        200,
        await bridge.resumeThread(String(input.threadId ?? ""), {
          approvalAuthority: input.approvalAuthority === "web" ? "web" : "desktop",
        })
      )
      return
    }
    if (request.method === "POST" && url.pathname === "/api/handoff") {
      const released = await bridge.handoffToApp()
      if (released.threadId) {
        spawn("open", [`codex://threads/${released.threadId}`], {
          detached: true,
          stdio: "ignore",
        }).unref()
      }
      json(response, 200, released)
      return
    }
    if (request.method === "POST" && url.pathname === "/api/browser-smoke") {
      const target = `http://${host}:${port}/browser-target`
      const prompt = [
        "Use the installed Browser plugin and its in-app Browser only.",
        `Open ${target}, read the visible verification code, and reply exactly BROWSER_OK:<code>.`,
        "Do not use shell commands, curl, generic web search, or another browser implementation.",
      ].join(" ")
      json(
        response,
        202,
        await bridge.startTurn(prompt, { newThread: true, attachBrowserSkill: true })
      )
      return
    }
    if (request.method === "POST" && url.pathname === "/api/respond") {
      const input = await body(request)
      bridge.respond(input.id, input.result)
      json(response, 200, { ok: true })
      return
    }
    if (request.method === "POST" && url.pathname === "/api/interrupt") {
      json(response, 200, await bridge.interrupt())
      return
    }
    if (request.method === "POST" && url.pathname === "/api/open-in-app") {
      if (!bridge.threadId) throw new Error("No thread selected")
      spawn("open", [`codex://threads/${bridge.threadId}`], {
        detached: true,
        stdio: "ignore",
      }).unref()
      json(response, 200, { ok: true, threadId: bridge.threadId })
      return
    }
    json(response, 404, { error: "not_found" })
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) })
  }
})

await bridge.connect()

if (process.argv.includes("--probe")) {
  const plugins = bridge.capabilities?.plugins?.data?.marketplaces
    ?.flatMap((marketplace) => marketplace.plugins ?? [])
    .filter((plugin) => plugin.installed)
    .map((plugin) => ({ id: plugin.id, enabled: plugin.enabled, installed: plugin.installed }))
  const mcp = bridge.capabilities?.mcp?.data?.data?.map((server) => ({
    name: server.name,
    tools: Object.keys(server.tools ?? {}),
  }))
  console.log(
    JSON.stringify(
      {
        connectionMode: bridge.connectionMode,
        serverInfo: bridge.serverInfo,
        plugins,
        mcp,
        browserSkill: bridge.browserSkill(),
      },
      null,
      2
    )
  )
  bridge.child?.kill()
  bridge.socket?.close()
} else {
  server.listen(port, host, () => {
    console.log(`Codex App Web Control prototype: http://${host}:${port}`)
    console.log(`Workspace: ${workspace}`)
    console.log(`App socket: ${socketPath}`)
  })
}

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await bridge.releaseThread()
  } catch {
    // The App Server may already be gone; process shutdown still owns cleanup.
  }
  bridge.child?.kill()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1_000).unref()
}

process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
