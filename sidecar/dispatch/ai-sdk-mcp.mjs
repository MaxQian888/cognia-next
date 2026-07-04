// External MCP-server bridge for the non-Anthropic dispatch path.
//
// The Anthropic dispatcher hands user-configured `mcpServers` straight to the
// Claude Agent SDK, which spawns/connects them and exposes their tools to the
// model. `streamText` has no such concept, so the AI-SDK path previously
// IGNORED `sendOptions.mcpServers` entirely — external MCP servers were
// unreachable for every non-Anthropic provider (the single biggest silent
// capability drop for power users).
//
// This module closes that gap: for each configured server it opens an AI SDK
// MCP client (stdio / sse / http), fetches its tool set, namespaces each tool
// as `mcp__<server>__<tool>` (matching the Anthropic path + the permission
// ruleset conventions), runs execution through the SAME permission gate, and
// honours the allow/deny tool filters. Connections are opened once per session
// and closed via the returned `close()`.

import { PassThrough } from "node:stream"

import { createMCPClient } from "@ai-sdk/mcp"
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio"

import { resolveForToolCall } from "./permission-resolver.mjs"
import { createLineBuffer, classifyMcpLogLine } from "./mcp-log.mjs"

/**
 * Build an AI SDK MCP transport (instance or config) from a Claude-Agent-SDK-
 * shaped server entry: `{ type: "stdio"|"sse"|"http", ...config }`. stdio
 * carries `command`/`args`/`env`/`cwd`; sse/http carry `url`/`headers`.
 * Returns null for an unsupported or incompletely-specified entry.
 */
export function toMcpTransport(
  entry,
  { StdioTransport = Experimental_StdioMCPTransport, stderr } = {}
) {
  const type = entry?.type
  if (type === "stdio") {
    if (typeof entry.command !== "string" || !entry.command) return null
    return new StdioTransport({
      command: entry.command,
      ...(Array.isArray(entry.args) ? { args: entry.args } : {}),
      ...(entry.env && typeof entry.env === "object" ? { env: entry.env } : {}),
      ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
      // Redirect the spawned server's stderr into a stream we read line-by-line
      // (@ai-sdk/mcp StdioConfig.stderr accepts a Stream) so its diagnostics
      // reach the MCP log panel instead of being discarded.
      ...(stderr ? { stderr } : {}),
    })
  }
  if (type === "sse" || type === "http") {
    if (typeof entry.url !== "string" || !entry.url) return null
    return {
      type,
      url: entry.url,
      ...(entry.headers && typeof entry.headers === "object" ? { headers: entry.headers } : {}),
    }
  }
  return null
}

/**
 * Decide whether a namespaced MCP tool (`mcp__<server>__<tool>`) is exposed,
 * given the allow/deny lists. Deny wins. An empty allow list means "no
 * restriction". A whole-server allow (`mcp__<server>`) admits all of its tools.
 */
function isMcpToolPermitted(namespaced, server, allowSet, disallowedSet) {
  if (disallowedSet.has(namespaced) || disallowedSet.has(`mcp__${server}`)) return false
  if (!allowSet || allowSet.size === 0) return true
  return allowSet.has(namespaced) || allowSet.has(`mcp__${server}`)
}

/**
 * Open every configured external MCP server, collect its tools, and return a
 * namespaced + gated AI SDK tools map plus a `close()` that disconnects all
 * clients. A server that can't be built/connected, or whose `tools()` rejects,
 * is logged and skipped — one bad server never breaks the turn.
 *
 * Servers are connected CONCURRENTLY (previously serial), so a slow or cold
 * remote MCP endpoint no longer blocks the others from being ready for the turn.
 * Each connection gets ONE retry with a short backoff — remote MCP endpoints are
 * frequently cold on first hit. Results merge in input order for a deterministic
 * tool map. OAuth is already applied upstream: `resolveSendOptions`
 * (`build-options.ts`) injects the bearer token into each server's
 * `headers.Authorization`, which `toMcpTransport` forwards verbatim.
 *
 * @param {{
 *   mcpServers: Record<string, Record<string, any>> | undefined,
 *   gate?: (toolName: string, input: any) => Promise<any>,
 *   allowedTools?: string[],
 *   disallowedTools?: string[],
 *   log?: (level: "info"|"warn"|"error", message: string) => void,
 *   emitMcpLog?: (entry: { level: "error"|"warn"|"info"|"debug", message: string, server?: string, source?: "stderr"|"diagnostic" }) => void,
 *   createClient?: (config: any) => Promise<any>,   // injected in tests
 *   StdioTransport?: any,                            // injected in tests
 *   retryDelayMs?: number,                           // backoff before the 1 retry
 * }} params
 * @returns {Promise<{ tools: Record<string, any>, close: () => Promise<void> }>}
 */
export async function buildAiSdkMcpTools({
  mcpServers,
  gate,
  allowedTools,
  disallowedTools,
  log,
  emitMcpLog,
  createClient,
  StdioTransport,
  retryDelayMs = 200,
}) {
  /** @type {Record<string, any>} */
  const tools = {}
  /** @type {Array<{ close: () => Promise<void> }>} */
  const clients = []
  /** @type {Array<{ end: () => void, stream: import("node:stream").PassThrough }>} */
  const captures = []
  const close = async () => {
    for (const c of clients) {
      try {
        await c.close()
      } catch {
        // best-effort teardown — a failed close shouldn't crash session end.
      }
    }
    // Flush each stderr sink's trailing partial line, then tear down the stream.
    for (const cap of captures) {
      try {
        cap.end()
      } catch {
        // ignore — flushing a dead sink shouldn't crash session end.
      }
      try {
        cap.stream.destroy()
      } catch {
        // ignore
      }
    }
  }
  if (!mcpServers || typeof mcpServers !== "object") return { tools, close }

  const make = createClient ?? createMCPClient
  const allowSet =
    Array.isArray(allowedTools) && allowedTools.length > 0 ? new Set(allowedTools) : null
  const disallowedSet = new Set(Array.isArray(disallowedTools) ? disallowedTools : [])
  const buildTransport = (entry, stderr) =>
    toMcpTransport(entry, {
      ...(StdioTransport ? { StdioTransport } : {}),
      ...(stderr ? { stderr } : {}),
    })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // Structured diagnostic → MCP log panel (in addition to the free-text `log`
  // channel, which is kept for backward-compatible stderr-of-the-sidecar).
  const diag = (server, level, message) =>
    emitMcpLog?.({ level, message, server, source: "diagnostic" })

  /**
   * Build a stderr capture for a stdio server: a PassThrough wired as the
   * child's stderr, read line-by-line into `mcp_log` diagnostics tagged with
   * the server name. Returns null when no `emitMcpLog` sink is supplied (tests /
   * headless paths that don't surface logs) so no stream is spawned needlessly.
   */
  const makeStderrCapture = (server) => {
    if (typeof emitMcpLog !== "function") return null
    const stream = new PassThrough()
    const buffer = createLineBuffer()
    const emitLines = (lines) => {
      for (const line of lines) {
        const { level, server: parsed, message } = classifyMcpLogLine(line, { knownServer: server })
        try {
          emitMcpLog({ level, message, server: parsed ?? server, source: "stderr" })
        } catch {
          // never let a downstream emit failure fault the stderr pump
        }
      }
    }
    stream.on("data", (chunk) => emitLines(buffer.push(chunk.toString())))
    stream.on("error", () => undefined) // a broken pipe must not crash the turn
    return { stream, end: () => emitLines(buffer.flush()) }
  }

  /**
   * Connect one server (one retry on connect failure), returning its client,
   * namespaced/gated tools, and any stderr capture — or `null` when the server
   * can't be reached / has an unsupported transport. A fresh transport (and
   * capture) is built per attempt: a spawned stdio transport that failed to
   * connect can't be reused, and its stderr stream must be torn down.
   */
  const connectServer = async (server, entry) => {
    const isStdio = entry?.type === "stdio"
    let client = null
    let capture = null
    for (let attempt = 0; attempt < 2 && !client; attempt++) {
      if (attempt > 0 && retryDelayMs > 0) await sleep(retryDelayMs)
      const thisCapture = isStdio ? makeStderrCapture(server) : null
      const transport = buildTransport(entry, thisCapture?.stream)
      if (!transport) {
        // Unsupported/incomplete config — no point retrying.
        thisCapture?.end()
        thisCapture?.stream.destroy()
        log?.("warn", `mcp "${server}": unsupported or incomplete transport config, skipped`)
        diag(server, "warn", "unsupported or incomplete transport config, skipped")
        return null
      }
      try {
        client = await make({ transport })
        capture = thisCapture
      } catch (err) {
        thisCapture?.end()
        thisCapture?.stream.destroy()
        if (attempt === 1) {
          log?.("warn", `mcp "${server}" failed to connect: ${err?.message ?? err}`)
          diag(server, "warn", `failed to connect: ${err?.message ?? err}`)
          return null
        }
      }
    }
    let serverTools
    try {
      serverTools = await client.tools()
    } catch (err) {
      log?.("warn", `mcp "${server}" tools() failed: ${err?.message ?? err}`)
      diag(server, "warn", `tools() failed: ${err?.message ?? err}`)
      // Keep the client + capture so `close()` still disconnects/flushes them.
      return { client, tools: {}, capture }
    }
    /** @type {Record<string, any>} */
    const collected = {}
    for (const [toolName, toolDef] of Object.entries(serverTools ?? {})) {
      const namespaced = `mcp__${server}__${toolName}`
      if (!isMcpToolPermitted(namespaced, server, allowSet, disallowedSet)) continue
      collected[namespaced] = wrapMcpToolWithGate(toolDef, namespaced, gate)
    }
    diag(server, "info", `connected · ${Object.keys(collected).length} tool(s) exposed`)
    return { client, tools: collected, capture }
  }

  // Connect every server concurrently; merge in input order so the tool map is
  // deterministic. `allSettled` + null-skip keeps one bad server from breaking
  // the turn.
  const settled = await Promise.allSettled(
    Object.entries(mcpServers).map(([server, entry]) => connectServer(server, entry))
  )
  for (const r of settled) {
    if (r.status !== "fulfilled" || !r.value) continue
    if (r.value.client) clients.push(r.value.client)
    if (r.value.capture) captures.push(r.value.capture)
    Object.assign(tools, r.value.tools)
  }

  return { tools, close }
}

/**
 * Wrap an AI SDK MCP tool so its `execute` first passes the permission gate
 * (mirroring the built-in / plugin tool gating). The gate throws on deny and
 * may rewrite the input; all other tool fields (description / inputSchema) are
 * preserved. When no gate is supplied the tool is returned unchanged.
 */
export function wrapMcpToolWithGate(toolDef, namespaced, gate) {
  if (!gate || !toolDef || typeof toolDef.execute !== "function") return toolDef
  const originalExecute = toolDef.execute.bind(toolDef)
  return {
    ...toolDef,
    execute: async (args, options) => {
      const effective = await gate(namespaced, args ?? {})
      return originalExecute(effective, options)
    },
  }
}

export const __testing__ = { isMcpToolPermitted, resolveForToolCall }
