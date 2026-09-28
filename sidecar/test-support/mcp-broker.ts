import { EventEmitter } from "node:events"
import { connectBroker } from "../src/mcp/client/broker.ts"
/** A fake socket the broker helper can drive both ways. */
export function fakeSocket() {
  return new (class extends EventEmitter {
    writes: string[] = []
    readyState = "open"
    setEncoding() {}
    write(chunk: string) {
      this.writes.push(chunk)
      return true
    }
    destroy() {
      return this.emit("close")
    }
  })()
}

/** A broker that answers every request with `answer(method, params)`. */
export function scriptedBroker(
  answer: (method: string, params: Record<string, unknown>) => unknown
) {
  const socket = fakeSocket()
  const broker = connectBroker("/ignored", { connect: () => socket })
  socket.write = (chunk) => {
    socket.writes.push(chunk)
    for (const line of chunk.split("\n").filter(Boolean)) {
      const request = JSON.parse(line)
      queueMicrotask(() => {
        const result = answer(request.method, request.params)
        socket.emit("data", `${JSON.stringify({ id: request.id, result })}\n`)
      })
    }
    return true
  }
  return { broker, socket }
}
