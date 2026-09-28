import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"
export interface StdioTool {
  name: string
  description?: string
  inputSchema: unknown
  run(args: Record<string, unknown>): unknown
}
export interface StdioInput {
  setEncoding(encoding: "utf8"): unknown
  on(event: "data", listener: (chunk: string) => void): unknown
}
export interface StdioOutput {
  write(message: string): unknown
}
export interface StdioRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: unknown }
}
export interface StdioServerOptions {
  serverName: string
  serverVersion?: string
  protocolVersion?: string | ((requested: unknown) => string)
  capabilities?: Record<string, unknown>
  errorMode?: "tool" | "protocol"
  ignoreNotifications?: boolean
  acceptRequest?: (request: StdioRequest) => boolean
  onParseError?: (error: unknown) => void
  tools: readonly StdioTool[]
  input: StdioInput
  output: StdioOutput
}
/** Minimal MCP stdio server: JSON-RPC 2.0, newline framed. */
export function createMcpStdioServer({
  serverName,
  serverVersion = "1.0.0",
  protocolVersion = LATEST_PROTOCOL_VERSION,
  capabilities = { tools: {} },
  tools,
  input,
  output,
  errorMode = "tool",
  ignoreNotifications = true,
  acceptRequest,
  onParseError,
}: StdioServerOptions) {
  const byName = new Map(tools.map((t) => [t.name, t]))
  let buffer = ""

  const write = (message: unknown) => output.write(`${JSON.stringify(message)}\n`)
  const respond = (id: string | number | null | undefined, result: unknown) =>
    write({ jsonrpc: "2.0", id, result })
  const fail = (id: string | number | null | undefined, code: number, message: string) =>
    write({ jsonrpc: "2.0", id, error: { code, message } })

  async function handle(request: StdioRequest) {
    // A notification (no id) never gets a reply — answering one is a protocol
    // error that some clients treat as fatal.
    if (!request || typeof request !== "object") return
    const { id, method, params } = request
    if (acceptRequest && !acceptRequest(request)) return
    if (ignoreNotifications && (id === undefined || id === null)) return
    if (method === "initialized" || method === "notifications/initialized") return
    switch (method) {
      case "initialize":
        respond(id, {
          protocolVersion:
            typeof protocolVersion === "function"
              ? protocolVersion(params?.protocolVersion)
              : protocolVersion,
          capabilities,
          serverInfo: { name: serverName, version: serverVersion },
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
        const tool = byName.get(params?.name ?? "")
        if (!tool) {
          if (errorMode === "protocol") {
            fail(id, -32601, `unknown tool: ${params?.name}`)
            return
          }
          respond(id, {
            content: [{ type: "text", text: `Error: unknown tool "${params?.name}"` }],
            isError: true,
          })
          return
        }
        try {
          respond(id, await tool.run(params?.arguments ?? {}))
        } catch (err) {
          if (errorMode === "protocol") {
            fail(
              id ?? null,
              -32603,
              `internal error: ${err instanceof Error ? err.message : String(err)}`
            )
            return
          }
          // A transport fault (Cognia gone) must surface as a tool error, not a
          // JSON-RPC error, so the agent can keep the turn and report it.
          respond(id, {
            content: [
              { type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
            ],
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
      } catch (error) {
        if (onParseError) onParseError(error)
        else fail(null, -32700, "parse error")
        continue
      }
      void handle(request)
    }
  })

  return { handle }
}
