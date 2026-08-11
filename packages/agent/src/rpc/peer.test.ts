import { PassThrough } from "node:stream"

import { RpcError, RpcPeer } from "./peer"

describe("RpcPeer", () => {
  it("rejects timed-out and already-cancelled calls with stable codes", async () => {
    const readable = new PassThrough()
    const writable = new PassThrough()
    const peer = new RpcPeer({ readable, writable })

    await expect(peer.call("runtime/status", {}, { timeoutMs: 5 })).rejects.toMatchObject({
      code: -32008,
    })
    const controller = new AbortController()
    controller.abort()
    await expect(
      peer.call("runtime/status", {}, { signal: controller.signal })
    ).rejects.toMatchObject({
      code: -32007,
    })

    peer.close()
    readable.end()
    writable.end()
  })

  it("rejects an oversized outgoing frame before writing it", async () => {
    const readable = new PassThrough()
    const writable = new PassThrough()
    const peer = new RpcPeer({ readable, writable, maxFrameBytes: 64 })

    await expect(peer.call("audit/query", { sessionId: "x".repeat(100) })).rejects.toBeInstanceOf(
      RpcError
    )
    expect(writable.readableLength).toBe(0)

    peer.close()
    readable.end()
    writable.end()
  })
})
