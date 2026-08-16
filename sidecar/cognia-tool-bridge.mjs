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

import net from "node:net"
import { pathToFileURL } from "node:url"

import { collectCogniaToolDefs, READ_ONLY_TOOL_NAMES } from "./builtin-tools/index.mjs"
import { createReadTracker } from "./builtin-tools/core/read-tracker.mjs"
import { createBgShellRegistry } from "./builtin-tools/core/bash-sessions.mjs"
import { createSessionTaskStore } from "./builtin-tools/core/tasks.mjs"
import { MONITOR_TOOL_NAMES } from "./builtin-tools/core/monitor.mjs"
import {
  DEFAULT_BUILTIN_TOOL_TIMEOUT_MS,
  wrapDefsWithReadOnlyTimeout,
} from "./builtin-tools/read-only-timeout.mjs"
import { wrapDefsWithResultCap } from "./builtin-tools/result-cap.mjs"
import { parseToolArgs, toolInputJsonSchema } from "./builtin-tools/tool-args.mjs"
import { makeLazyLspResolver } from "./dispatch/lsp-resolver-factory.mjs"
import { makeLazyCodeGraphResolver } from "./dispatch/codegraph-resolver-factory.mjs"

const COGNIA_TOOLS_SERVER = "cognia-tools"
const COGNIA_PLUGIN_TOOLS_SERVER = "cognia-plugin-tools"
const PROTOCOL_VERSION = "2025-06-18"

/** Connect to the Cognia broker and expose a request/response helper. */
export function connectBroker(socketPath, { connect = net.connect } = {}) {
  const socket = connect(socketPath)
  socket.setEncoding("utf8")
  const pending = new Map()
  let nextId = 0
  let buffer = ""
  let fatal = null

  const failAll = (reason) => {
    fatal = fatal ?? reason
    for (const [, entry] of pending) entry.reject(new Error(reason))
    pending.clear()
  }

  socket.on("data", (chunk) => {
    buffer += chunk
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        failAll("cognia tool host sent a malformed frame")
        socket.destroy()
        return
      }
      const entry = pending.get(message.id)
      if (!entry) continue
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error))
      else entry.resolve(message.result)
    }
  })
  socket.on("error", (err) => failAll(`cognia tool host unreachable: ${err.message}`))
  socket.on("close", () => failAll("cognia tool host closed the connection"))

  return {
    socket,
    ready: () =>
      new Promise((resolve, reject) => {
        if (socket.readyState === "open") return resolve()
        socket.once("connect", resolve)
        socket.once("error", reject)
      }),
    call(method, params) {
      if (fatal) return Promise.reject(new Error(fatal))
      const id = ++nextId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        socket.write(`${JSON.stringify({ id, method, params })}\n`)
      })
    },
    close() {
      failAll("cognia tool host connection closed")
      socket.destroy()
    },
  }
}

// Schema conversion + argument validation are shared with the `run_code` broker
// in `builtin-tools/index.mjs`, which reaches the same defs by a different
// route. Re-exported here so this module stays the bridge's whole surface.
export { parseToolArgs, toolInputJsonSchema }

/** Flatten an SDK tool result into the MCP content shape. */
export function toMcpContent(result) {
  if (result && Array.isArray(result.content)) {
    return {
      content: result.content.map((block) =>
        block && block.type === "text" ? { type: "text", text: String(block.text ?? "") } : block
      ),
      ...(result.isError ? { isError: true } : {}),
    }
  }
  const text = typeof result === "string" ? result : JSON.stringify(result ?? null)
  return { content: [{ type: "text", text }] }
}

/** Compact preview reported back to Cognia for the TUI tool cell. */
function summarize(result) {
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
export function buildToolSurface(serverName, session, broker) {
  if (serverName === COGNIA_PLUGIN_TOOLS_SERVER) {
    return session.hostTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema:
        tool.jsonSchema && typeof tool.jsonSchema === "object"
          ? tool.jsonSchema
          : { type: "object", properties: {} },
      async run(args) {
        const verdict = await broker.call("authorize", { name: tool.name, args })
        if (!verdict.allow) {
          return { content: [{ type: "text", text: `Error: ${verdict.reason}` }], isError: true }
        }
        const outcome = await broker.call("exec", { name: tool.name, args })
        if (outcome && outcome.error) {
          return { content: [{ type: "text", text: `Error: ${outcome.error}` }], isError: true }
        }
        return toMcpContent(outcome?.result ?? null)
      },
    }))
  }

  const visible = new Set(session.visibleBuiltinTools)
  const readTracker = createReadTracker()
  // Per-session state the resolver-bound categories need. Background shells and
  // the task graph live for this bridge process, so `bash run_in_background`,
  // `bash_output` and the TaskCreate/Update suite behave as they do on the
  // built-in backend instead of silently missing.
  const bgShells = createBgShellRegistry()
  const taskStore = createSessionTaskStore()
  const log = (level, message) => process.stderr.write(`[cognia-tool-bridge:${level}] ${message}\n`)
  // Rebuild the SAME resolver factories the sidecar dispatch paths use, so
  // `lsp_*` and the code-graph tools reach an external agent whenever their
  // runtime dependencies are constructible — and degrade the same way when not.
  const toolSendOptions = {
    cwd: session.cwd,
    builtinTools: session.enabledCategories,
    ...(session.lsp ? { lsp: session.lsp } : {}),
    ...(session.codeGraph ? { codeGraph: session.codeGraph } : {}),
  }
  const lsp = makeLazyLspResolver({ sendOptions: toolSendOptions, log })
  const codeGraph = makeLazyCodeGraphResolver({ sendOptions: toolSendOptions, log })
  const defs = collectCogniaToolDefs({
    enabled: session.enabledCategories,
    lspResolver: lsp.lspResolver,
    codeGraphResolver: codeGraph.codeGraphResolver,
    readTracker,
    taskStore,
    bgShells,
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
    sessionId: session.sessionId,
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
        async run(args) {
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
          const parsed = parseToolArgs(def.inputSchema, args)
          let result
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
                content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }],
                isError: true,
              }
            }
          }
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

/** Minimal MCP stdio server: JSON-RPC 2.0, newline framed. */
export function createMcpStdioServer({ serverName, tools, input, output }) {
  const byName = new Map(tools.map((t) => [t.name, t]))
  let buffer = ""

  const write = (message) => output.write(`${JSON.stringify(message)}\n`)
  const respond = (id, result) => write({ jsonrpc: "2.0", id, result })
  const fail = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } })

  async function handle(request) {
    // A notification (no id) never gets a reply — answering one is a protocol
    // error that some clients treat as fatal.
    const { id, method, params } = request
    if (id === undefined || id === null) return
    switch (method) {
      case "initialize":
        respond(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: serverName, version: "1.0.0" },
        })
        return
      case "ping":
        respond(id, {})
        return
      case "tools/list":
        respond(id, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        })
        return
      case "tools/call": {
        const tool = byName.get(params?.name)
        if (!tool) {
          respond(id, {
            content: [{ type: "text", text: `Error: unknown tool "${params?.name}"` }],
            isError: true,
          })
          return
        }
        try {
          respond(id, await tool.run(params?.arguments ?? {}))
        } catch (err) {
          // A transport fault (Cognia gone) must surface as a tool error, not a
          // JSON-RPC error, so the agent can keep the turn and report it.
          respond(id, {
            content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }],
            isError: true,
          })
        }
        return
      }
      default:
        fail(id, -32601, `method not found: ${method}`)
    }
  }

  input.setEncoding("utf8")
  input.on("data", (chunk) => {
    buffer += chunk
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      let request
      try {
        request = JSON.parse(line)
      } catch {
        fail(null, -32700, "parse error")
        continue
      }
      void handle(request)
    }
  })

  return { handle }
}

/** Wire the bridge end to end. Exported so the entry stays trivial to test. */
export async function runToolBridge({
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  connect,
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
  const tools = buildToolSurface(serverName, hello.session, broker)
  createMcpStdioServer({ serverName, tools, input, output })
  return { broker, tools }
}

// Auto-run when spawned as the process entry (directly, or via the packaged
// binary's `COGNIA_ROLE=tool-bridge` self-exec). Skipped when imported by tests.
const isEntryPoint = (() => {
  try {
    if (process.env.COGNIA_ROLE === "tool-bridge") return true
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href
  } catch {
    return false
  }
})()

if (isEntryPoint) {
  runToolBridge().catch((err) => {
    process.stderr.write(`cognia-tool-bridge: fatal: ${err?.message ?? err}\n`)
    process.exit(1)
  })
}
