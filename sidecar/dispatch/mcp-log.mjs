// Pure helpers for capturing + classifying MCP-server output logs.
//
// Two dispatch paths spawn MCP servers whose diagnostic output was previously
// lost (the Anthropic path never wired the SDK `stderr` callback; the ai-sdk
// path never read the stdio child's stderr). These helpers turn a raw stderr
// byte stream into structured `mcp_log` events the renderer's MCP log panel
// renders. Kept I/O-free so `pnpm sidecar:test` covers the buffering + parsing.

/**
 * Incremental line buffer for a chunked stderr stream. `push(chunk)` returns the
 * complete lines contained so far; a trailing partial line is held until the
 * next chunk completes it. `flush()` returns any held remainder (used at close
 * so the final unterminated line isn't dropped).
 *
 * @returns {{ push: (chunk: string) => string[], flush: () => string[] }}
 */
export function createLineBuffer() {
  let held = ""
  return {
    push(chunk) {
      held += typeof chunk === "string" ? chunk : String(chunk ?? "")
      // Normalise CRLF so a Windows child doesn't leave stray \r on each line.
      const normalised = held.replace(/\r\n/g, "\n")
      const parts = normalised.split("\n")
      held = parts.pop() ?? ""
      return parts.filter((l) => l.length > 0)
    },
    flush() {
      const rest = held.replace(/\r$/, "").trim()
      held = ""
      return rest.length > 0 ? [rest] : []
    },
  }
}

/** Log levels, most→least severe. Mirrors the renderer `McpLogLevel`. */
export const MCP_LOG_LEVELS = ["error", "warn", "info", "debug"]

/**
 * Every bracketed word `inferLevel` treats as a severity, so `extractServerName`
 * doesn't mistake `[FATAL]` / `[verbose]` / `[notice]` for a server name (which
 * would spawn a phantom server in the panel and mis-attribute the line).
 */
const LOG_LEVEL_WORDS = new Set([
  "error",
  "err",
  "fatal",
  "panic",
  "warn",
  "warning",
  "debug",
  "trace",
  "verbose",
  "info",
  "notice",
  "log",
])

/**
 * Infer a log level from a raw line. Recognises the common `[LEVEL]`, `LEVEL:`,
 * and bare-word conventions MCP servers and the claude-code CLI emit. Defaults
 * to `info` so uncategorised output is still visible (not silently dropped).
 *
 * @param {string} line
 * @returns {"error"|"warn"|"info"|"debug"}
 */
export function inferLevel(line) {
  const l = line.toLowerCase()
  // Anchored tokens first (`[error]`, `error:`, ` error `) to avoid matching a
  // substring inside a path/word (e.g. "errorHandler.ts").
  if (/(^|[[\s:])(error|err|fatal|panic)([\]\s:]|$)/.test(l)) return "error"
  if (/(^|[[\s:])(warn|warning)([\]\s:]|$)/.test(l)) return "warn"
  if (/(^|[[\s:])(debug|trace|verbose)([\]\s:]|$)/.test(l)) return "debug"
  if (/(^|[[\s:])(info|notice|log)([\]\s:]|$)/.test(l)) return "info"
  return "info"
}

/**
 * Extract an MCP server name from a raw line when it self-identifies. Handles
 * the shapes seen across the claude-code CLI + common servers:
 *   `[MCP][github] …`   `MCP server "github" …`   `[github] …`   `mcp__github__x`
 * Returns undefined when no name is embedded (the caller may still tag the
 * line with a known server from the stream it belongs to).
 *
 * @param {string} line
 * @returns {string | undefined}
 */
export function extractServerName(line) {
  // `mcp__<server>__<tool>` namespaced tool reference.
  const ns = line.match(/mcp__([a-z0-9][a-z0-9._-]*)__/i)
  if (ns) return ns[1]
  // `MCP server "name"` / `mcp server 'name'`.
  const quoted = line.match(/mcp[\s-]*server[\s:]*["'`]([^"'`]+)["'`]/i)
  if (quoted) return quoted[1]
  // `[MCP][name]` or a leading `[name]` bracket that isn't a level word.
  const brackets = [...line.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim())
  for (const b of brackets) {
    const low = b.toLowerCase()
    if (low === "mcp") continue
    if (LOG_LEVEL_WORDS.has(low)) continue
    // A plausible server token: no spaces, alnum/._- only.
    if (/^[a-z0-9][a-z0-9._-]*$/i.test(b)) return b
  }
  return undefined
}

/**
 * Classify a raw stderr/log line into `{ level, server, message }`. `server`
 * from the line wins; otherwise the caller-supplied `knownServer` is used.
 *
 * @param {string} line
 * @param {{ knownServer?: string }} [opts]
 * @returns {{ level: "error"|"warn"|"info"|"debug", server?: string, message: string }}
 */
export function classifyMcpLogLine(line, opts = {}) {
  const message = line.replace(/\r$/, "").replace(/\s+$/, "")
  const server = extractServerName(message) ?? opts.knownServer
  return { level: inferLevel(message), ...(server ? { server } : {}), message }
}

/**
 * Build a `mcp_log` outbound event. `ts` is injected (the caller stamps it) so
 * this stays pure/testable. `source` distinguishes stderr capture, structured
 * connect/tool diagnostics, and live status snapshots.
 *
 * @param {{
 *   sessionId: string,
 *   ts: number,
 *   level: "error"|"warn"|"info"|"debug",
 *   message: string,
 *   server?: string,
 *   source?: "stderr"|"diagnostic"|"status",
 * }} params
 */
export function buildMcpLogEvent({ sessionId, ts, level, message, server, source = "stderr" }) {
  return {
    type: "mcp_log",
    sessionId,
    ts,
    level,
    message,
    source,
    ...(server ? { server } : {}),
  }
}

/**
 * Wire a chunked stderr stream to an emitter. Returns a `{ write, end }` pair:
 * `write(chunk)` feeds bytes, `end()` flushes the trailing partial line. Each
 * complete line becomes a `mcp_log` event via {@link classifyMcpLogLine} +
 * {@link buildMcpLogEvent}. Emission is wrapped so a bad emit never propagates
 * back into the SDK/transport that produced the bytes.
 *
 * @param {{
 *   sessionId: string,
 *   emit: (event: any) => void,
 *   now?: () => number,
 *   knownServer?: string,
 *   source?: "stderr"|"diagnostic",
 * }} params
 */
export function createStderrLogSink({
  sessionId,
  emit,
  now = Date.now,
  knownServer,
  source = "stderr",
}) {
  const buffer = createLineBuffer()
  const emitLine = (line) => {
    const { level, server, message } = classifyMcpLogLine(line, { knownServer })
    try {
      emit(buildMcpLogEvent({ sessionId, ts: now(), level, message, server, source }))
    } catch {
      // Never let a downstream emit failure fault the producing stream.
    }
  }
  return {
    write(chunk) {
      for (const line of buffer.push(chunk)) emitLine(line)
    },
    end() {
      for (const line of buffer.flush()) emitLine(line)
    },
  }
}
