import net from "node:net"
import type { EventEmitter } from "node:events"
export interface BrokerSocket extends Pick<EventEmitter, "on" | "once"> {
  readyState: string
  setEncoding(encoding: "utf8"): unknown
  write(chunk: string): unknown
  destroy(): unknown
}
export type BrokerConnector = (path: string) => BrokerSocket
export interface BrokerResponse {
  allow?: boolean
  reason?: string
  updatedArgs?: unknown
  result?: unknown
  error?: string
  session?: unknown
  [key: string]: unknown
}
/** Connect to the Cognia broker and expose a request/response helper. */
export function connectBroker(
  socketPath: string,
  { connect = net.connect }: { connect?: BrokerConnector } = {}
) {
  const socket = connect(socketPath)
  socket.setEncoding("utf8")
  const pending = new Map<
    number,
    { resolve(response: BrokerResponse): void; reject(error: Error): void }
  >()
  let nextId = 0
  let buffer = ""
  let fatal: string | null = null

  const failAll = (reason: string) => {
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
      new Promise<void>((resolve, reject) => {
        if (socket.readyState === "open") return resolve()
        socket.once("connect", resolve)
        socket.once("error", reject)
      }),
    call(method: string, params: Record<string, unknown>): Promise<BrokerResponse> {
      if (fatal) return Promise.reject(new Error(fatal))
      const id = ++nextId
      return new Promise<BrokerResponse>((resolve, reject) => {
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

export type BrokerConnection = ReturnType<typeof connectBroker>
