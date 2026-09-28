import net from "node:net"
import { randomUUID } from "node:crypto"
import { SERVER_NAME, SERVER_VERSION, rawTools, buildDispatch } from "../../tools/a2ui/tool-defs.ts"
import { negotiateProtocolVersion } from "./protocol-version.ts"
import { createMcpStdioServer } from "../stdio-server.ts"
import type { StdioInput, StdioOutput } from "../stdio-server.ts"

/** Own the optional renderer socket and its reconnect timer for one process. */
export function createA2uiIpc({
  socketPath,
  log,
  connect = net.createConnection,
  reconnectMs = 2000,
}: {
  socketPath?: string
  log: (message: string) => void
  connect?: typeof net.createConnection
  reconnectMs?: number
}) {
  let socket: net.Socket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  function scheduleReconnect() {
    if (timer || closed) return
    timer = setTimeout(() => {
      timer = null
      connectIpc()
    }, reconnectMs)
  }
  function connectIpc() {
    if (closed) return
    if (!socketPath) {
      log("COGNIA_BRIDGE_SOCKET not set — running in detached mode (no UI dispatch)")
      return
    }
    try {
      const current = connect(socketPath, () => log(`connected to bridge ${socketPath}`))
      current.on("error", (error) => {
        log(`bridge error: ${error.message}`)
        socket = null
        scheduleReconnect()
      })
      current.on("close", () => {
        socket = null
        scheduleReconnect()
      })
      socket = current
    } catch (error) {
      log(`bridge connect threw: ${error instanceof Error ? error.message : String(error)}`)
      scheduleReconnect()
    }
  }
  connectIpc()
  return {
    dispatch(message: unknown) {
      if (!socket) return false
      try {
        socket.write(JSON.stringify({ type: "a2ui_dispatch", source: "a2ui-mcp", message }) + "\n")
        return true
      } catch (error) {
        log(`dispatch write failed: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    },
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      timer = null
      try {
        socket?.end()
      } catch {
        /* best effort on a dead renderer socket */
      }
      socket = null
    },
  }
}

export function runA2uiStdio({
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  env = process.env,
}: {
  input?: StdioInput
  output?: StdioOutput
  errorOutput?: StdioOutput
  env?: NodeJS.ProcessEnv
} = {}) {
  const log = (message: string) => {
    errorOutput.write(`[a2ui-mcp] ${message}\n`)
  }
  const ipc = createA2uiIpc({ socketPath: env.COGNIA_BRIDGE_SOCKET, log })
  const server = createMcpStdioServer({
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    protocolVersion: negotiateProtocolVersion,
    capabilities: { tools: { listChanged: false } },
    errorMode: "protocol",
    ignoreNotifications: false,
    acceptRequest: (request) => request?.jsonrpc === "2.0",
    onParseError: (error) =>
      log(`bad JSON: ${error instanceof Error ? error.message : String(error)}`),
    tools: rawTools().map((tool) => ({
      ...tool,
      run(args: Record<string, unknown>) {
        const dispatched = ipc.dispatch(buildDispatch(tool.name, args))
        return {
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
        }
      },
    })),
    input,
    output,
  })
  env.A2UI_MCP_SESSION = randomUUID()
  return { ...server, close: () => ipc.close() }
}
