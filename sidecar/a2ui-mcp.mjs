#!/usr/bin/env node
// Stand-alone stdio MCP server for the A2UI bridge.
//
// Spawned by external agents (Claude Code CLI, Cursor, Codex, Gemini, …)
// when they're configured with a `cognia-next` MCP entry pointing at this
// file. The five tools (a2ui_create_surface / a2ui_update_components /
// a2ui_data_model_update / a2ui_delete_surface / a2ui_handle_connector_action)
// speak the same contract as the in-process server in
// `sidecar/a2ui-tools/index.mjs` — both import `tool-defs.mjs` so the schemas
// and the args→dispatch mapping never drift.
//
// Transport: JSON-RPC 2.0 over newline-delimited stdin/stdout, per the
// MCP stdio spec (https://modelcontextprotocol.io/specification/server/stdio).
//
// IPC to the cognia-next renderer (so dispatches reach the Zustand store):
//   On startup, the script attempts to connect to the local socket whose
//   path is supplied via the `COGNIA_BRIDGE_SOCKET` env var. Each successful
//   tool call is forwarded as a single JSON line on that socket. If the
//   socket isn't available (cognia-next not running, sandboxed agent, …),
//   tool calls succeed locally but no surface appears — the agent's
//   ok-response still informs its planning loop. This is on purpose: we
//   want graceful degradation rather than a hard failure that breaks the
//   agent's session.
//
// Logging goes to stderr only — stdout is the MCP protocol channel.

import readline from "node:readline"
import net from "node:net"
import { randomUUID } from "node:crypto"

import { SERVER_NAME, SERVER_VERSION, rawTools, buildDispatch } from "./a2ui-tools/tool-defs.mjs"
import { negotiateProtocolVersion } from "./a2ui-tools/protocol-version.mjs"

const VERSION = SERVER_VERSION

// Tool schemas + the args→dispatch mapping live in the shared tool-defs module
// so this stand-alone server and the in-process SDK server cannot drift.
const TOOLS = rawTools()

// ---- IPC to cognia-next renderer ------------------------------------------

let ipcSocket = null
let ipcReconnectTimer = null

function logStderr(msg) {
  process.stderr.write(`[a2ui-mcp] ${msg}\n`)
}

function connectIpc() {
  const path = process.env.COGNIA_BRIDGE_SOCKET
  if (!path) {
    logStderr("COGNIA_BRIDGE_SOCKET not set — running in detached mode (no UI dispatch)")
    return
  }
  try {
    const sock = net.createConnection(path, () => {
      logStderr(`connected to bridge ${path}`)
    })
    sock.on("error", (err) => {
      logStderr(`bridge error: ${err?.message ?? err}`)
      ipcSocket = null
      scheduleReconnect()
    })
    sock.on("close", () => {
      ipcSocket = null
      scheduleReconnect()
    })
    ipcSocket = sock
  } catch (err) {
    logStderr(`bridge connect threw: ${err?.message ?? err}`)
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  if (ipcReconnectTimer) return
  ipcReconnectTimer = setTimeout(() => {
    ipcReconnectTimer = null
    connectIpc()
  }, 2000)
}

function dispatch(message) {
  if (!ipcSocket) return false
  try {
    ipcSocket.write(JSON.stringify({ type: "a2ui_dispatch", source: "a2ui-mcp", message }) + "\n")
    return true
  } catch (err) {
    logStderr(`dispatch write failed: ${err?.message ?? err}`)
    return false
  }
}

// ---- JSON-RPC core --------------------------------------------------------

function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
}

function sendError(id, code, message, data) {
  const err = { code, message }
  if (data !== undefined) err.data = data
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: err }) + "\n")
}

function handle(req) {
  const { method, id, params } = req
  switch (method) {
    case "initialize": {
      // Echo the client's requested protocol version when supported, else our
      // preferred one — instead of always answering `2024-11-05`. See
      // `a2ui-tools/protocol-version.mjs`.
      sendResponse(id, {
        protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: VERSION },
      })
      return
    }
    case "initialized":
    case "notifications/initialized":
      // No response needed for notifications.
      return
    case "tools/list":
      sendResponse(id, { tools: TOOLS })
      return
    case "tools/call": {
      const name = params?.name
      const args = params?.arguments ?? {}
      const message = buildDispatch(name, args)
      if (!message) {
        sendError(id, -32601, `unknown tool: ${name}`)
        return
      }
      const dispatched = dispatch(message)
      sendResponse(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              surfaceId: args.surfaceId,
              dispatched,
              note: dispatched ? undefined : "running detached; no UI dispatch",
            }),
          },
        ],
      })
      return
    }
    case "ping":
      sendResponse(id, {})
      return
    default:
      sendError(id, -32601, `method not found: ${method}`)
  }
}

// ---- Boot -----------------------------------------------------------------

connectIpc()

const rl = readline.createInterface({ input: process.stdin })
rl.on("line", (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let req
  try {
    req = JSON.parse(trimmed)
  } catch (err) {
    logStderr(`bad JSON: ${err?.message ?? err}`)
    return
  }
  if (req.jsonrpc !== "2.0") return
  try {
    handle(req)
  } catch (err) {
    sendError(req.id ?? null, -32603, `internal error: ${err?.message ?? err}`)
  }
})
rl.on("close", () => {
  if (ipcSocket) {
    try {
      ipcSocket.end()
    } catch {
      /* noop */
    }
  }
  process.exit(0)
})

// Stable session marker for diagnostics.
process.env.A2UI_MCP_SESSION = randomUUID()
