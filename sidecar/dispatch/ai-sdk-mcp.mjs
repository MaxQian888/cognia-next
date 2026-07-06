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
 * Each connection gets up to `maxAttempts` tries (default 3) with exponential
 * backoff — remote MCP endpoints and npx-installed stdio servers are frequently
 * cold on first hit — and each attempt is capped by `connectTimeoutMs` so a
 * hung connect can't stall the turn. Results merge in input order for a
 * deterministic tool map. OAuth is already applied upstream: `resolveSendOptions`
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
 *   retryDelayMs?: number,                           // base backoff (doubles per retry)
 *   maxAttempts?: number,                             // total connect attempts per server
 *   connectTimeoutMs?: number,                        // per-attempt connect cap (0 = none)
 * }} params
 * @returns {Promise<{ tools: Record<string, any>, close: () => Promise<void> }>}
 */
export async function buildAiSdkMcpTools({
  mcpServers,
  gate,
  reviewToolOutput,
  allowedTools,
  disallowedTools,
  log,
  emitMcpLog,
  createClient,
  StdioTransport,
  retryDelayMs = 200,
  maxAttempts = 3,
  connectTimeoutMs = 15_000,
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
   * One connect attempt, capped by `connectTimeoutMs`. A connect that resolves
   * AFTER the timeout fired is closed immediately — the abandoned client would
   * otherwise leak a socket / child process for the rest of the session.
   */
  const connectOnce = (transport) => {
    if (!connectTimeoutMs || connectTimeoutMs <= 0) return make({ transport })
    return new Promise((resolve, reject) => {
      let done = false
      const timer = setTimeout(() => {
        done = true
        reject(new Error(`connect timed out after ${connectTimeoutMs}ms`))
      }, connectTimeoutMs)
      make({ transport }).then(
        (client) => {
          if (done) {
            // Late winner of a lost race — tear it down, best-effort.
            void Promise.resolve(client?.close?.()).catch(() => undefined)
            return
          }
          clearTimeout(timer)
          resolve(client)
        },
        (err) => {
          if (done) return
          clearTimeout(timer)
          reject(err)
        }
      )
    })
  }

  /**
   * Connect one server (up to `maxAttempts` tries with exponential backoff),
   * returning its client, namespaced/gated tools, and any stderr capture — or
   * `null` when the server can't be reached / has an unsupported transport. A
   * fresh transport (and capture) is built per attempt: a spawned stdio
   * transport that failed to connect can't be reused, and its stderr stream
   * must be torn down.
   */
  const connectServer = async (server, entry) => {
    const isStdio = entry?.type === "stdio"
    const attempts = Math.max(1, maxAttempts)
    let client = null
    let capture = null
    for (let attempt = 0; attempt < attempts && !client; attempt++) {
      // Exponential backoff: retryDelayMs, 2×, 4×, …
      if (attempt > 0 && retryDelayMs > 0) await sleep(retryDelayMs * 2 ** (attempt - 1))
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
        client = await connectOnce(transport)
        capture = thisCapture
      } catch (err) {
        thisCapture?.end()
        thisCapture?.stream.destroy()
        if (attempt === attempts - 1) {
          log?.("warn", `mcp "${server}" failed to connect: ${err?.message ?? err}`)
          diag(server, "warn", `failed to connect: ${err?.message ?? err}`)
          return null
        }
        diag(
          server,
          "info",
          `connect attempt ${attempt + 1}/${attempts} failed (${err?.message ?? err}) — retrying`
        )
      }
    }
    let serverTools
    try {
      // Same deadline as connect: a server that connected but never answers
      // `tools/list` (cold remote, wedged stdio child) must not stall the
      // first turn indefinitely.
      serverTools =
        connectTimeoutMs && connectTimeoutMs > 0
          ? await Promise.race([
              client.tools(),
              new Promise((_, reject) => {
                const t = setTimeout(
                  () => reject(new Error(`tools() timed out after ${connectTimeoutMs}ms`)),
                  connectTimeoutMs
                )
                if (typeof t.unref === "function") t.unref()
              }),
            ])
          : await client.tools()
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
      collected[namespaced] = wrapMcpToolWithGate(toolDef, namespaced, gate, reviewToolOutput)
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
export function wrapMcpToolWithGate(toolDef, namespaced, gate, reviewToolOutput) {
  if ((!gate && !reviewToolOutput) || !toolDef || typeof toolDef.execute !== "function") {
    return toolDef
  }
  const originalExecute = toolDef.execute.bind(toolDef)
  const review = async (toolCallId, output, isError) => {
    if (typeof reviewToolOutput !== "function") return output
    try {
      const updated = await reviewToolOutput(namespaced, toolCallId, output, isError)
      return updated === undefined || updated === null ? output : updated
    } catch {
      return output // fail-open: a broken reviewer never loses a tool result
    }
  }
  return {
    ...toolDef,
    execute: async (args, options) => {
      const effective = gate
        ? await gate(namespaced, args ?? {}, options?.abortSignal)
        : (args ?? {})
      let out
      try {
        out = await originalExecute(effective, options)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const reviewed = await review(options?.toolCallId, msg, true)
        throw reviewed === msg ? err : new Error(String(reviewed))
      }
      // Rewrite at the EXECUTE layer so the model actually sees the reviewed
      // output (a fullStream-level rewrite is display-only).
      return review(options?.toolCallId, out, false)
    },
  }
}

export const __testing__ = { isMcpToolPermitted, resolveForToolCall }
