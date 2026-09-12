/**
 * Cognia's first-party Pi extension (ADR-0119).
 *
 * Loaded with `pi -e <this file>` by `PiRpcClientAdapter`. Desktop ships the
 * pinned TypeScript with sidecar dependencies; standalone CLI packages bundle
 * these dependencies and pin the compiled output during staging.
 *
 * It does three things and decides nothing:
 *
 *   1. **Handshake.** Announces itself on `session_start` so the adapter can
 *      prove the interception below is live. No handshake, no session.
 *   2. **Native tool interception.** `pi.on("tool_call")` applies a policy
 *      TABLE handed to it by Cognia. The table is computed and tested in
 *      `lib/ai/agent/external/pi-permission.ts`; nothing here re-derives it,
 *      because `sidecar/` is outside the root tsconfig and Jest and any logic
 *      living here would be permanently unverified.
 *   3. **Tool projection.** Registers Cognia's tools and relays each call to
 *      the tool-host broker, which re-authorizes every one.
 *
 * Everything fails closed. A missing policy reads as `plan`, a broker that
 * cannot be reached refuses the call, and a handler that throws blocks rather
 * than allowing.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import {
  ElicitRequestSchema,
  ListRootsRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { hasNoLeakingPiiDeep, redactText } from "@cognia/redact"
import { pathToFileURL } from "node:url"

// Pi supplies these at load time; the package is not a Cognia dependency, so
// the types are declared structurally rather than imported.
interface PiUi {
  confirm(title: string, message?: string, options?: { signal?: AbortSignal }): Promise<boolean>
  notify(message: string, level?: "info" | "warning" | "error"): void
  setStatus(key: string, text: string): void
  input?(
    title: string,
    placeholder?: string,
    options?: { signal?: AbortSignal }
  ): Promise<string | undefined>
}
interface PiCtx {
  cwd?: string
  ui: PiUi
  hasUI?: boolean
  signal?: AbortSignal
}
interface PiToolCallEvent {
  toolName: string
  toolCallId?: string
  input?: Record<string, unknown>
}
interface PiToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>
  details?: Record<string, unknown>
}
interface PiExtensionApi {
  getActiveTools?(): string[]
  setActiveTools?(names: string[]): void
  on(event: string, handler: (event: never, ctx: PiCtx) => unknown | Promise<unknown>): void
  registerTool(spec: {
    name: string
    label?: string
    description: string
    parameters: unknown
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate?: (partial: unknown) => void,
      ctx?: PiCtx
    ) => Promise<PiToolResult>
  }): void
}

// ---------------------------------------------------------------------------
// Policy (data only — see lib/ai/agent/external/pi-permission.ts)
// ---------------------------------------------------------------------------

type PiToolDecision = "allow" | "ask" | "deny"
interface PiToolPolicy {
  mode: string
  decisions: Record<string, PiToolDecision>
  fallback: PiToolDecision
}

/** Mirror of `decodePiToolPolicy`: unreadable input becomes deny-everything. */
function readPolicy(raw: string | undefined): PiToolPolicy {
  const closed: PiToolPolicy = { mode: "unreadable", decisions: {}, fallback: "deny" }
  if (!raw) return closed
  try {
    const parsed = JSON.parse(raw) as Partial<PiToolPolicy>
    if (!parsed || typeof parsed !== "object" || typeof parsed.decisions !== "object") return closed
    const decisions: Record<string, PiToolDecision> = {}
    for (const [tool, decision] of Object.entries(parsed.decisions ?? {})) {
      if (decision === "allow" || decision === "ask" || decision === "deny") {
        decisions[tool] = decision
      }
    }
    const fallback =
      parsed.fallback === "allow" || parsed.fallback === "ask" || parsed.fallback === "deny"
        ? parsed.fallback
        : "deny"
    return { mode: String(parsed.mode ?? "unknown"), decisions, fallback }
  } catch {
    return closed
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export const COGNIA_PI_EXTENSION_VERSION = 2

/**
 * Marker prefixing the title of a native-tool approval dialog.
 *
 * Mirror of `PI_PERMISSION_MARKER` in `lib/ai/agent/external/pi-permission.ts`.
 * Exported so the parity test can assert the two are identical: if they drift,
 * every approval silently degrades into a generic elicitation form and the
 * allow/deny/allow-always affordances disappear.
 */
export const COGNIA_PERMISSION_MARKER = "cognia-permission/v1"

/**
 * Exported ONLY so `lib/ai/agent/external/pi-permission.test.ts` can pin this
 * reader against the app-side decoder. `sidecar/` has no test discovery of its
 * own, and an unverified copy of a security decision is exactly what that test
 * exists to prevent.
 */
export const __readPolicyForTests = readPolicy

/**
 * Exported for the same reason as {@link __readPolicyForTests}: the payload the
 * extension puts on the wire has to keep agreeing with the decoder that reads
 * it, and a silent disagreement costs the user the command they are approving.
 */
export const __markerPayloadForTests = (
  toolName: string,
  mode: string,
  input: Record<string, unknown> | undefined
) => markerPayload(toolName, mode, input)

export default function cogniaPiExtension(pi: PiExtensionApi): void {
  const env = process.env
  const policy = readPolicy(env.COGNIA_TOOLHOST_PI_POLICY)
  const servers = readMcpServers(env.COGNIA_TOOLHOST_PI_MCP_SERVERS)
  const projection = createMcpProjection(pi, servers)

  // Cognia's system prompt / instruction envelope, already PII-gated on the
  // adapter side. Injected per turn because Pi rebuilds its system prompt for
  // every run, so a one-shot injection at session start would not survive.
  const injectedPrompt = env.COGNIA_TOOLHOST_PI_SYSTEM_PROMPT
  if (injectedPrompt) {
    pi.on("before_agent_start", (event: never) => {
      const current = (event as unknown as { systemPrompt?: string }).systemPrompt ?? ""
      return { systemPrompt: `${current}\n\n${injectedPrompt}` }
    })
  }

  pi.on("session_start", async (_event, ctx) => {
    await projection.start(ctx)
    ctx.ui.setStatus(
      "cognia",
      `cognia-ready v${COGNIA_PI_EXTENSION_VERSION} mode=${policy.mode} toolhost=${servers.length ? "on" : "off"}`
    )
  })
  pi.on("session_shutdown", () => projection.close())
  pi.on("tool_result", (event: never) => {
    const result = event as unknown as {
      content?: Array<Record<string, unknown>>
      isError?: boolean
    }
    try {
      return {
        content: projection.result({ content: result.content }).content,
        isError: result.isError,
      }
    } catch (error) {
      return { content: [{ type: "text", text: safeText(String(error)) }], isError: true }
    }
  })
  pi.on("before_agent_start", async (_event, ctx) => {
    await projection.refresh(ctx)
  })

  /**
   * One approval at a time, and nothing else while one is open.
   *
   * Pi issues several tool calls from one assistant message, so a call that the
   * policy allows outright used to run while the user was still answering an
   * approval about a different one: the dialog asked whether to allow a
   * command, and the work behind it had already happened. This is a mutex, not
   * a policy. The decisions themselves are still a lookup in the table the app
   * computed.
   */
  let approvals: Promise<unknown> = Promise.resolve()
  const behindApprovals = <T>(work: () => Promise<T>): Promise<T> => {
    const run = approvals.then(work, work)
    approvals = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /**
   * Intercept every native Pi tool call.
   *
   * Returning `{ block: true }` refuses the call; returning nothing allows it.
   * Any throw is converted to a block, so a bug here cannot widen access.
   */
  pi.on("tool_call", async (event: never, ctx: PiCtx) => {
    const call = event as unknown as PiToolCallEvent
    if (projection.owns(call.toolName)) return undefined
    // Capture the current turn signal: ctx may expose a live getter whose value
    // changes when an aborted turn unwinds and another turn starts.
    const signal = ctx.signal
    const cancelled = { block: true, reason: "Cognia tool call cancelled" }
    try {
      if (signal?.aborted) return cancelled
      const decision = policy.decisions[call.toolName] ?? policy.fallback

      if (decision === "allow") {
        // Wait behind any approval the user has not answered. Awaiting the
        // chain rather than joining it, so allowed calls never delay each other.
        await approvals
        return signal?.aborted ? cancelled : undefined
      }
      if (decision === "deny") {
        return { block: true, reason: `Blocked by Cognia (${policy.mode} mode)` }
      }

      // "ask" — with no UI to ask through, the safe reading is refusal.
      if (ctx.hasUI === false) {
        return { block: true, reason: "Cognia could not ask for approval" }
      }
      // The title carries a versioned marker so the adapter's mapper can tell
      // a NATIVE-TOOL APPROVAL from an ordinary extension dialog and route it
      // to the tool approval UI instead of a generic form. Mirror of
      // `encodePiPermissionTitle` in `lib/ai/agent/external/pi-permission.ts`;
      // the parity test pins the two together. The marker never reaches the
      // user — the mapper rebuilds a clean title — and `message` stays
      // human-readable so an unrecognised version degrades to a real question.
      const approved = await behindApprovals(async () => {
        if (signal?.aborted) return false
        return ctx.ui.confirm(
          `${COGNIA_PERMISSION_MARKER} ${JSON.stringify(
            markerPayload(call.toolName, policy.mode, call.input)
          )}`,
          describeCall(call.toolName, call.input),
          { signal }
        )
      })
      if (signal?.aborted) return cancelled
      return approved === true ? undefined : { block: true, reason: "Denied by the user" }
    } catch (error) {
      return { block: true, reason: `Cognia permission check failed: ${String(error)}` }
    }
  })
}

/**
 * Serialized input ceiling, mirroring `PI_PERMISSION_INPUT_LIMIT` in
 * `lib/ai/agent/external/pi-permission.ts` (the parity test pins the pair).
 */
const COGNIA_PERMISSION_INPUT_LIMIT = 16_000

/**
 * The approval payload: which tool, under which mode, with which arguments.
 *
 * The arguments are what makes the prompt answerable. Without them the user saw
 * "Allow bash?" and had to approve a command that was never shown; with them
 * the host renders the same summary and diff it renders for every other agent.
 * Dropped when they do not fit, since a dialog title is not a place for an
 * unbounded payload, and dropped is still readable: the message names the tool
 * and its target.
 */
function markerPayload(
  toolName: string,
  mode: string,
  input: Record<string, unknown> | undefined
): { tool: string; mode: string; input?: Record<string, unknown> } {
  const payload = { tool: toolName, mode }
  if (!input) return payload
  try {
    const serialized = JSON.stringify(input)
    if (serialized.length > COGNIA_PERMISSION_INPUT_LIMIT) return payload
  } catch {
    return payload
  }
  return { ...payload, input }
}

function describeCall(toolName: string, input: Record<string, unknown> | undefined): string {
  if (!input) return toolName
  const command = input.command ?? input.path ?? input.file_path ?? input.pattern
  return typeof command === "string" ? `${toolName}: ${command}` : toolName
}

interface McpServerConfig {
  name: string
  type?: "http" | "sse"
  command?: string
  args?: string[]
  env?: Array<{ name: string; value: string }>
  url?: string
  headers?: Array<{ name: string; value: string }>
}

export function readMcpServers(raw: string | undefined): McpServerConfig[] {
  if (!raw) return []
  const servers = JSON.parse(raw) as McpServerConfig[]
  if (!Array.isArray(servers)) throw new Error("Invalid Cognia Pi MCP configuration")
  const names = new Set<string>()
  for (const server of servers) {
    if (!server || !/^[a-zA-Z0-9_-]+$/.test(server.name) || names.has(server.name))
      throw new Error("Invalid or duplicate Cognia MCP server name")
    names.add(server.name)
    if (server.type === undefined) {
      if (
        !server.command ||
        !Array.isArray(server.args) ||
        server.args.some((arg) => typeof arg !== "string")
      )
        throw new Error("Invalid Cognia MCP stdio configuration")
    } else if (server.type === "http" || server.type === "sse") {
      const url = new URL(server.url ?? "")
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error("Invalid Cognia MCP URL")
    } else throw new Error("Unsupported Cognia Pi MCP transport")
    for (const entries of [server.env, server.headers]) {
      if (
        entries !== undefined &&
        (!Array.isArray(entries) ||
          entries.some(
            (entry) => typeof entry?.name !== "string" || typeof entry?.value !== "string"
          ))
      )
        throw new Error("Invalid Cognia MCP environment or headers")
    }
  }
  return servers
}

function safeText(value: string): string {
  return redactText(value).redacted
}

/** Pi supports text and image tool blocks. Preserve resource text explicitly. */
export function piMcpResult(value: unknown): PiToolResult {
  const result = value as {
    content?: Array<Record<string, unknown>>
    structuredContent?: unknown
    isError?: boolean
  }
  const content: PiToolResult["content"] = []
  for (const block of result.content ?? []) {
    if (block.type === "text" && typeof block.text === "string")
      content.push({ type: "text", text: safeText(block.text) })
    else if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    )
      content.push({ type: "image", data: block.data, mimeType: block.mimeType })
    else if (block.type === "resource" && block.resource && typeof block.resource === "object") {
      const resource = block.resource as { text?: string; blob?: string; mimeType?: string }
      if (typeof resource.text === "string")
        content.push({ type: "text", text: safeText(resource.text) })
      else if (
        typeof resource.blob === "string" &&
        /^(text\/|application\/(json|xml|javascript))/.test(resource.mimeType ?? "")
      )
        content.push({
          type: "text",
          text: safeText(Buffer.from(resource.blob, "base64").toString("utf8")),
        })
      else
        throw new Error(
          "Pi cannot represent this MCP binary resource; use a text or image tool result"
        )
    } else if (block.type === "resource_link")
      content.push({ type: "text", text: safeText(JSON.stringify(block)) })
    else throw new Error(`Pi cannot represent MCP tool content type ${String(block.type)}`)
  }
  if (result.structuredContent !== undefined)
    content.push({ type: "text", text: safeText(JSON.stringify(result.structuredContent)) })
  if (!hasNoLeakingPiiDeep(content)) throw new Error("MCP tool output blocked by the PII gate")
  if (result.isError)
    throw new Error(
      content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n") || "MCP tool failed"
    )
  return { content, details: {} }
}

/** Official MCP clients live for exactly one Pi session, never during probes. */
export function createMcpProjection(pi: PiExtensionApi, servers: McpServerConfig[]) {
  const validator = new AjvJsonSchemaValidator()
  const credentials = servers.flatMap((server) =>
    [...(server.headers ?? []), ...(server.env ?? [])]
      .filter((entry) => entry.value && /key|token|secret|auth/i.test(entry.name))
      .flatMap((entry) => [entry.value, ...(/^Bearer\s+(\S+)$/i.exec(entry.value)?.slice(1) ?? [])])
  )
  const clients = new Map<string, Client>()
  const known = new Set<string>()
  const available = new Set<string>()
  let context: PiCtx | undefined
  let lifetime = new AbortController()
  let refreshing: Promise<void> | undefined
  let started = false
  let generation = 0

  function scrub(error: unknown): Error {
    return new Error(scrubText(error instanceof Error ? error.message : String(error)))
  }

  function scrubText(text: string): string {
    for (const credential of credentials) text = text.split(credential).join("[REDACTED]")
    return safeText(text)
  }

  function result(value: unknown): PiToolResult {
    return piMcpResult(
      JSON.parse(
        JSON.stringify(value, (_key, entry) =>
          typeof entry === "string" ? scrubText(entry) : entry
        )
      )
    )
  }

  async function refresh(ctx?: PiCtx): Promise<void> {
    if (ctx) context = ctx
    if (refreshing) return refreshing
    const signal = lifetime.signal
    refreshing = (async () => {
      const next = new Map<
        string,
        {
          server: string
          client: Client
          tool: Awaited<ReturnType<Client["listTools"]>>["tools"][number]
        }
      >()
      for (const [server, client] of clients) {
        let cursor: string | undefined
        const seen = new Set<string>()
        do {
          const page = await client.listTools(cursor ? { cursor } : {}, {
            signal,
            timeout: 15_000,
          })
          if (
            !hasNoLeakingPiiDeep(page.tools) ||
            credentials.some((value) => JSON.stringify(page.tools).includes(value))
          )
            throw new Error("MCP tool catalog blocked by the PII gate")
          for (const tool of page.tools) {
            const name = `mcp__${server}__${tool.name}`
            if (!/^[a-zA-Z0-9_.-]+$/.test(tool.name) || next.has(name))
              throw new Error("Invalid or duplicate MCP tool name")
            next.set(name, { server, client, tool })
          }
          cursor = page.nextCursor
          if (cursor && seen.has(cursor))
            throw new Error("MCP tool discovery returned a repeating cursor")
          if (cursor) seen.add(cursor)
        } while (cursor)
      }
      signal.throwIfAborted()
      const active = pi.getActiveTools?.() ?? []
      const previouslyAvailable = new Set(available)
      available.clear()
      for (const [name, { client, tool }] of next) {
        known.add(name)
        available.add(name)
        pi.registerTool({
          name,
          label: tool.title ?? tool.name,
          description: tool.description ?? `MCP tool ${tool.name}`,
          parameters: tool.inputSchema,
          async execute(_toolCallId, params, signal, onUpdate) {
            if (!available.has(name) || lifetime.signal.aborted)
              throw new Error("Cognia MCP tool is no longer available")
            const abortSignal = signal
              ? AbortSignal.any([signal, lifetime.signal])
              : lifetime.signal
            try {
              const response = await client.callTool(
                { name: tool.name, arguments: params },
                undefined,
                {
                  signal: abortSignal,
                  timeout: 24 * 60 * 60 * 1000,
                  onprogress: (progress) =>
                    onUpdate?.({
                      content: [
                        {
                          type: "text",
                          text: scrubText(
                            progress.message ??
                              `${progress.progress}${progress.total === undefined ? "" : `/${progress.total}`}`
                          ),
                        },
                      ],
                      details: {},
                    }),
                }
              )
              return result(response)
            } catch (error) {
              throw scrub(error)
            }
          },
        })
      }
      if (pi.setActiveTools && pi.getActiveTools)
        pi.setActiveTools([
          ...new Set([
            ...active.filter((name) => !known.has(name) || available.has(name)),
            ...[...available].filter((name) => !previouslyAvailable.has(name)),
          ]),
        ])
    })()
    try {
      await refreshing
    } catch (error) {
      throw scrub(error)
    } finally {
      refreshing = undefined
    }
  }

  async function close(): Promise<void> {
    generation++
    started = false
    lifetime.abort(new Error("Pi session closed"))
    available.clear()
    await Promise.allSettled([...clients.values()].map((client) => client.close()))
    await refreshing?.catch(() => undefined)
    clients.clear()
  }

  async function start(ctx: PiCtx): Promise<void> {
    const cleanup = close()
    const startingGeneration = generation
    await cleanup
    if (startingGeneration !== generation) throw new Error("Pi session closed during startup")
    lifetime = new AbortController()
    context = ctx
    try {
      for (const server of servers) {
        const client = new Client(
          { name: "cognia-pi", version: "2.0.0" },
          { capabilities: { roots: { listChanged: false }, elicitation: { form: {}, url: {} } } }
        )
        clients.set(server.name, client)
        client.setRequestHandler(ListRootsRequestSchema, () => {
          const extra = JSON.parse(
            process.env.COGNIA_TOOLHOST_PI_ADDITIONAL_DIRECTORIES ?? "[]"
          ) as string[]
          const paths = [ctx.cwd ?? process.cwd(), ...extra]
          const roots = paths.map((entry) => ({ uri: pathToFileURL(entry).href }))
          if (!hasNoLeakingPiiDeep(roots))
            throw new Error("MCP workspace roots blocked by the PII gate")
          return { roots }
        })
        client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
          const ui = context?.ui
          if (!ui || context?.hasUI === false) return { action: "cancel" as const }
          const signal = AbortSignal.any([lifetime.signal, extra.signal])
          if (request.params.mode === "url") {
            const accepted = await ui.confirm(request.params.message, request.params.url, {
              signal,
            })
            return { action: accepted ? ("accept" as const) : ("decline" as const) }
          }
          if (!ui.input) return { action: "cancel" as const }
          const answer = await ui.input(
            request.params.message,
            JSON.stringify(request.params.requestedSchema),
            { signal }
          )
          if (answer === undefined) return { action: "cancel" as const }
          const content = JSON.parse(answer) as Record<string, string | number | boolean>
          if (!validator.getValidator(request.params.requestedSchema)(content).valid)
            throw new Error("MCP elicitation response does not match the requested schema")
          if (!hasNoLeakingPiiDeep(content))
            throw new Error("MCP elicitation response blocked by the PII gate")
          return { action: "accept" as const, content }
        })
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
          if (!started) return
          void refresh().catch((error) => context?.ui.notify(scrub(error).message, "error"))
        })
        const headers = Object.fromEntries(
          (server.headers ?? []).map(({ name, value }) => [name, value])
        )
        const transport =
          server.type === "http"
            ? new StreamableHTTPClientTransport(new URL(server.url!), { requestInit: { headers } })
            : server.type === "sse"
              ? new SSEClientTransport(new URL(server.url!), { requestInit: { headers } })
              : new StdioClientTransport({
                  command: server.command!,
                  args: server.args,
                  cwd: ctx.cwd,
                  env: Object.fromEntries(
                    (server.env ?? []).map(({ name, value }) => [name, value])
                  ),
                  stderr: "pipe",
                })
        await client.connect(transport, { signal: lifetime.signal, timeout: 15_000 })
      }
      started = true
      await refresh(ctx)
    } catch (error) {
      await close()
      throw scrub(error)
    }
  }

  return { start, refresh, close, result, owns: (name: string) => known.has(name) }
}
