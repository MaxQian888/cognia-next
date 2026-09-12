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
import { buildAiSdkTools, assertModelSafeToolOutput } from "./ai-sdk-tools.mjs"
import { makeLazyLspResolver } from "./lsp-resolver-factory.mjs"
import { makeLazyCodeGraphResolver } from "./codegraph-resolver-factory.mjs"
import { createReadTracker } from "../builtin-tools/core/read-tracker.mjs"
import { createSessionTaskStore } from "../builtin-tools/core/tasks.mjs"
import { createSessionBgShellRegistry } from "../builtin-tools/core/bash-host-sessions.mjs"
import { disposeTerminalRepls } from "../builtin-tools/terminal-repl-tool.mjs"
import { awaitPluginToolResponse } from "../builtin-tools/plugin-tools.mjs"

const SERVERS = ["cognia-tools", "cognia-plugin-tools"]
const MAX_BODY = 2 * 1024 * 1024

function authorize(header, token) {
  const actual = Buffer.from(typeof header === "string" ? header : "")
  const expected = Buffer.from(`Bearer ${token}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function toolResult(value) {
  const safe = assertModelSafeToolOutput(value)
  return safe && typeof safe === "object" && Array.isArray(safe.content)
    ? safe
    : {
        content: [
          { type: "text", text: typeof safe === "string" ? safe : JSON.stringify(safe ?? null) },
        ],
      }
}

async function validateArguments(definition, args, schemas) {
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
}) {
  const leases = new Map()
  const calls = new AsyncLocalStorage()
  const schemas = new AjvJsonSchemaValidator()

  function identity(input) {
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

  function touch(lease) {
    clearTimeout(lease.expiry)
    lease.expiry = setTimeout(() => void destroy(lease).catch(() => {}), leaseTtlMs)
    lease.expiry.unref?.()
  }

  function pause(lease) {
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
      sessionId: lease.owner,
      leaseId: lease.id,
      generation: lease.generation,
      event: { type: "tool_host_cancel", sessionId: lease.owner },
    })
  }

  async function destroy(lease) {
    if (lease.closing) return lease.closing
    pause(lease)
    clearTimeout(lease.expiry)
    leases.delete(lease.id)
    lease.closing = (async () => {
      await Promise.allSettled([lease.ready])
      await Promise.allSettled([...lease.connections].map((connection) => connection.close()))
      lease.server.closeAllConnections()
      await new Promise((resolve) => lease.server.close(() => resolve()))
      lease.lsp?.dispose()
      lease.codeGraph?.dispose()
      disposeTerminalRepls(lease.id)
      await lease.bgShells?.killAll?.()
    })()
    return lease.closing
  }

  async function handleHttp(lease, req, res) {
    const endpoint = SERVERS.find((name) => req.url === `/${name}`)
    if (
      !endpoint ||
      req.headers.host !== lease.host ||
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
    const parts = []
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
      const roundTrips = []
      const requestKey = `${endpoint}:${JSON.stringify(extra.requestId)}`
      if (lease.requests.has(requestKey)) throw new Error("Duplicate in-flight MCP request id")
      lease.requests.set(requestKey, controller)
      lease.calls.add(controller)
      const signal = AbortSignal.any([controller.signal, extra.signal])
      let rejectAbort
      const aborted = new Promise((_, reject) => {
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
              lease.emit({
                type: "tool_host_pre_tool",
                sessionId: lease.owner,
                requestId: id,
                toolName,
                input: args,
              })
              const decision = await preflight
              if (decision?.action !== "allow" && decision?.action !== "modify")
                throw new Error(
                  decision?.reason ?? decision?.error ?? "Tool denied by PreToolUse hook"
                )
              if (decision.action === "modify")
                args = await validateArguments(definition, decision.modifiedArgs, schemas)
              signal.throwIfAborted()
              calls.getStore().input = args
              return definition.execute(args, {
                toolCallId: String(extra.requestId),
                messages: [],
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

  async function start(input) {
    let lease = identity(input)
    if (input.renew) {
      if (!lease || lease.closing) throw new Error("Cognia tool host lease has expired")
      touch(lease)
      return { leaseId: lease.id }
    }
    if (!input.sendOptions || typeof input.sendOptions !== "object")
      throw new Error("tool host requires sendOptions")
    if (lease && (!lease.paused || lease.calls.size))
      throw new Error("Pause the Cognia tool host before updating its tools")
    if (!lease) {
      lease = {
        id: input.leaseId,
        owner: input.ownerSessionId,
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
      lease.server = http.createServer((req, res) => {
        void handleHttp(lease, req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500)
          res.end()
        })
      })
      lease.server.requestTimeout = 30_000
      lease.ready = new Promise((resolve, reject) => {
        lease.server.once("error", reject)
        lease.server.listen(0, "127.0.0.1", () => {
          lease.server.removeListener("error", reject)
          lease.host = `127.0.0.1:${lease.server.address().port}`
          resolve()
        })
      })
      lease.readTracker = createReadTracker()
      lease.taskStore = createSessionTaskStore()
    }
    try {
      await lease.ready
      if (lease.closing) throw new Error("Cognia tool host was closed during startup")
      lease.lsp?.dispose()
      lease.codeGraph?.dispose()
      const sendOptions = input.sendOptions
      lease.generation = (lease.generation ?? 0) + 1
      const generation = lease.generation
      lease.lsp = makeLazyLspResolver({ sendOptions, log })
      lease.codeGraph = makeLazyCodeGraphResolver({ sendOptions, log })
      lease.bgShells ??= createSessionBgShellRegistry({
        hostRpc,
        sessionId: lease.id,
        backgroundProcessHost: sendOptions.backgroundProcessHost,
      })
      const common = {
        emit: (event) => {
          const map =
            event.type === "permission_request"
              ? lease.approvals
              : event.type === "tool_result_review"
                ? lease.reviews
                : event.type === "tool_host_pre_tool"
                  ? lease.preflights
                  : lease.plugins
          const id = event.requestId ?? event.reviewId ?? event.toolUseId
          if (lease.paused || lease.generation !== generation) {
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
            sessionId: lease.owner,
            leaseId: lease.id,
            generation,
            event,
          })
        },
        sessionId: lease.owner,
        pendingApprovals: lease.approvals,
        pendingPluginToolCalls: lease.plugins,
        readTracker: lease.readTracker,
        taskStore: lease.taskStore,
        bgShells: lease.bgShells,
        hostRpc,
        lspResolver: lease.lsp.lspResolver,
        codeGraphResolver: lease.codeGraph.codeGraphResolver,
      }
      lease.emit = common.emit
      if (sendOptions.toolResultReviewEnabled === true) {
        common.reviewToolOutput = async (toolName, toolUseId, result, isError) => {
          const reviewId = randomUUID()
          const pending = awaitPluginToolResponse(
            lease.reviews,
            reviewId,
            toolName,
            reviewTimeoutMs
          )
          common.emit({
            type: "tool_result_review",
            sessionId: lease.owner,
            reviewId,
            toolUseId: toolUseId ?? "",
            toolName,
            input: calls.getStore()?.input ?? {},
            result,
            isError: isError === true,
          })
          return (await pending)?.updatedResult
        }
      }
      lease.tools = {
        [SERVERS[0]]: buildTools({ ...common, sendOptions: { ...sendOptions, pluginTools: [] } }),
        [SERVERS[1]]: buildTools({
          ...common,
          sendOptions: { ...sendOptions, builtinTools: {}, planTools: false },
        }),
      }
      lease.paused = false
      touch(lease)
      const catalog = SERVERS.map((server) =>
        Object.entries(lease.tools[server]).map(([name, definition]) => ({
          name,
          description: definition.description,
          inputSchema: asSchema(definition.inputSchema).jsonSchema,
        }))
      )
      if (!hasNoLeakingPiiDeep(catalog))
        throw new Error("Tool catalog blocked by the PII redaction gate")
      const catalogFingerprint = createHash("sha256").update(JSON.stringify(catalog)).digest("hex")
      return {
        leaseId: lease.id,
        generation: lease.generation,
        catalogFingerprint,
        mcpServers: SERVERS.map((name) => ({
          name,
          transport: "http",
          url: `http://${lease.host}/${name}`,
          headers: { Authorization: `Bearer ${lease.token}` },
        })),
      }
    } catch (error) {
      await destroy(lease)
      throw error
    }
  }

  async function stop(input) {
    const lease = identity(input)
    if (!lease) return { stopped: true }
    if (input.pause) {
      pause(lease)
      touch(lease)
    } else await destroy(lease)
    return { stopped: true }
  }

  function reply(input) {
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
    const pending = map?.get(input.id)
    if (!pending) return { accepted: false }
    if (
      !input.result ||
      typeof input.result !== "object" ||
      (input.kind === "permission" && !["allow", "deny"].includes(input.result.behavior))
    ) {
      throw new Error("Invalid Cognia tool host response")
    }
    map.delete(input.id)
    pending.resolve(input.result)
    return { accepted: true }
  }

  return { start, stop, reply, close: () => Promise.all([...leases.values()].map(destroy)) }
}
