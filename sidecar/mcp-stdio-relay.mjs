import { permissionDecisionHasUnprovenRewrite } from "./dispatch/anthropic-mcp-relay.mjs"
import { createInterface } from "node:readline"
import { pathToFileURL } from "node:url"

import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import { createEgressGuard } from "./mcp-oauth-helper.mjs"

const CONFIG_ENV = "COGNIA_MCP_RELAY_CONFIG"

export function decodeRelayConfig(value = process.env[CONFIG_ENV]) {
  if (!value) throw new Error("missing MCP relay configuration")
  let config
  try {
    config = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
  } catch {
    throw new Error("invalid MCP relay configuration")
  }
  if (config.transport === "stdio") {
    if (
      typeof config.command !== "string" ||
      !config.command ||
      (config.args !== undefined &&
        (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== "string"))) ||
      (config.env !== undefined &&
        (!config.env ||
          typeof config.env !== "object" ||
          Array.isArray(config.env) ||
          Object.values(config.env).some((value) => typeof value !== "string")))
    )
      throw new Error("invalid MCP relay transport configuration")
    return config
  }
  if (
    (config.transport !== "http" && config.transport !== "sse") ||
    typeof config.url !== "string" ||
    !config.url
  ) {
    throw new Error("invalid MCP relay transport configuration")
  }
  return config
}

export function createRemoteTransport(
  config,
  guardedFetch,
  {
    HttpTransport = StreamableHTTPClientTransport,
    SseTransport = SSEClientTransport,
    StdioTransport = StdioClientTransport,
  } = {}
) {
  if (config.transport === "stdio")
    return new StdioTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
      stderr: "pipe",
    })
  const options = {
    requestInit: {
      headers: config.headers,
      redirect: "error",
    },
    fetch: guardedFetch,
  }
  if (config.transport === "sse") {
    options.eventSourceInit = { fetch: guardedFetch, headers: config.headers }
    return new SseTransport(new URL(config.url), options)
  }
  return new HttpTransport(new URL(config.url), options)
}

/** Raw JSON-RPC relay: stdio downstream, guarded HTTP/SSE upstream. */
export async function runMcpStdioRelay({
  config = decodeRelayConfig(),
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  createGuard = createEgressGuard,
  createTransport = createRemoteTransport,
} = {}) {
  const guard = createGuard({ allowPrivateNetwork: config.allowPrivateNetwork === true })
  let remote
  try {
    remote = createTransport(config, guard.fetch)
  } catch (error) {
    await guard.close()
    throw error
  }
  let initializeRequestId
  const pendingMethods = new Map()
  let lines,
    stderrLines,
    upstreamClosed = false
  const rejectPending = () => {
    for (const id of pendingMethods.keys())
      output.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "MCP upstream connection ended" } })}\n`
      )
    pendingMethods.clear()
  }
  remote.onclose = () => {
    upstreamClosed = true
    rejectPending()
    lines?.close()
  }
  remote.onmessage = (message) => {
    if (
      initializeRequestId !== undefined &&
      message?.id === initializeRequestId &&
      typeof message?.result?.protocolVersion === "string"
    ) {
      remote.setProtocolVersion?.(message.result.protocolVersion)
      initializeRequestId = undefined
    }
    // Server-initiated requests have an independent ID namespace; they must
    // never consume the pending client request with the same ID.
    const isResponse =
      message?.id !== undefined &&
      message.method === undefined &&
      (Object.prototype.hasOwnProperty.call(message, "result") ||
        Object.prototype.hasOwnProperty.call(message, "error"))
    const request = isResponse ? pendingMethods.get(message.id) : undefined
    const method = request?.method
    if (isResponse) pendingMethods.delete(message.id)
    if (
      request?.permission &&
      permissionDecisionHasUnprovenRewrite(message.result, request.originalInput)
    ) {
      message = {
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: "Permission delegate cannot rewrite tool input after policy validation",
        },
      }
    }
    // Tool catalogs and results enter the model context, including stdio MCPs.
    if (method && !hasNoLeakingPiiDeep(message.result ?? message.error)) {
      message = {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "MCP response blocked by the PII gate" },
      }
    }
    output.write(`${JSON.stringify(message)}\n`)
  }
  remote.onerror = (error) => {
    const detail = error?.message ?? String(error)
    errorOutput.write(
      `MCP relay upstream error: ${hasNoLeakingPiiDeep(detail) ? detail : "details blocked by the PII gate"}\n`
    )
    rejectPending()
  }

  let closing
  const close = () =>
    (closing ??= (async () => {
      try {
        await remote.close()
      } finally {
        await guard.close()
      }
    })())
  const onSignal = () => void close().finally(() => process.exit(0))
  process.once("SIGTERM", onSignal)
  process.once("SIGINT", onSignal)
  try {
    await remote.start()
    if (upstreamClosed) return
    if (remote.stderr) {
      stderrLines = createInterface({ input: remote.stderr, crlfDelay: Infinity })
      stderrLines.on("line", (line) =>
        errorOutput.write(
          `${hasNoLeakingPiiDeep(line) ? line : "MCP diagnostics blocked by the PII gate"}\n`
        )
      )
    }
    lines = createInterface({ input, crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (
        ["tools/call", "prompts/get", "completion/complete"].includes(message?.method) &&
        !hasNoLeakingPiiDeep(message.params)
      ) {
        output.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "MCP request blocked by the PII gate" } })}\n`
        )
        continue
      }
      if (message?.method === "initialize" && message.id !== undefined) {
        initializeRequestId = message.id
      }
      if (message?.id !== undefined && typeof message.method === "string")
        pendingMethods.set(message.id, {
          method: message.method,
          permission:
            message.method === "tools/call" && config.permissionToolName === message.params?.name,
          originalInput: message.params?.arguments?.input,
        })
      await remote.send(message)
    }
  } finally {
    process.removeListener("SIGTERM", onSignal)
    process.removeListener("SIGINT", onSignal)
    lines?.close()
    stderrLines?.close()
    await close()
  }
}

const isEntryPoint = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href
  } catch {
    return false
  }
})()

if (isEntryPoint) {
  runMcpStdioRelay().catch((error) => {
    process.stderr.write(`MCP relay failed: ${error?.message ?? String(error)}\n`)
    process.exitCode = 1
  })
}
