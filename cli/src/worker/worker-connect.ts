import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { PassThrough, Writable } from "node:stream"

import type { AgentWorkerManifestV1, HandoffEnvelope } from "@cognia/agent"
import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import { issueSocketTicket, registerCompanionWorker } from "@/lib/tauri/companion-auth"

import type { ResolvedConfig } from "../config/schema"
import { reconnectDelayMs, waitForReconnectDelay } from "../runtime/reconnect-delay"
import { createAgentRpcServer } from "../agent/rpc/server"
import { createAgentRuntimeService } from "../agent/rpc/runtime-service"
import { resolveWorkerExecutionProfile } from "../agent/runtime/resolve-worker-execution"
import type { WorkerWorkspaceClient } from "./workspace-client"
import {
  CompanionWorkerTransport,
  CompanionWorkerTransportError,
} from "./companion-worker-transport"

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
  transport?: CompanionWorkerTransport
  reconnect?: boolean
  random?: () => number
  wait?: typeof waitForReconnectDelay
}

export interface WorkerEnrollmentOptions {
  baseUrl: string
  tenantId: string
  enrollment: string
  displayName: string
  deviceConfigPath: string
  serverFingerprint?: string
  register?: typeof registerCompanionWorker
  transport?: CompanionWorkerTransport
}

export async function enrollWorker(options: WorkerEnrollmentOptions): Promise<CompanionConfig> {
  const transport = options.transport ?? new CompanionWorkerTransport()
  const config = await (options.register ?? registerCompanionWorker)(
    {
      baseUrl: options.baseUrl,
      tenantId: options.tenantId,
      enrollment: options.enrollment,
      displayName: options.displayName,
      serverFingerprint: options.serverFingerprint,
    },
    transport.fetch
  )
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
  const transport = options.transport ?? new CompanionWorkerTransport()
  let attempt = 0
  while (!options.signal?.aborted) {
    try {
      await serveWorkerConnection(options, identity, manifest, transport)
      attempt = 0
    } catch (error) {
      if (options.signal?.aborted) return
      if (options.reconnect === false || !isRetryableWorkerConnectionError(error)) throw error
    }
    if (options.reconnect === false) return
    const delay = reconnectDelayMs(attempt, options.random?.() ?? Math.random())
    attempt += 1
    options.diagnostic?.write(
      `${JSON.stringify({ level: "info", message: `worker reconnecting in ${delay} ms` })}\n`
    )
    try {
      await (options.wait ?? waitForReconnectDelay)(delay, options.signal)
    } catch (error) {
      if (options.signal?.aborted) return
      throw error
    }
  }
}

async function serveWorkerConnection(
  options: WorkerConnectOptions,
  identity: CompanionConfig,
  manifest: AgentWorkerManifestV1,
  transport: CompanionWorkerTransport
): Promise<void> {
  const ticket = await (options.issueTicket ?? issueSocketTicket)(
    identity,
    "worker",
    transport.fetch
  )
  const url = workerSocketUrl(identity.baseUrl, ticket.ticket)
  const socket = options.wsFactory
    ? options.wsFactory(url)
    : transport.openWebSocket(url, identity.serverFingerprint)
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

  const workspaceRefs = new Set(manifest.workspaceBindingRefs)
  const assertHandoffExecution = (handoff: HandoffEnvelope) => {
    const executionErrors = validateWorkerHandoffExecution(manifest, handoff)
    if (executionErrors.length > 0) {
      throw new Error(`worker execution profile mismatch: ${executionErrors.join(", ")}`)
    }
  }
  const service = (options.createService ?? createAgentRuntimeService)({
    config: options.runtimeConfig,
    home: options.home,
    workerDispatch: {
      manifest,
      validateHandoffExecution: assertHandoffExecution,
      async resolveHandoffWorkspace(handoff, commandId) {
        assertHandoffExecution(handoff)
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
  const onAbort = () => {
    socket.close(1000, "worker stopping")
    closeInput()
  }
  options.signal?.addEventListener("abort", onAbort, { once: true })
  try {
    await server.serve()
  } finally {
    options.signal?.removeEventListener("abort", onAbort)
  }
}

export function isRetryableWorkerConnectionError(error: unknown): boolean {
  if (error instanceof CompanionWorkerTransportError) return error.code === "transport_error"
  const messages: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    messages.push(current instanceof Error ? current.message : String(current))
    if (typeof current === "object" && "code" in current) {
      messages.push(String((current as { code?: unknown }).code ?? ""))
    }
    current = current instanceof Error ? current.cause : undefined
  }
  const message = messages.join(" ")
  if (/\bHTTP (?:429|5\d\d)\b/.test(message)) return true
  return /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENETUNREACH|socket|WebSocket/i.test(message)
}

export function validateWorkerHandoffExecution(
  manifest: AgentWorkerManifestV1,
  handoff: HandoffEnvelope
): string[] {
  const profile = manifest.executionProfile
  if (!profile) return ["execution profile is missing"]
  const execution = handoff.execution
  const errors: string[] = []
  if (execution.runtimeAdapter && execution.runtimeAdapter !== profile.runtimeAdapter) {
    errors.push(`runtime adapter ${execution.runtimeAdapter} is unavailable`)
  }
  if (
    execution.modelBindingRef &&
    execution.modelBindingRef !== "inherit" &&
    !Object.values(profile.modelBindings).includes(execution.modelBindingRef)
  ) {
    errors.push(`model binding ${execution.modelBindingRef} is unavailable`)
  }
  if (execution.deploymentRef && !profile.deploymentRefs.includes(execution.deploymentRef)) {
    errors.push(`deployment ${execution.deploymentRef} is unavailable`)
  }
  if (
    execution.credentialProfileRef &&
    !manifest.credentialProfileRefs.includes(execution.credentialProfileRef)
  ) {
    errors.push(`credential profile ${execution.credentialProfileRef} is unavailable`)
  }
  for (const capability of execution.requiredCapabilities ?? []) {
    if (!profile.capabilities.includes(capability)) {
      errors.push(`capability ${capability} is unavailable`)
    }
  }
  for (const capability of execution.requiredSandboxCapabilities ?? []) {
    if (!manifest.sandbox.capabilities.includes(capability)) {
      errors.push(`sandbox capability ${capability} is unavailable`)
    }
  }
  return errors
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
  const requestedCapacity = Number.isFinite(requestedMaxActiveTurns)
    ? Math.floor(requestedMaxActiveTurns)
    : 1
  const maxActiveTurns = Math.max(1, Math.min(32, requestedCapacity))
  const resolved = resolveWorkerExecutionProfile(config)
  const credentialProfileRefs = resolved.spec.credential
    ? [resolved.spec.credential.profileRef]
    : []
  return {
    manifestVersion: 1,
    runtime: resolved.backend.id,
    models: [resolved.spec.modelBindings.primary],
    hardCapabilities: [
      ...resolved.spec.capabilities.effective,
      "worker-dispatch-v1",
      "task-workspace",
    ],
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
    executionProfile: resolved.profile,
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

function waitForOpen(socket: WorkerWebSocket, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      socket.close(1000, "worker stopping")
      settle(() => reject(new Error("worker connection cancelled")))
    }
    const timeout = setTimeout(() => {
      socket.close(1002, "worker handshake timeout")
      settle(() => reject(new Error("worker WebSocket did not open within 10 seconds")))
    }, 10_000)
    const settle = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener("abort", onAbort)
      callback()
    }
    socket.addEventListener("open", () => settle(resolve))
    socket.addEventListener("error", (event) =>
      settle(() =>
        reject(event.error instanceof Error ? event.error : new Error("worker WebSocket failed"))
      )
    )
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
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
