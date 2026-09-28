import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { ToolSessionSendOptions } from "../../tools/session.ts"
import type { StdioInput, StdioOutput } from "../stdio-server.ts"
import type { BrokerConnection, BrokerConnector } from "../client/broker.ts"
import { connectBroker } from "../client/broker.ts"
import { createMcpStdioServer } from "../stdio-server.ts"
export { connectBroker, createMcpStdioServer }
export interface BridgeSession {
  sessionId?: string
  cwd?: string
  model?: string
  provider?: string
  lsp?: ToolSessionSendOptions["lsp"]
  codeGraph?: ToolSessionSendOptions["codeGraph"]
  enabledCategories?: Record<string, boolean>
  visibleBuiltinTools?: string[]
  hostTools?: { name: string; description: string; jsonSchema?: unknown }[]
  toolExecutionTimeoutMs?: number
  maxToolResultTokens?: number
}
export interface BridgeTool {
  name: string
  description: string
  inputSchema: object
  run(args: Record<string, unknown>): Promise<CallToolResult>
}
import { createToolSessionContext } from "../../tools/session.ts"
// Cognia tool-host MCP bridge.
//
// The external agent (Codex / Claude Code / any ACP agent) spawns this as an
// ordinary stdio MCP server. It advertises Cognia's OWN tools — the same
// `cognia-tools` built-ins the sidecar registers for the built-in backend, and
// the same `cognia-plugin-tools` host surface (plugins, web tools, `ask_user`,
// `load_skill`, `dispatch_agent`) — so switching backends no longer takes the
// agent's tools away.
//
// It is deliberately NOT trusted:
//   * the tool list, the workspace roots and the policy come from Cognia over
//     an authenticated local socket, not from the agent;
//   * every call is authorized by Cognia BEFORE it runs, so confinement and the
//     approval overlay stay on Cognia's side of the line;
//   * host/plugin tools are not run here at all — they are executed by Cognia,
//     because their handlers live in the CLI process (plugin runtime, TUI
//     elicitation overlay, subagent dispatch).
//
// This file lives in the sidecar bundle because that is where the real tool
// definitions and handlers already are. Reimplementing them CLI-side would have
// meant a second schema source and a second set of handlers.

import { assertModelSafeToolOutput } from "../../policy/pii/tool-output.ts"

import { collectCogniaToolDefs } from "../../tools/builtin/registry.ts"
import { READ_ONLY_TOOL_NAMES } from "../../policy/tool-catalog/catalog.ts"
import { MONITOR_TOOL_NAMES } from "../../tools/builtin/core-files/monitor.ts"
import {
  DEFAULT_BUILTIN_TOOL_TIMEOUT_MS,
  wrapDefsWithReadOnlyTimeout,
} from "../../tools/middleware/read-only-timeout.ts"
import { wrapDefsWithResultCap } from "../../tools/middleware/result-cap.ts"
import { parseToolArgs, toolInputJsonSchema } from "../../tools/kernel/args.ts"

const COGNIA_TOOLS_SERVER = "cognia-tools"
const COGNIA_PLUGIN_TOOLS_SERVER = "cognia-plugin-tools"

// Schema conversion + argument validation are shared with the `run_code` broker
// in `src/tools/builtin/registry.ts`, which reaches the same defs by a different
// route. Re-exported here so this module stays the bridge's whole surface.
export { parseToolArgs, toolInputJsonSchema }

/** Flatten an SDK tool result into the MCP content shape. */
export function toMcpContent(result: unknown): CallToolResult {
  const value = result as CallToolResult | null | undefined
  if (value && Array.isArray(value.content)) {
    return {
      content: value.content.map((block) =>
        block && block.type === "text" ? { type: "text", text: String(block.text ?? "") } : block
      ),
      ...(value.isError ? { isError: true } : {}),
    }
  }
  const text = typeof result === "string" ? result : JSON.stringify(result ?? null)
  return { content: [{ type: "text", text }] }
}

/** Compact preview reported back to Cognia for the TUI tool cell. */
function summarize(result: CallToolResult) {
  const first = result?.content?.[0]
  const text = first && first.type === "text" ? String(first.text ?? "") : ""
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}

/**
 * Build the tool surface for this bridge.
 *
 * `cognia-tools` builds the real built-in definitions locally (their handlers
 * need process-local state: a read tracker, background shells, a task store) and
 * filters them to the names Cognia said are visible. `cognia-plugin-tools`
 * advertises Cognia's manifest and executes nothing — every call goes back over
 * the socket.
 */
export function buildToolSurface(
  serverName: string,
  session: BridgeSession,
  broker: Pick<BrokerConnection, "call">
): BridgeTool[] {
  if (serverName === COGNIA_PLUGIN_TOOLS_SERVER) {
    return session.hostTools!.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema:
        tool.jsonSchema && typeof tool.jsonSchema === "object"
          ? tool.jsonSchema
          : { type: "object", properties: {} },
      async run(args: Record<string, unknown>): Promise<CallToolResult> {
        // Host execution authorizes inside the broker before invoking the handler.
        // A separate authorize call would ask twice for the same operation.
        const outcome = await broker.call("exec", { name: tool.name, args })
        if (outcome && outcome.error) {
          return toMcpContent(
            assertModelSafeToolOutput({
              content: [{ type: "text", text: `Error: ${outcome.error}` }],
              isError: true,
            })
          )
        }
        return toMcpContent(assertModelSafeToolOutput(outcome?.result ?? null))
      },
    }))
  }

  const visible = new Set(session.visibleBuiltinTools)
  const log = (level: string, message: string) =>
    process.stderr.write(`[cognia-tool-bridge:${level}] ${message}\n`)
  const toolSendOptions = {
    cwd: session.cwd,
    builtinTools: session.enabledCategories,
    ...(session.lsp ? { lsp: session.lsp } : {}),
    ...(session.codeGraph ? { codeGraph: session.codeGraph } : {}),
  }
  const toolSession = createToolSessionContext({
    sendOptions: toolSendOptions,
    log,
    sessionId: session.sessionId!,
  })
  const defs = collectCogniaToolDefs({
    enabled: session.enabledCategories,
    ...toolSession.toolContext(),
    cwd: session.cwd,
    // The bridge is neither the Anthropic SDK nor the ai-sdk loop: it wants the
    // full tool surface (including coreFiles, which the Anthropic path suppresses
    // in favour of the SDK's own file tools) but must not register the ai-sdk
    // -only `ExitPlanMode` duplicate — so the dispatch path stays unset.
    model: session.model,
    provider: session.provider,
    // Available on the descriptor and previously dropped. No `hostRpc` exists
    // here (the bridge is a separate process reached over a hello/authorize/
    // exec/report broker), so anything keyed on it still degrades — but the id
    // itself should not be silently lost.
    sessionId: session.sessionId!,
  })
  const timeout =
    typeof session.toolExecutionTimeoutMs === "number"
      ? session.toolExecutionTimeoutMs
      : DEFAULT_BUILTIN_TOOL_TIMEOUT_MS
  const guarded = wrapDefsWithResultCap(
    wrapDefsWithReadOnlyTimeout(defs, timeout, READ_ONLY_TOOL_NAMES),
    session.maxToolResultTokens
  )
  return (
    guarded
      .filter((def) => visible.has(def.name))
      // Never advertise a tool that cannot possibly work here. The Monitor family
      // is backed by the Rust job supervisor over `host_rpc`, which this process
      // has no channel to, so all three returned "monitors are not available in
      // this session" on every call while still appearing in `tools/list`.
      // `visibleBuiltinTools` is computed host-side and has no notion of runtime
      // availability, so the filter has to live here.
      .filter((def) => !MONITOR_TOOL_NAMES.includes(def.name))
      .map((def) => ({
        name: def.name,
        description: def.description ?? "",
        inputSchema: toolInputJsonSchema(def.inputSchema),
        async run(args: Record<string, unknown>): Promise<CallToolResult> {
          // Cognia decides FIRST. The bridge never infers permission from the
          // agent's own approval — that governs the agent's tools, not Cognia's.
          // Authorisation deliberately precedes validation: a refused caller must
          // not be able to probe the schema, and the permission decision must not
          // be preemptable by an argument error.
          const verdict = await broker.call("authorize", { name: def.name, args })
          if (!verdict.allow) {
            return { content: [{ type: "text", text: `Error: ${verdict.reason}` }], isError: true }
          }
          // Only then validate + normalise, so the handler receives the same
          // parsed shape it would get on the Anthropic and ai-sdk rails.
          const effectiveArgs = verdict.updatedArgs ?? args
          const parsed = parseToolArgs(def.inputSchema, effectiveArgs)
          let result: CallToolResult
          if (!parsed.ok) {
            // Falls through to the report below rather than returning early: a
            // rejected call is still a tool OUTCOME and must render in the TUI
            // and land in the audit trail exactly like an execution failure.
            result = {
              content: [{ type: "text", text: `Error: invalid arguments — ${parsed.message}` }],
              isError: true,
            }
          } else {
            try {
              result = toMcpContent(await def.handler(parsed.value, {}))
            } catch (err) {
              result = {
                content: [
                  {
                    type: "text",
                    text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                  },
                ],
                isError: true,
              }
            }
          }
          // Review in the Cognia host before any content is returned to the model.
          const reviewed = await broker.call("review", {
            name: def.name,
            args: effectiveArgs,
            result,
          })
          result = toMcpContent(assertModelSafeToolOutput(reviewed.result))
          // Report so the call renders in the TUI and lands in the audit trail
          // exactly like a built-in one. Best-effort: a failed report must not
          // turn a successful tool call into an error.
          await broker
            .call("report", { name: def.name, ok: !result.isError, summary: summarize(result) })
            .catch(() => undefined)
          return result
        },
      }))
  )
}

/** Wire the bridge end to end. Exported so the entry stays trivial to test. */
export async function runToolBridge({
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  connect,
}: {
  env?: NodeJS.ProcessEnv
  input?: StdioInput
  output?: StdioOutput
  connect?: BrokerConnector
} = {}) {
  const socketPath = env.COGNIA_TOOLHOST_SOCKET
  const token = env.COGNIA_TOOLHOST_TOKEN
  const serverName = env.COGNIA_TOOLHOST_SERVER ?? COGNIA_TOOLS_SERVER
  if (!socketPath || !token) {
    throw new Error("cognia tool bridge: missing COGNIA_TOOLHOST_SOCKET / _TOKEN")
  }
  const broker = connectBroker(socketPath, connect ? { connect } : {})
  await broker.ready()
  const hello = await broker.call("hello", { token, server: serverName })
  const tools = buildToolSurface(serverName, hello.session as BridgeSession, broker)
  createMcpStdioServer({ serverName, tools, input, output })
  return { broker, tools }
}
