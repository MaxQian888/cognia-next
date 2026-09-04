/**
 * Cognia's first-party Pi extension (ADR-0119).
 *
 * Loaded with `pi -e <this file>` by `PiRpcClientAdapter`. It is shipped as raw
 * TypeScript because Pi compiles `.ts` extensions itself — there is no build
 * step, which is also what lets the adapter pin this file by SHA-256.
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

import net from "node:net"

// Pi supplies these at load time; the package is not a Cognia dependency, so
// the types are declared structurally rather than imported.
interface PiUi {
  confirm(title: string, message?: string): Promise<boolean>
  notify(message: string, level?: "info" | "warning" | "error"): void
  setStatus(key: string, text: string): void
}
interface PiCtx {
  ui: PiUi
  hasUI?: boolean
}
interface PiToolCallEvent {
  toolName: string
  toolCallId?: string
  input?: Record<string, unknown>
}
interface PiToolResult {
  content: Array<{ type: "text"; text: string }>
  details?: Record<string, unknown>
}
interface PiExtensionApi {
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
// Tool-host broker client (NDJSON over a unix socket / named pipe)
// ---------------------------------------------------------------------------

/** The subset of the broker's session descriptor this extension needs. */
interface ToolHostSessionDescriptor {
  hostTools?: Array<{ name: string; description?: string; jsonSchema?: unknown }>
}

interface BrokerRequest {
  id: number
  method: "hello" | "authorize" | "exec" | "report"
  params?: unknown
}

class BrokerClient {
  private socket?: net.Socket
  private buffer = ""
  private nextId = 1
  private readonly pending = new Map<
    number,
    (value: { result?: unknown; error?: string }) => void
  >()
  private ready?: Promise<ToolHostSessionDescriptor | undefined>

  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly server: string
  ) {}

  connect(): Promise<ToolHostSessionDescriptor | undefined> {
    if (this.ready) return this.ready
    this.ready = new Promise<ToolHostSessionDescriptor | undefined>((resolve, reject) => {
      const socket = net.createConnection(this.endpoint)
      this.socket = socket
      socket.setEncoding("utf8")
      socket.on("data", (chunk: string) => this.ingest(chunk))
      socket.on("error", (error) => {
        this.failAll(String(error))
        reject(error)
      })
      socket.on("close", () => this.failAll("tool host closed the connection"))
      socket.once("connect", () => {
        this.request("hello", { token: this.token, server: this.server })
          .then((response) => {
            if (response.error) return reject(new Error(response.error))
            // `hello` answers with the session descriptor; that is where the
            // projectable tool list lives.
            const result = response.result as { session?: ToolHostSessionDescriptor } | undefined
            resolve(result?.session)
          })
          .catch(reject)
      })
    })
    return this.ready
  }

  request(
    method: BrokerRequest["method"],
    params: unknown
  ): Promise<{ result?: unknown; error?: string }> {
    const socket = this.socket
    if (!socket || socket.destroyed) {
      return Promise.resolve({ error: "tool host is not connected" })
    }
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      socket.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  private ingest(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split("\n")
    this.buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      let message: { id?: number; result?: unknown; error?: string }
      try {
        message = JSON.parse(line)
      } catch {
        // A malformed frame means the channel is no longer trustworthy.
        this.socket?.destroy()
        this.failAll("tool host sent a malformed frame")
        return
      }
      if (typeof message.id !== "number") continue
      const resolve = this.pending.get(message.id)
      if (!resolve) continue
      this.pending.delete(message.id)
      resolve({ result: message.result, error: message.error })
    }
  }

  private failAll(reason: string): void {
    for (const [, resolve] of this.pending) resolve({ error: reason })
    this.pending.clear()
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export const COGNIA_PI_EXTENSION_VERSION = 1

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
  const endpoint = env.COGNIA_TOOLHOST_SOCKET
  const token = env.COGNIA_TOOLHOST_TOKEN
  const server = env.COGNIA_TOOLHOST_SERVER

  // Only the plugin plane is projectable from here: `exec` refuses the
  // built-in plane by design, since built-ins execute inside the MCP bridge.
  const broker =
    endpoint && token && server === "cognia-plugin-tools"
      ? new BrokerClient(endpoint, token, server)
      : undefined

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

  pi.on("session_start", (_event, ctx) => {
    // The adapter watches for this line to confirm interception is live. A
    // session that never sees it is refused rather than run ungated.
    ctx.ui.setStatus(
      "cognia",
      `cognia-ready v${COGNIA_PI_EXTENSION_VERSION} mode=${policy.mode} toolhost=${broker ? "on" : "off"}`
    )
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
    try {
      const decision = policy.decisions[call.toolName] ?? policy.fallback

      if (decision === "allow") {
        // Wait behind any approval the user has not answered. Awaiting the
        // chain rather than joining it, so allowed calls never delay each other.
        await approvals
        return undefined
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
      const approved = await behindApprovals(() =>
        ctx.ui.confirm(
          `${COGNIA_PERMISSION_MARKER} ${JSON.stringify(
            markerPayload(call.toolName, policy.mode, call.input)
          )}`,
          describeCall(call.toolName, call.input)
        )
      )
      return approved ? undefined : { block: true, reason: "Denied by the user" }
    } catch (error) {
      return { block: true, reason: `Cognia permission check failed: ${String(error)}` }
    }
  })

  // Cognia's own tools, relayed to the broker. Registration is best-effort:
  // a host with no tool bridge simply projects nothing, while native-tool
  // interception above stays active regardless.
  if (broker) {
    void registerProjectedTools(pi, broker)
  }
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

/**
 * Project Cognia's PLUGIN tools into Pi.
 *
 * Scope is deliberate. The broker's `exec` only serves the
 * `cognia-plugin-tools` plane: Cognia's built-in tools are executed by the MCP
 * bridge, which carries their real implementations, and this extension has no
 * access to those. Registering built-ins here would advertise tools that
 * cannot run.
 *
 * The tool list comes from the `hello` response's session descriptor — the
 * broker exposes no listing method, and inventing one would fail at runtime.
 */
async function registerProjectedTools(pi: PiExtensionApi, broker: BrokerClient): Promise<void> {
  let descriptor: ToolHostSessionDescriptor | undefined
  try {
    descriptor = await broker.connect()
  } catch {
    // No bridge: native interception above still applies, and the adapter
    // reports the missing tool host through its own capability path.
    return
  }

  for (const tool of descriptor?.hostTools ?? []) {
    if (!tool?.name) continue
    pi.registerTool({
      name: `cognia_${tool.name}`,
      label: tool.name,
      description: tool.description ?? `Cognia tool: ${tool.name}`,
      parameters: tool.jsonSchema ?? { type: "object", properties: {} },
      async execute(_toolCallId, params) {
        // Re-authorized broker-side on every call: holding the token grants
        // nothing on its own, so a leaked token cannot widen access.
        const authorized = await broker.request("authorize", { name: tool.name, args: params })
        const verdict = authorized.result as { allow?: boolean; reason?: string } | undefined
        if (authorized.error || !verdict?.allow) {
          return {
            content: [
              {
                type: "text",
                text: `Denied by Cognia: ${verdict?.reason ?? authorized.error ?? "not allowed"}`,
              },
            ],
          }
        }
        const executed = await broker.request("exec", { name: tool.name, args: params })
        if (executed.error) {
          return { content: [{ type: "text", text: `Cognia tool failed: ${executed.error}` }] }
        }
        return { content: [{ type: "text", text: stringify(executed.result) }] }
      },
    })
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return String(value)
  }
}
