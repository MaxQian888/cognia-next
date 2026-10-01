import type { Tool } from "ai"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { AddressInfo } from "node:net"
import type { ToolSessionContext, ToolSessionSendOptions } from "../../tools/session.ts"
import type { AiSdkToolSendOptions } from "../../tools/adapters/ai-sdk.ts"
import type { PendingApproval } from "../../policy/permission/approval.ts"
import type { PluginToolResponse } from "../../tools/plugin/server.ts"
import type { HostRpcCaller } from "../../tools/state/host-background-shells.ts"

interface HostResponse extends PluginToolResponse {
  updatedInput?: unknown
  behavior?: unknown
  message?: unknown
  action?: string
  reason?: string
  modifiedArgs?: unknown
  updatedResult?: unknown
}
type PendingMap = Map<string, { resolve(response: HostResponse): void }>
interface HostFrame extends Record<string, unknown> {
  type: string
  requestId?: string
  reviewId?: string
  toolUseId?: string
}
export interface ToolHostEvent {
  remoteExecutionContext?: Record<string, unknown>
  type: "tool_host_event"
  sessionId: string
  leaseId: string
  generation: number
  event: HostFrame
}
interface Lease {
  remoteExecutionContext?: Record<string, unknown>
  id: string
  owner: string
  generation: number
  token: string
  tools: Record<string, Record<string, Tool>>
  approvals: Map<string, PendingApproval>
  plugins: PendingMap
  reviews: PendingMap
  preflights: PendingMap
  calls: Set<AbortController>
  requests: Map<string, AbortController>
  connections: Set<Server>
  paused: boolean
  starting?: boolean
  server: http.Server
  ready?: Promise<void>
  host?: string
  sandboxAgentId?: string
  deferSandbox?: boolean
  pendingBridge?: { bridgeId: string; host: string; heartbeat: ReturnType<typeof setInterval> }
  bridge?: { bridgeId: string; host: string; heartbeat: ReturnType<typeof setInterval> }
  expiry?: ReturnType<typeof setTimeout>
  closing?: Promise<void>
  toolSession?: ToolSessionContext
  emit?: (event: HostFrame) => void
}
export interface ToolHostInput {
  sandboxAgentId?: string
  deferSandbox?: boolean
  remoteExecutionContext?: Record<string, unknown>
  leaseId: string
  ownerSessionId: string
  renew?: boolean
  pause?: boolean
  generation?: number
  kind?: string
  id?: string
  result?: HostResponse
  sendOptions?: AiSdkToolSendOptions &
    ToolSessionSendOptions & { toolResultReviewEnabled?: boolean }
}
export interface ToolHostDescriptor {
  sandboxToolHostLeaseId?: string
  leaseId: string
  generation: number
  catalogFingerprint: string
  mcpServers: { name: string; transport: string; url: string; headers: { Authorization: string } }[]
}
export interface ToolHostOptions {
  emit: (event: ToolHostEvent) => void
  hostRpc?: HostRpcCaller | null
  log?: (level: "info" | "warn" | "error", message: string) => void
  leaseTtlMs?: number
  reviewTimeoutMs?: number
  buildTools?: typeof buildAiSdkTools
}
import { createToolSessionContext } from "../../tools/session.ts"
// Session-owned MCP projection of the existing Cognia tool execution pipeline.
// The renderer controls the lease over feature-call IPC; external agents receive
// only a scoped loopback token and can never change the tool manifest or policy.
import http from "node:http"
import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { asSchema } from "ai"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import { buildAiSdkTools } from "../../tools/adapters/ai-sdk.ts"
import { assertModelSafeToolOutput } from "../../policy/pii/tool-output.ts"
import { awaitPluginToolResponse } from "../../tools/plugin/server.ts"

const SERVERS = ["cognia-tools", "cognia-plugin-tools"] as const
const MAX_BODY = 2 * 1024 * 1024

function authorize(header: string | string[] | undefined, token: string) {
  const actual = Buffer.from(typeof header === "string" ? header : "")
  const expected = Buffer.from(`Bearer ${token}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function toolResult(value: unknown): CallToolResult {
  const safe = assertModelSafeToolOutput(value)
  return safe && typeof safe === "object" && Array.isArray((safe as { content?: unknown }).content)
    ? (safe as CallToolResult)
    : {
        content: [
          { type: "text", text: typeof safe === "string" ? safe : JSON.stringify(safe ?? null) },
        ],
      }
}

async function validateArguments(definition: Tool, args: unknown, schemas: AjvJsonSchemaValidator) {
  const schema = asSchema(definition.inputSchema)
  if (schema.validate) {
    const validated = await schema.validate(args)
    if (!validated.success) throw new Error("Invalid tool arguments")
    return validated.value
  }
  const validated = schemas.getValidator(schema.jsonSchema)(args)
  if (!validated.valid) throw new Error("Invalid tool arguments")
  return args
}

export function createToolHostManager({
  emit,
  hostRpc,
  log = () => {},
  leaseTtlMs = 300_000,
  reviewTimeoutMs = 30_000,
  buildTools = buildAiSdkTools,
}: ToolHostOptions) {
  const leases = new Map<string, Lease>()
  const calls = new AsyncLocalStorage<{ roundTrips: [PendingMap, string][]; input: unknown }>()
  const schemas = new AjvJsonSchemaValidator()

  function identity(input: ToolHostInput) {
    if (
      !input ||
      typeof input.leaseId !== "string" ||
      input.leaseId.length < 16 ||
      typeof input.ownerSessionId !== "string" ||
      !input.ownerSessionId
    ) {
      throw new Error("tool host requires a lease id and owner session id")
    }
    const lease = leases.get(input.leaseId)
    if (lease && lease.owner !== input.ownerSessionId) throw new Error("tool host owner mismatch")
    return lease
  }

  function touch(lease: Lease) {
    clearTimeout(lease.expiry)
    lease.expiry = setTimeout(() => void destroy(lease).catch(() => {}), leaseTtlMs)
    lease.expiry.unref?.()
  }

  function watchBridge(lease: Lease, bridgeId: string, host: string, pending = false) {
    const bridge = {
      bridgeId,
      host,
      heartbeat: setInterval(() => {
        void hostRpc!
          .call("sandbox.toolHost.renew", { bridgeId })
          .then(async (result) => {
            if (
              !lease.starting &&
              (pending ? lease.pendingBridge : lease.bridge) === bridge &&
              (result as { active?: boolean })?.active !== true
            )
              await destroy(lease)
          })
          .catch(() => {
            if (!lease.starting && (pending ? lease.pendingBridge : lease.bridge) === bridge)
              return destroy(lease).catch(() => {})
            return undefined
          })
      }, 20_000),
    }
    bridge.heartbeat.unref?.()
    return bridge
  }

  function pause(lease: Lease) {
    lease.paused = true
    for (const controller of lease.calls) controller.abort(new Error("Cognia tool host paused"))
    for (const pending of lease.approvals.values())
      pending.resolve({ behavior: "deny", message: "Cognia tool host paused" })
    lease.approvals.clear()
    for (const pending of lease.plugins.values())
      pending.resolve({ error: "Cognia tool host paused" })
    lease.plugins.clear()
    for (const pending of lease.reviews.values()) pending.resolve({})
    lease.reviews.clear()
    for (const pending of lease.preflights.values())
      pending.resolve({ action: "deny", reason: "Tool call aborted" })
    lease.preflights.clear()
    emit({
      type: "tool_host_event",
      ...(lease.remoteExecutionContext
        ? { remoteExecutionContext: lease.remoteExecutionContext }
        : {}),
      sessionId: lease.owner,
      leaseId: lease.id,
      generation: lease.generation,
      event: { type: "tool_host_cancel", sessionId: lease.owner },
    })
  }

  async function destroy(lease: Lease): Promise<void> {
    if (lease.closing) return lease.closing
    pause(lease)
    clearTimeout(lease.expiry)
    leases.delete(lease.id)
    lease.closing = (async () => {
      const bridge = lease.bridge
      lease.bridge = undefined
      const pending = lease.pendingBridge
      lease.pendingBridge = undefined
      for (const entry of [bridge, pending]) {
        if (!entry) continue
        clearInterval(entry.heartbeat)
        await hostRpc?.call("sandbox.toolHost.close", { bridgeId: entry.bridgeId }).catch(() => {})
      }
      await Promise.allSettled([lease.ready])
      await Promise.allSettled([...lease.connections].map((connection) => connection.close()))
      lease.server.closeAllConnections()
      await new Promise<void>((resolve) => lease.server.close(() => resolve()))
      await lease.toolSession?.dispose()
    })()
    return lease.closing
  }

  async function handleHttp(lease: Lease, req: http.IncomingMessage, res: http.ServerResponse) {
    const endpoint = SERVERS.find((name) => req.url === `/${name}`)
    if (
      !endpoint ||
      (req.headers.host !== lease.host &&
        (!lease.bridge || req.headers.host !== lease.bridge.host)) ||
      req.headers.origin ||
      !authorize(req.headers.authorization, lease.token)
    ) {
      res.writeHead(403).end()
      return
    }
    if (req.method !== "POST") {
      res.writeHead(405).end()
      return
    }
    let size = 0
    const parts: Buffer[] = []
    for await (const part of req) {
      size += part.length
      if (size > MAX_BODY) {
        res.writeHead(413).end()
        return
      }
      parts.push(part)
    }
    let body
    try {
      body = JSON.parse(Buffer.concat(parts).toString("utf8"))
    } catch {
      res.writeHead(400).end()
      return
    }
    if (body?.method === "notifications/cancelled" && body.id === undefined) {
      lease.requests
        .get(`${endpoint}:${JSON.stringify(body.params?.requestId)}`)
        ?.abort(new Error("MCP caller cancelled the tool"))
      res.writeHead(202).end()
      return
    }
    const server = new Server({ name: endpoint, version: "1.0.0" }, { capabilities: { tools: {} } })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    lease.connections.add(server)
    res.on("close", () => {
      lease.connections.delete(server)
      void server.close()
    })
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: Object.entries(lease.tools[endpoint] ?? {}).map(([name, definition]) => ({
        name,
        description: definition.description ?? "",
        inputSchema: asSchema(definition.inputSchema).jsonSchema,
      })),
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const definition = lease.tools[endpoint]?.[request.params.name]
      if (lease.paused || lease.closing) throw new Error("Cognia tool host is paused")
      if (!definition) throw new Error("Tool is not available in this Cognia session")
      touch(lease)
      const controller = new AbortController()
      const generation = lease.generation
      const roundTrips: [PendingMap, string][] = []
      const requestKey = `${endpoint}:${JSON.stringify(extra.requestId)}`
      if (lease.requests.has(requestKey)) throw new Error("Duplicate in-flight MCP request id")
      lease.requests.set(requestKey, controller)
      lease.calls.add(controller)
      const signal = AbortSignal.any([controller.signal, extra.signal])
      let rejectAbort!: () => void
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(signal.reason ?? new Error("Tool call aborted"))
        signal.addEventListener("abort", rejectAbort, { once: true })
        if (signal.aborted) rejectAbort()
      })
      try {
        let args = await validateArguments(definition, request.params.arguments ?? {}, schemas)
        signal.throwIfAborted()
        return toolResult(
          await Promise.race([
            calls.run({ roundTrips, input: args }, async () => {
              const id = randomUUID()
              const toolName = `mcp__${endpoint}__${request.params.name}`
              const preflight = awaitPluginToolResponse(
                lease.preflights,
                id,
                toolName,
                reviewTimeoutMs
              )
              lease.emit!({
                type: "tool_host_pre_tool",
                sessionId: lease.owner,
                requestId: id,
                toolName,
                input: args,
              })
              const decision: HostResponse = await preflight
              if (decision?.action !== "allow" && decision?.action !== "modify")
                throw new Error(
                  decision?.reason ?? decision?.error ?? "Tool denied by PreToolUse hook"
                )
              if (decision.action === "modify")
                args = await validateArguments(definition, decision.modifiedArgs, schemas)
              signal.throwIfAborted()
              calls.getStore()!.input = args
              return definition.execute!(args, {
                toolCallId: String(extra.requestId),
                messages: [],
                context: undefined,
                abortSignal: signal,
              })
            }),
            aborted,
          ])
        )
      } catch (error) {
        return {
          ...toolResult(error instanceof Error ? error.message : String(error)),
          isError: true,
        }
      } finally {
        signal.removeEventListener("abort", rejectAbort)
        lease.calls.delete(controller)
        lease.requests.delete(requestKey)
        if (signal.aborted)
          for (const [map, id] of roundTrips) {
            emit({
              type: "tool_host_event",
              ...(lease.remoteExecutionContext
                ? { remoteExecutionContext: lease.remoteExecutionContext }
                : {}),
              sessionId: lease.owner,
              leaseId: lease.id,
              generation,
              event: {
                type: "tool_host_call_cancel",
                sessionId: lease.owner,
                id,
                kind:
                  map === lease.approvals
                    ? "permission"
                    : map === lease.reviews
                      ? "review"
                      : map === lease.preflights
                        ? "preflight"
                        : "plugin",
              },
            })
            map
              .get(id)
              ?.resolve(
                map === lease.approvals
                  ? { behavior: "deny", message: "Tool call aborted" }
                  : { error: "Tool call aborted" }
              )
            map.delete(id)
          }
      }
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  function start(input: ToolHostInput & { renew: true }): Promise<{ leaseId: string }>
  function start(input: ToolHostInput & { renew?: false }): Promise<ToolHostDescriptor>
  function start(input: ToolHostInput): Promise<ToolHostDescriptor | { leaseId: string }>
  async function start(input: ToolHostInput): Promise<ToolHostDescriptor | { leaseId: string }> {
    let lease = identity(input)
    if (input.deferSandbox && !input.sandboxAgentId)
      throw new Error("Deferred tool host requires a sandbox agent")
    if (input.renew) {
      if (!lease || lease.closing) throw new Error("Cognia tool host lease has expired")
      touch(lease)
      return { leaseId: lease.id }
    }
    if (!input.sendOptions || typeof input.sendOptions !== "object")
      throw new Error("tool host requires sendOptions")
    if (lease && (lease.starting || !lease.paused || lease.calls.size))
      throw new Error("Pause the Cognia tool host before updating its tools")
    if (!lease) {
      const server = http.createServer()
      lease = {
        server,
        id: input.leaseId,
        owner: input.ownerSessionId,
        remoteExecutionContext: input.remoteExecutionContext,
        generation: 0,
        token: randomBytes(32).toString("base64url"),
        tools: {},
        approvals: new Map(),
        plugins: new Map(),
        reviews: new Map(),
        preflights: new Map(),
        calls: new Set(),
        requests: new Map(),
        connections: new Set(),
        paused: true,
      }
      leases.set(lease.id, lease)
      const created = lease
      server.on("request", (req, res) => {
        void handleHttp(created, req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500)
          res.end()
        })
      })
      lease.server.requestTimeout = 30_000
      lease.ready = new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject)
          created.host = `127.0.0.1:${(server.address() as AddressInfo).port}`
          resolve()
        })
      })
    }
    const active = lease
    active.starting = true
    try {
      await active.ready
      if (active.closing) throw new Error("Cognia tool host was closed during startup")
      const sendOptions = input.sendOptions
      if (active.sandboxAgentId && active.sandboxAgentId !== input.sandboxAgentId)
        throw new Error("Cognia tool host belongs to another sandbox agent")
      if (active.sandboxAgentId && active.deferSandbox !== Boolean(input.deferSandbox))
        throw new Error("Cognia tool host sandbox mode cannot change")
      if (input.sandboxAgentId) {
        // A sandbox receives the renderer plugin projection only. Host-native
        // builtins would bypass its execution admission and are never exposed.
        if (!hostRpc || !input.sandboxAgentId || input.sandboxAgentId.length > 256)
          throw new Error("Sandbox hosted services are unavailable")
        sendOptions.builtinTools = {}
        sendOptions.planTools = false
        active.sandboxAgentId = input.sandboxAgentId
        active.deferSandbox = Boolean(input.deferSandbox)
      }
      active.generation = (active.generation ?? 0) + 1
      const generation = active.generation
      if (active.deferSandbox && active.pendingBridge) {
        const renewed = (await hostRpc!.call("sandbox.toolHost.renew", {
          bridgeId: active.pendingBridge.bridgeId,
        })) as { active?: boolean }
        if (renewed?.active !== true) throw new Error("Sandbox tool host authority expired")
      }
      if (active.deferSandbox && !active.pendingBridge) {
        const registered = (await hostRpc!.call("sandbox.toolHost.register", {
          agentId: active.sandboxAgentId,
          ownerSessionId: active.owner,
          originDeviceId: active.remoteExecutionContext?.originDeviceId ?? null,
          leaseId: active.id,
          generation,
          port: Number(active.host!.split(":")[1]),
        })) as { bridgeId?: unknown }
        if (
          typeof registered?.bridgeId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            registered.bridgeId
          )
        )
          throw new Error("Sandbox returned an invalid pending service lease")
        active.pendingBridge = watchBridge(active, registered.bridgeId, active.host!, true)
        if (active.closing) {
          clearInterval(active.pendingBridge.heartbeat)
          active.pendingBridge = undefined
          await hostRpc!
            .call("sandbox.toolHost.close", { bridgeId: registered.bridgeId })
            .catch(() => {})
          throw new Error("Cognia tool host closed while registering the sandbox")
        }
      }
      if (active.sandboxAgentId && !active.deferSandbox && active.bridge) {
        const previous = active.bridge
        // Detach first: a pending heartbeat for the old adoption must not
        // destroy the next turn's replacement while renewal is in flight.
        active.bridge = undefined
        clearInterval(previous.heartbeat)
        try {
          const renewed = (await hostRpc!.call("sandbox.toolHost.renew", {
            bridgeId: previous.bridgeId,
          })) as { active?: boolean }
          if (renewed?.active === true && !active.closing)
            active.bridge = watchBridge(active, previous.bridgeId, previous.host)
        } finally {
          if (!active.bridge)
            await hostRpc!
              .call("sandbox.toolHost.close", { bridgeId: previous.bridgeId })
              .catch(() => {})
        }
        if (active.closing) throw new Error("Cognia tool host was closed during startup")
      }
      if (active.sandboxAgentId && !active.deferSandbox && !active.bridge) {
        const opened = (await hostRpc!.call("sandbox.toolHost.open", {
          agentId: active.sandboxAgentId,
          ownerSessionId: active.owner,
          originDeviceId: active.remoteExecutionContext?.originDeviceId ?? null,
          leaseId: active.id,
          generation,
          port: Number(active.host!.split(":")[1]),
        })) as { bridgeId?: unknown; port?: unknown }
        if (
          typeof opened.bridgeId !== "string" ||
          opened.bridgeId.length !== 36 ||
          !Number.isInteger(opened.port) ||
          Number(opened.port) < 1 ||
          Number(opened.port) > 65535
        )
          throw new Error("Sandbox returned an invalid service bridge")
        const bridgeId = opened.bridgeId
        // Only the private native bridge may add this exact loopback authority.
        // Renderer payloads cannot choose an alias or an upstream destination.
        active.bridge = watchBridge(active, bridgeId, `127.0.0.1:${opened.port}`)
        if (active.closing) {
          clearInterval(active.bridge.heartbeat)
          active.bridge = undefined
          await hostRpc!.call("sandbox.toolHost.close", { bridgeId }).catch(() => {})
          throw new Error("Cognia tool host closed while connecting the sandbox")
        }
      }
      if (active.toolSession) active.toolSession.refreshResolvers(sendOptions)
      else
        active.toolSession = createToolSessionContext({
          sendOptions,
          log,
          hostRpc,
          sessionId: active.id,
        })
      const common: Omit<Parameters<typeof buildAiSdkTools>[0], "sendOptions"> = {
        emit: (frame) => {
          const event = frame as HostFrame
          const map =
            event.type === "permission_request"
              ? active.approvals
              : event.type === "tool_result_review"
                ? active.reviews
                : event.type === "tool_host_pre_tool"
                  ? active.preflights
                  : active.plugins
          const id = (event.requestId ?? event.reviewId ?? event.toolUseId)!
          if (active.paused || active.generation !== generation) {
            map
              .get(id)
              ?.resolve(
                event.type === "permission_request"
                  ? { behavior: "deny", message: "Tool call aborted" }
                  : { error: "Tool call aborted" }
              )
            map.delete(id)
            return
          }
          calls.getStore()?.roundTrips.push([map, id])
          emit({
            type: "tool_host_event",
            ...(active.remoteExecutionContext
              ? { remoteExecutionContext: active.remoteExecutionContext }
              : {}),
            sessionId: active.owner,
            leaseId: active.id,
            generation,
            event,
          })
        },
        ...active.toolSession.toolContext(),
        sessionId: active.owner,
        pendingApprovals: active.approvals,
        pendingPluginToolCalls: active.plugins,
      }
      active.emit = common.emit
      if (sendOptions.toolResultReviewEnabled === true) {
        common.reviewToolOutput = async (toolName, toolUseId, result, isError) => {
          const reviewId = randomUUID()
          const pending = awaitPluginToolResponse(
            active.reviews,
            reviewId,
            toolName,
            reviewTimeoutMs
          )
          common.emit({
            type: "tool_result_review",
            sessionId: active.owner,
            reviewId,
            toolUseId: toolUseId ?? "",
            toolName,
            input: calls.getStore()?.input ?? {},
            result,
            isError: isError === true,
          })
          return ((await pending) as HostResponse)?.updatedResult
        }
      }
      active.tools = {
        [SERVERS[0]]: buildTools({ ...common, sendOptions: { ...sendOptions, pluginTools: [] } }),
        [SERVERS[1]]: buildTools({
          ...common,
          sendOptions: { ...sendOptions, builtinTools: {}, planTools: false },
        }),
      }
      active.paused = false
      touch(lease)
      const catalog = SERVERS.map((server) =>
        Object.entries(active.tools[server]!).map(([name, definition]) => ({
          name,
          description: definition.description,
          inputSchema: asSchema(definition.inputSchema).jsonSchema,
        }))
      )
      if (!hasNoLeakingPiiDeep(catalog))
        throw new Error("Tool catalog blocked by the PII redaction gate")
      const catalogFingerprint = createHash("sha256").update(JSON.stringify(catalog)).digest("hex")
      return {
        ...(active.pendingBridge ? { sandboxToolHostLeaseId: active.pendingBridge.bridgeId } : {}),
        leaseId: active.id,
        generation: active.generation,
        catalogFingerprint,
        mcpServers: SERVERS.map((name) => ({
          name,
          transport: "http",
          url: `http://${active.bridge?.host ?? active.host}/${name}`,
          headers: { Authorization: `Bearer ${active.token}` },
        })),
      }
    } catch (error) {
      await destroy(active)
      throw error
    } finally {
      active.starting = false
    }
  }

  async function stop(input: ToolHostInput) {
    const lease = identity(input)
    if (!lease) return { stopped: true }
    if (input.pause) {
      pause(lease)
      touch(lease)
    } else await destroy(lease)
    return { stopped: true }
  }

  function reply(input: ToolHostInput) {
    const lease = identity(input)
    if (!lease || lease.paused) return { accepted: false }
    if (input.generation !== undefined && input.generation !== lease.generation)
      return { accepted: false }
    const map =
      input.kind === "permission"
        ? lease.approvals
        : input.kind === "preflight"
          ? lease.preflights
          : input.kind === "review"
            ? lease.reviews
            : input.kind === "plugin"
              ? lease.plugins
              : undefined
    const pending = map?.get(input.id!)
    if (!pending) return { accepted: false }
    if (
      !input.result ||
      typeof input.result !== "object" ||
      (input.kind === "permission" && !["allow", "deny"].includes(String(input.result.behavior)))
    ) {
      throw new Error("Invalid Cognia tool host response")
    }
    map!.delete(input.id!)
    pending.resolve({ ...input.result })
    return { accepted: true }
  }

  return { start, stop, reply, close: () => Promise.all([...leases.values()].map(destroy)) }
}
