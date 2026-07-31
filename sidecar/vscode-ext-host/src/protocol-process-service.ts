import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http"
import { connect as connectTcp } from "node:net"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomBytes } from "node:crypto"
import { monitorProcessResources } from "./process-resource-monitor"

const MAX_FRAME_BYTES = 16 * 1024 * 1024
const MAX_PENDING = 256
const REQUEST_TIMEOUT_MS = 30_000

export type ProcessProtocolFamily = "dap" | "mcp"

export interface ProtocolProcessStart {
  ownerId: string
  serverId: string
  family: ProcessProtocolFamily
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  allowedEnvironment?: string[]
  transport: "stdio" | "socket" | "http" | "sse"
  endpoint?: string
  startupTimeoutMs?: number
  memoryLimitMb?: number
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  requestId?: string
  correlation: string
}

interface TrackedProcess {
  input: ProtocolProcessStart
  child: ChildProcessWithoutNullStreams
  pending: Map<string, Pending>
  buffer: Buffer
  mcpRelay?: {
    server: HttpServer
    token: string
    endpoint: string
    subscribers: Set<ServerResponse>
  }
  disposeResourceMonitor?: () => void
}

export class ProtocolProcessService {
  private readonly processes = new Map<string, TrackedProcess>()

  constructor(
    private readonly notify: (method: string, params: unknown) => void,
    private readonly spawnProcess = spawn
  ) {}

  async start(input: ProtocolProcessStart): Promise<{
    state: "running"
    endpoint?: string
    headers?: Record<string, string>
  }> {
    validateStart(input)
    const key = processKey(input.ownerId, input.serverId)
    const existing = this.processes.get(key)
    if (existing) return this.connection(existing)
    const child = this.spawnProcess(input.command, [...(input.args ?? [])], {
      cwd: input.cwd,
      env: sanitizedEnvironment(input),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    })
    const tracked: TrackedProcess = {
      input,
      child,
      pending: new Map(),
      buffer: Buffer.alloc(0),
    }
    this.processes.set(key, tracked)
    if (child.pid) {
      tracked.disposeResourceMonitor = monitorProcessResources({
        pid: child.pid,
        memoryLimitMb: input.memoryLimitMb,
        onLimitExceeded: (error) => this.onExit(key, tracked, error),
      })
    }
    child.stdout.on("data", (chunk: Buffer) => this.onData(key, tracked, chunk))
    child.stderr.on("data", (chunk: Buffer) => {
      this.notify("protocol:log", {
        ownerId: input.ownerId,
        serverId: input.serverId,
        family: input.family,
        level: "warn",
        message: chunk.toString("utf8").slice(0, 8_192),
      })
    })
    child.once("error", (error) => this.onExit(key, tracked, error))
    child.once("exit", (code, signal) =>
      this.onExit(
        key,
        tracked,
        new Error(`IDE_PROTOCOL_PROCESS_EXITED: code=${String(code)} signal=${String(signal)}`)
      )
    )
    try {
      if (input.family === "mcp" && input.transport === "stdio") {
        tracked.mcpRelay = await this.createMcpRelay(tracked)
      } else if (input.transport !== "stdio") {
        await waitForEndpoint(input.endpoint!, input.startupTimeoutMs)
      }
    } catch (error) {
      this.processes.delete(key)
      await this.terminate(tracked, error instanceof Error ? error : new Error(String(error)))
      throw error
    }
    return this.connection(tracked)
  }

  async request(input: {
    ownerId: string
    serverId: string
    message: Record<string, unknown>
    requestId?: string
  }): Promise<unknown> {
    const tracked = this.require(input.ownerId, input.serverId)
    if (tracked.input.transport !== "stdio") {
      throw new Error("IDE_PROTOCOL_DIRECT_TRANSPORT")
    }
    if (tracked.pending.size >= MAX_PENDING) {
      throw new Error("IDE_PROTOCOL_PENDING_SATURATED")
    }
    const correlation = outboundCorrelation(tracked.input.family, input.message)
    if (!correlation) {
      this.write(tracked, input.message)
      return null
    }
    if (tracked.pending.has(correlation)) {
      throw new Error(`IDE_PROTOCOL_DUPLICATE_ID: ${correlation}`)
    }
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        tracked.pending.delete(correlation)
        reject(new Error(`IDE_PROTOCOL_REQUEST_TIMEOUT: ${correlation}`))
      }, REQUEST_TIMEOUT_MS)
      tracked.pending.set(correlation, {
        resolve,
        reject,
        timer,
        requestId: input.requestId,
        correlation,
      })
    })
    this.write(tracked, input.message)
    return promise
  }

  cancel(ownerId: string, serverId: string, requestId: string): boolean {
    const tracked = this.require(ownerId, serverId)
    const pending = [...tracked.pending.values()].find((entry) => entry.requestId === requestId)
    if (!pending) return false
    tracked.pending.delete(pending.correlation)
    clearTimeout(pending.timer)
    pending.reject(new Error(`IDE_PROTOCOL_REQUEST_CANCELLED: ${requestId}`))
    if (tracked.input.family === "dap") {
      this.write(tracked, {
        seq: Date.now(),
        type: "request",
        command: "cancel",
        arguments: { requestId: Number(pending.correlation) },
      })
    } else {
      this.write(tracked, {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: pending.correlation, reason: "client cancelled" },
      })
    }
    return true
  }

  async stop(ownerId: string, serverId: string): Promise<{ removed: boolean }> {
    const key = processKey(ownerId, serverId)
    const tracked = this.processes.get(key)
    if (!tracked) return { removed: false }
    this.processes.delete(key)
    await this.terminate(tracked, new Error("IDE_PROTOCOL_PROCESS_STOPPED"))
    return { removed: true }
  }

  async stopAll(): Promise<void> {
    for (const tracked of [...this.processes.values()]) {
      await this.stop(tracked.input.ownerId, tracked.input.serverId)
    }
  }

  status(): Array<{
    ownerId: string
    serverId: string
    family: ProcessProtocolFamily
    transport: ProtocolProcessStart["transport"]
  }> {
    return [...this.processes.values()].map(({ input }) => ({
      ownerId: input.ownerId,
      serverId: input.serverId,
      family: input.family,
      transport: input.transport,
    }))
  }

  private connection(tracked: TrackedProcess): {
    state: "running"
    endpoint?: string
    headers?: Record<string, string>
  } {
    if (tracked.mcpRelay) {
      return {
        state: "running",
        endpoint: tracked.mcpRelay.endpoint,
        headers: { Authorization: `Bearer ${tracked.mcpRelay.token}` },
      }
    }
    tracked.disposeResourceMonitor?.()
    tracked.disposeResourceMonitor = undefined
    return {
      state: "running",
      ...(tracked.input.endpoint ? { endpoint: tracked.input.endpoint } : {}),
    }
  }

  private write(tracked: TrackedProcess, message: Record<string, unknown>): void {
    const encoded = Buffer.from(JSON.stringify(message), "utf8")
    if (encoded.length > MAX_FRAME_BYTES) throw new Error("IDE_PROTOCOL_FRAME_TOO_LARGE")
    const frame =
      tracked.input.family === "dap"
        ? Buffer.concat([
            Buffer.from(`Content-Length: ${encoded.length}\r\n\r\n`, "ascii"),
            encoded,
          ])
        : Buffer.concat([encoded, Buffer.from("\n")])
    if (!tracked.child.stdin.write(frame)) {
      throw new Error("IDE_PROTOCOL_BACKPRESSURE")
    }
  }

  private onData(key: string, tracked: TrackedProcess, chunk: Buffer): void {
    if (this.processes.get(key) !== tracked) return
    tracked.buffer = Buffer.concat([tracked.buffer, chunk])
    if (tracked.buffer.length > MAX_FRAME_BYTES + 8_192) {
      void this.stop(tracked.input.ownerId, tracked.input.serverId)
      return
    }
    const messages =
      tracked.input.family === "dap" ? decodeContentLength(tracked) : decodeLines(tracked)
    for (const message of messages) this.onMessage(tracked, message)
  }

  private onMessage(tracked: TrackedProcess, message: Record<string, unknown>): void {
    const correlation = inboundCorrelation(tracked.input.family, message)
    const pending = correlation ? tracked.pending.get(correlation) : undefined
    if (pending) {
      tracked.pending.delete(correlation!)
      clearTimeout(pending.timer)
      pending.resolve(message)
      return
    }
    if (tracked.input.family === "mcp" && tracked.mcpRelay) {
      const event = `event: message\ndata: ${JSON.stringify(message)}\n\n`
      for (const subscriber of [...tracked.mcpRelay.subscribers]) {
        if (subscriber.destroyed) tracked.mcpRelay.subscribers.delete(subscriber)
        else subscriber.write(event)
      }
    }
    this.notify("protocol:message", {
      ownerId: tracked.input.ownerId,
      serverId: tracked.input.serverId,
      family: tracked.input.family,
      message,
    })
  }

  private onExit(key: string, tracked: TrackedProcess, error: Error): void {
    if (this.processes.get(key) !== tracked) return
    this.processes.delete(key)
    void this.terminate(tracked, error)
    this.notify("protocol:state", {
      ownerId: tracked.input.ownerId,
      serverId: tracked.input.serverId,
      family: tracked.input.family,
      state: "stopped",
      error: error.message,
    })
  }

  private async terminate(tracked: TrackedProcess, error: Error): Promise<void> {
    for (const pending of tracked.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    tracked.pending.clear()
    if (tracked.mcpRelay) {
      for (const subscriber of tracked.mcpRelay.subscribers) subscriber.end()
      tracked.mcpRelay.subscribers.clear()
      await new Promise<void>((resolve) => tracked.mcpRelay!.server.close(() => resolve()))
    }
    if (tracked.child.exitCode !== null || tracked.child.killed) return
    try {
      if (process.platform !== "win32" && tracked.child.pid) {
        process.kill(-tracked.child.pid, "SIGTERM")
      } else {
        tracked.child.kill("SIGTERM")
      }
    } catch {
      tracked.child.kill("SIGKILL")
    }
    setTimeout(() => {
      if (tracked.child.exitCode !== null) return
      try {
        if (process.platform !== "win32" && tracked.child.pid) {
          process.kill(-tracked.child.pid, "SIGKILL")
        } else {
          tracked.child.kill("SIGKILL")
        }
      } catch {
        // The process exited between the state check and signal.
      }
    }, 2_000).unref()
  }

  private require(ownerId: string, serverId: string): TrackedProcess {
    const tracked = this.processes.get(processKey(ownerId, serverId))
    if (!tracked) throw new Error(`IDE_PROTOCOL_SESSION_NOT_RUNNING: ${serverId}`)
    return tracked
  }

  private async createMcpRelay(tracked: TrackedProcess): Promise<TrackedProcess["mcpRelay"]> {
    const token = randomBytes(32).toString("hex")
    const subscribers = new Set<ServerResponse>()
    const server = createHttpServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${token}` || request.url !== "/mcp") {
        response.writeHead(request.headers.authorization ? 404 : 401).end()
        return
      }
      if (request.method === "GET") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "mcp-session-id": token,
        })
        response.write(": connected\n\n")
        subscribers.add(response)
        request.once("close", () => subscribers.delete(response))
        return
      }
      if (request.method === "DELETE") {
        response.writeHead(204).end()
        return
      }
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "GET, POST, DELETE" }).end()
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      request.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_FRAME_BYTES) request.destroy()
        else chunks.push(chunk)
      })
      request.on("end", () => {
        void (async () => {
          try {
            const message = JSON.parse(Buffer.concat(chunks).toString("utf8"))
            const result = await this.request({
              ownerId: tracked.input.ownerId,
              serverId: tracked.input.serverId,
              message,
            })
            if (result === null) {
              response.writeHead(202).end()
            } else {
              response
                .writeHead(200, {
                  "content-type": "application/json",
                  "mcp-session-id": token,
                })
                .end(JSON.stringify(result))
            }
          } catch (error) {
            response.writeHead(502, { "content-type": "application/json" }).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: null,
                error: {
                  code: -32603,
                  message: error instanceof Error ? error.message : String(error),
                },
              })
            )
          }
        })()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === "string") {
      server.close()
      throw new Error("IDE_MCP_RELAY_BIND_FAILED")
    }
    return {
      server,
      token,
      endpoint: `http://127.0.0.1:${address.port}/mcp`,
      subscribers,
    }
  }
}

function validateStart(input: ProtocolProcessStart): void {
  if (!["dap", "mcp"].includes(input.family)) throw new Error("IDE_PROTOCOL_FAMILY_INVALID")
  if (!input.command.startsWith("/")) throw new Error("IDE_PROTOCOL_COMMAND_NOT_ABSOLUTE")
  if (!["stdio", "socket", "http", "sse"].includes(input.transport)) {
    throw new Error("IDE_PROTOCOL_TRANSPORT_UNSUPPORTED")
  }
  if (input.transport !== "stdio") {
    const endpoint = new URL(input.endpoint ?? "")
    if (!["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname)) {
      throw new Error("IDE_PROTOCOL_ENDPOINT_NOT_LOOPBACK")
    }
  }
  for (const name of input.allowedEnvironment ?? []) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "NODE_OPTIONS"].includes(name)
    ) {
      throw new Error(`IDE_PROTOCOL_ENVIRONMENT_DENIED: ${name}`)
    }
  }
  if (
    input.memoryLimitMb !== undefined &&
    (!Number.isInteger(input.memoryLimitMb) ||
      input.memoryLimitMb < 16 ||
      input.memoryLimitMb > 32_768)
  ) {
    throw new Error("IDE_PROTOCOL_MEMORY_LIMIT_INVALID")
  }
  if (
    input.startupTimeoutMs !== undefined &&
    (!Number.isInteger(input.startupTimeoutMs) ||
      input.startupTimeoutMs < 1 ||
      input.startupTimeoutMs > 120_000)
  ) {
    throw new Error("IDE_PROTOCOL_STARTUP_TIMEOUT_INVALID")
  }
}

function sanitizedEnvironment(input: ProtocolProcessStart): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" }
  for (const name of input.allowedEnvironment ?? []) {
    const value = process.env[name]
    if (value !== undefined) environment[name] = value
  }
  for (const [name, value] of Object.entries(input.env ?? {})) {
    if ((input.allowedEnvironment ?? []).includes(name)) environment[name] = value
  }
  return environment
}

function processKey(ownerId: string, serverId: string): string {
  return `${ownerId}\0${serverId}`
}

function outboundCorrelation(
  family: ProcessProtocolFamily,
  message: Record<string, unknown>
): string | null {
  const value = family === "dap" ? message.seq : message.id
  return typeof value === "string" || typeof value === "number" ? String(value) : null
}

function inboundCorrelation(
  family: ProcessProtocolFamily,
  message: Record<string, unknown>
): string | null {
  const value = family === "dap" ? message.request_seq : message.id
  return typeof value === "string" || typeof value === "number" ? String(value) : null
}

function decodeLines(tracked: TrackedProcess): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []
  while (true) {
    const index = tracked.buffer.indexOf(0x0a)
    if (index < 0) break
    const line = tracked.buffer.subarray(0, index).toString("utf8").trim()
    tracked.buffer = tracked.buffer.subarray(index + 1)
    if (line) messages.push(JSON.parse(line))
  }
  return messages
}

function decodeContentLength(tracked: TrackedProcess): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []
  while (true) {
    const headerEnd = tracked.buffer.indexOf("\r\n\r\n")
    if (headerEnd < 0) break
    const header = tracked.buffer.subarray(0, headerEnd).toString("ascii")
    const match = /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i.exec(header)
    if (!match) throw new Error("IDE_PROTOCOL_FRAME_MALFORMED")
    const length = Number(match[1])
    if (!Number.isSafeInteger(length) || length > MAX_FRAME_BYTES) {
      throw new Error("IDE_PROTOCOL_FRAME_TOO_LARGE")
    }
    const total = headerEnd + 4 + length
    if (tracked.buffer.length < total) break
    messages.push(
      JSON.parse(tracked.buffer.subarray(headerEnd + 4, total).toString("utf8")) as Record<
        string,
        unknown
      >
    )
    tracked.buffer = tracked.buffer.subarray(total)
  }
  return messages
}

async function waitForEndpoint(endpoint: string, timeoutMs = 10_000): Promise<void> {
  const url = new URL(endpoint)
  const port = Number(url.port)
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = connectTcp({ host: url.hostname, port })
      socket.once("connect", () => {
        socket.destroy()
        resolve(true)
      })
      socket.once("error", () => resolve(false))
    })
    if (ready) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`IDE_PROTOCOL_ENDPOINT_TIMEOUT: ${endpoint}`)
}
