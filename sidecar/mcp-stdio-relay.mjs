import { createInterface } from "node:readline"
import { pathToFileURL } from "node:url"

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
  { HttpTransport = StreamableHTTPClientTransport, SseTransport = SSEClientTransport } = {}
) {
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
  const remote = createTransport(config, guard.fetch)
  let initializeRequestId
  remote.onmessage = (message) => {
    if (
      initializeRequestId !== undefined &&
      message?.id === initializeRequestId &&
      typeof message?.result?.protocolVersion === "string"
    ) {
      remote.setProtocolVersion?.(message.result.protocolVersion)
      initializeRequestId = undefined
    }
    output.write(`${JSON.stringify(message)}\n`)
  }
  remote.onerror = (error) => {
    errorOutput.write(`MCP relay upstream error: ${error?.message ?? String(error)}\n`)
  }

  const close = async () => {
    try {
      await remote.close()
    } finally {
      await guard.close()
    }
  }
  const onSignal = () => void close().finally(() => process.exit(0))
  process.once("SIGTERM", onSignal)
  process.once("SIGINT", onSignal)
  try {
    await remote.start()
    const lines = createInterface({ input, crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (message?.method === "initialize" && message.id !== undefined) {
        initializeRequestId = message.id
      }
      await remote.send(message)
    }
  } finally {
    process.removeListener("SIGTERM", onSignal)
    process.removeListener("SIGINT", onSignal)
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
