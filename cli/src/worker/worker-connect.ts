import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { PassThrough, Writable } from "node:stream"

import type { AgentWorkerManifestV1, HandoffEnvelope } from "@cognia/agent"
import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import { issueSocketTicket, registerCompanionWorker } from "@/lib/tauri/companion-auth"

import type { ResolvedConfig } from "../config/schema"
import { createAgentRpcServer } from "../agent/rpc/server"
import { createAgentRuntimeService } from "../agent/rpc/runtime-service"
import { selectBackend } from "../agent/runtime/backend-select"
import type { WorkerWorkspaceClient } from "./workspace-client"

const MAX_BUFFERED_SOCKET_BYTES = 32 * 1024 * 1024

export interface WorkerWebSocket {
  readonly bufferedAmount?: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown; error?: unknown }) => void
  ): void
}

export interface WorkerConnectOptions {
  deviceConfigPath: string
  runtimeConfig: ResolvedConfig
  home: string
  workspace: WorkerWorkspaceClient
  maxActiveTurns?: number
  signal?: AbortSignal
  readFile?: (path: string) => string
  stat?: (path: string) => { mode: number }
  issueTicket?: typeof issueSocketTicket
  wsFactory?: (url: string) => WorkerWebSocket
  createService?: typeof createAgentRuntimeService
  createServer?: typeof createAgentRpcServer
  diagnostic?: Writable
}

export interface WorkerEnrollmentOptions {
  baseUrl: string
  tenantId: string
  enrollment: string
  displayName: string
  deviceConfigPath: string
  serverFingerprint?: string
  register?: typeof registerCompanionWorker
}

export async function enrollWorker(options: WorkerEnrollmentOptions): Promise<CompanionConfig> {
  const config = await (options.register ?? registerCompanionWorker)({
    baseUrl: options.baseUrl,
    tenantId: options.tenantId,
    enrollment: options.enrollment,
    displayName: options.displayName,
    serverFingerprint: options.serverFingerprint,
  })
  fs.mkdirSync(path.dirname(options.deviceConfigPath), {
    recursive: true,
    mode: 0o700,
  })
  fs.writeFileSync(options.deviceConfigPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  })
  return config
}

export async function connectWorker(options: WorkerConnectOptions): Promise<void> {
  const identity = loadWorkerDeviceConfig(options.deviceConfigPath, options)
  const bindings = await options.workspace.list()
  const manifest = buildWorkerManifest(
    options.runtimeConfig,
    bindings.map((binding) => binding.bindingRef),
    options.maxActiveTurns
  )
  const ticket = await (options.issueTicket ?? issueSocketTicket)(identity, "worker")
  const socket = (options.wsFactory ?? defaultWebSocketFactory)(
    workerSocketUrl(identity.baseUrl, ticket.ticket)
  )
  await waitForOpen(socket, options.signal)
  socket.send(JSON.stringify({ type: "worker_hello", v: 1, manifest }))

  const input = new PassThrough()
  const output = new WorkerSocketWritable(socket)
  const closeInput = () => input.end()
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string" || event.data.includes("\n") || event.data.includes("\r")) {
      socket.close(1002, "invalid Agent RPC frame")
      return
    }
    input.write(`${event.data}\n`)
  })
  socket.addEventListener("close", closeInput)
  socket.addEventListener("error", closeInput)
  options.signal?.addEventListener(
    "abort",
    () => {
      socket.close(1000, "worker stopping")
      closeInput()
    },
    { once: true }
  )

  const credentialRefs = new Set(manifest.credentialProfileRefs)
  const workspaceRefs = new Set(manifest.workspaceBindingRefs)
  const service = (options.createService ?? createAgentRuntimeService)({
    config: options.runtimeConfig,
    home: options.home,
    workerDispatch: {
      manifest,
      async resolveHandoffWorkspace(handoff, commandId) {
        const credentialRef = handoff.execution.credentialProfileRef
        if (credentialRef && !credentialRefs.has(credentialRef)) {
          throw new Error(`credential profile is unavailable on this worker: ${credentialRef}`)
        }
        const repositoryRef = handoff.resources?.find(
          (resource) => resource.kind === "repository"
        )?.ref
        if (!repositoryRef || !workspaceRefs.has(repositoryRef)) {
          throw new Error(
            `workspace binding is unavailable on this worker: ${repositoryRef ?? "missing repository ref"}`
          )
        }
        const run = await options.workspace.begin(
          repositoryRef,
          beginRequestFromHandoff(handoff, commandId)
        )
        if (typeof run.executionRoot !== "string" || run.executionRoot.length === 0) {
          throw new Error("Task Workspace helper did not return an execution root")
        }
        return run.executionRoot
      },
    },
  })
  const server = (options.createServer ?? createAgentRpcServer)({
    input,
    output,
    diagnostic: options.diagnostic ?? process.stderr,
    service,
    hostVersion: process.env.npm_package_version ?? "0.1.0",
    runtimeVersion: process.env.npm_package_version ?? "0.1.0",
    instanceId: randomUUID(),
    limits: { maxActiveTurns: manifest.maxActiveTurns },
  })
  await server.serve()
}

export function loadWorkerDeviceConfig(
  path: string,
  options: Pick<WorkerConnectOptions, "readFile" | "stat"> = {}
): CompanionConfig {
  const stat = (options.stat ?? fs.statSync)(path)
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("worker device config must not be readable by group or other users")
  }
  const raw = options.readFile ? options.readFile(path) : fs.readFileSync(path, "utf8")
  const value = JSON.parse(raw) as CompanionConfig
  if (
    typeof value.baseUrl !== "string" ||
    !/^https?:\/\//.test(value.baseUrl) ||
    typeof value.deviceId !== "string" ||
    !value.devicePrivateKeyJwk ||
    typeof (value.tenantId ?? value.accountId) !== "string"
  ) {
    throw new Error("worker device config is malformed or lacks a DPoP device identity")
  }
  return value
}

export function buildWorkerManifest(
  config: ResolvedConfig,
  workspaceBindingRefs: readonly string[],
  requestedMaxActiveTurns = 1
): AgentWorkerManifestV1 {
  const maxActiveTurns = Math.max(1, Math.min(32, Math.floor(requestedMaxActiveTurns)))
  const selected = selectBackend({ requested: config.agentBackend })
  if (!selected.ok) throw new Error(selected.error.message)
  const credentialProfileRefs = Object.entries(config.providers)
    .filter(([, provider]) => Boolean(provider.apiKey || provider.authToken))
    .map(([provider]) => `credential:${provider}`)
    .sort()
  return {
    manifestVersion: 1,
    runtime: selected.backend.id,
    models: config.model ? [config.model] : [],
    hardCapabilities: [...selected.backend.capabilities, "worker-dispatch-v1", "task-workspace"],
    maxActiveTurns,
    credentialProfileRefs,
    workspaceBindingRefs: [...workspaceBindingRefs].sort(),
    taskWorkspace: { enabled: true },
    sandbox: {
      capabilities:
        process.platform === "darwin" || process.platform === "linux"
          ? ["filesystem", "filesystem-isolation", "process-isolation"]
          : [],
    },
    platform: { os: process.platform, arch: process.arch },
  }
}

export function workerSocketUrl(baseUrl: string, ticket: string): string {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = "/ws/worker"
  url.search = ""
  url.searchParams.set("ticket", ticket)
  return url.toString()
}

function beginRequestFromHandoff(handoff: HandoffEnvelope, commandId: string) {
  return {
    taskId: handoff.identity.taskId ?? handoff.identity.childRunId,
    sessionId: handoff.identity.childRunId,
    runId: commandId,
    parentRunId: handoff.identity.parentRunId,
    agentId: handoff.identity.teamId ?? "agent-team",
    agentKind: "agent-team-worker",
    workspaceRoot: "",
    executionRunId: handoff.identity.childRunId,
    attemptId: commandId,
    surface: "agent-team-remote",
  }
}

function defaultWebSocketFactory(url: string): WorkerWebSocket {
  const Constructor = globalThis.WebSocket as unknown as
    (new (url: string) => WorkerWebSocket) | undefined
  if (!Constructor) throw new Error("no global WebSocket (Node >= 20 required)")
  return new Constructor(url)
}

function waitForOpen(socket: WorkerWebSocket, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close(1002, "worker handshake timeout")
      reject(new Error("worker WebSocket did not open within 10 seconds"))
    }, 10_000)
    const settle = (callback: () => void) => {
      clearTimeout(timeout)
      callback()
    }
    socket.addEventListener("open", () => settle(resolve))
    socket.addEventListener("error", (event) =>
      settle(() =>
        reject(event.error instanceof Error ? event.error : new Error("worker WebSocket failed"))
      )
    )
    signal?.addEventListener(
      "abort",
      () => settle(() => reject(new Error("worker connection cancelled"))),
      { once: true }
    )
  })
}

class WorkerSocketWritable extends Writable {
  constructor(private readonly socket: WorkerWebSocket) {
    super()
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    const frame = String(chunk).replace(/[\r\n]+$/, "")
    if (!frame || frame.includes("\n") || frame.includes("\r")) {
      callback(new Error("Agent RPC output must contain exactly one frame"))
      return
    }
    if ((this.socket.bufferedAmount ?? 0) + Buffer.byteLength(frame) > MAX_BUFFERED_SOCKET_BYTES) {
      callback(new Error("worker WebSocket outbound buffer limit exceeded"))
      return
    }
    try {
      this.socket.send(frame)
      callback()
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  }
}
