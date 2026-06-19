import { JsonRpcPeer, JsonRpcMethodError, type JsonRpcPeerOptions } from "./json-rpc-peer"

function makePeer(opts?: Partial<JsonRpcPeerOptions>) {
  const writes: string[] = []
  const notifications: Array<{ method: string; params: unknown }> = []
  const peer = new JsonRpcPeer({
    writeRaw: (m) => {
      writes.push(m)
    },
    onNotification: (method, params) => notifications.push({ method, params }),
    ...opts,
  })
  return { peer, writes, notifications }
}

describe("JsonRpcPeer", () => {
  describe("wire shape", () => {
    it("includes jsonrpc:2.0 by default", () => {
      const { peer, writes } = makePeer()
      void peer.sendRequest("thread/start", { model: "gpt" })
      expect(JSON.parse(writes[0])).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        method: "thread/start",
        params: { model: "gpt" },
      })
    })

    it("omits jsonrpc when omitJsonRpcVersion is set (Codex app-server)", () => {
      const { peer, writes } = makePeer({ omitJsonRpcVersion: true })
      void peer.sendRequest("turn/start", { threadId: "t1" })
      const parsed = JSON.parse(writes[0])
      expect("jsonrpc" in parsed).toBe(false)
      expect(parsed).toMatchObject({ id: 1, method: "turn/start", params: { threadId: "t1" } })
    })

    it("notifications carry no id", () => {
      const { peer, writes } = makePeer({ omitJsonRpcVersion: true })
      peer.sendNotification("initialized")
      const parsed = JSON.parse(writes[0])
      expect("id" in parsed).toBe(false)
      expect(parsed.method).toBe("initialized")
    })

    it("increments request ids", () => {
      const { peer, writes } = makePeer()
      void peer.sendRequest("a")
      void peer.sendRequest("b")
      expect(JSON.parse(writes[0]).id).toBe(1)
      expect(JSON.parse(writes[1]).id).toBe(2)
    })
  })

  describe("request/response correlation", () => {
    it("resolves a pending request with its result", async () => {
      const { peer } = makePeer()
      const p = peer.sendRequest<{ thread: { id: string } }>("thread/start")
      peer.ingest(JSON.stringify({ id: 1, result: { thread: { id: "thr_1" } } }))
      await expect(p).resolves.toEqual({ thread: { id: "thr_1" } })
    })

    it("rejects on a JSON-RPC error response with code-prefixed message", async () => {
      const { peer } = makePeer()
      const p = peer.sendRequest("turn/start")
      peer.ingest(JSON.stringify({ id: 1, error: { code: -32602, message: "bad params" } }))
      await expect(p).rejects.toThrow("-32602: bad params")
    })

    it("rejects on timeout", async () => {
      jest.useFakeTimers()
      try {
        const { peer } = makePeer()
        const p = peer.sendRequest("slow", undefined, 1000)
        const assertion = expect(p).rejects.toThrow("Request timeout: slow")
        jest.advanceTimersByTime(1000)
        await assertion
      } finally {
        jest.useRealTimers()
      }
    })

    it("rejects when the transport write fails", async () => {
      const peer = new JsonRpcPeer({
        writeRaw: () => {
          throw new Error("pipe closed")
        },
      })
      await expect(peer.sendRequest("x")).rejects.toThrow("pipe closed")
    })

    it("ignores a response for an unknown id", () => {
      const { peer } = makePeer()
      expect(() => peer.ingest(JSON.stringify({ id: 99, result: {} }))).not.toThrow()
    })
  })

  describe("inbound dispatch", () => {
    it("routes notifications to onNotification", () => {
      const { peer, notifications } = makePeer()
      peer.ingest(JSON.stringify({ method: "turn/started", params: { turn: { id: "t" } } }))
      expect(notifications).toEqual([{ method: "turn/started", params: { turn: { id: "t" } } }])
    })

    it("splits newline-delimited frames in a single chunk", () => {
      const { peer, notifications } = makePeer()
      peer.ingest(`${JSON.stringify({ method: "a" })}\n${JSON.stringify({ method: "b" })}\n`)
      expect(notifications.map((n) => n.method)).toEqual(["a", "b"])
    })

    it("skips non-JSON noise lines", () => {
      const { peer, notifications } = makePeer()
      peer.ingest(`codex app-server listening...\n${JSON.stringify({ method: "ready" })}`)
      expect(notifications.map((n) => n.method)).toEqual(["ready"])
    })
  })

  describe("server→client requests", () => {
    it("answers with the handler result", async () => {
      const writes: string[] = []
      const peer = new JsonRpcPeer({
        writeRaw: (m) => {
          writes.push(m)
        },
        onServerRequest: async (method) => {
          expect(method).toBe("item/fileChange/requestApproval")
          return { decision: "accept" }
        },
      })
      peer.ingest(JSON.stringify({ id: 7, method: "item/fileChange/requestApproval", params: {} }))
      await Promise.resolve()
      await Promise.resolve()
      const sent = JSON.parse(writes.at(-1)!)
      expect(sent).toMatchObject({ id: 7, result: { decision: "accept" } })
    })

    it("returns -32601 when no handler is registered", async () => {
      const writes: string[] = []
      const peer = new JsonRpcPeer({
        writeRaw: (m) => {
          writes.push(m)
        },
      })
      peer.ingest(JSON.stringify({ id: 1, method: "unknown/method" }))
      await Promise.resolve()
      const sent = JSON.parse(writes.at(-1)!)
      expect(sent.error.code).toBe(-32601)
    })

    it("preserves a JsonRpcMethodError code", async () => {
      const writes: string[] = []
      const peer = new JsonRpcPeer({
        writeRaw: (m) => {
          writes.push(m)
        },
        onServerRequest: () => {
          throw new JsonRpcMethodError(-32004, "denied")
        },
      })
      peer.ingest(JSON.stringify({ id: 2, method: "x" }))
      await Promise.resolve()
      await Promise.resolve()
      const sent = JSON.parse(writes.at(-1)!)
      expect(sent.error).toMatchObject({ code: -32004, message: "denied" })
    })

    it("defaults to -32603 for a plain thrown error", async () => {
      const writes: string[] = []
      const peer = new JsonRpcPeer({
        writeRaw: (m) => {
          writes.push(m)
        },
        onServerRequest: () => {
          throw new Error("boom")
        },
      })
      peer.ingest(JSON.stringify({ id: 3, method: "x" }))
      await Promise.resolve()
      await Promise.resolve()
      const sent = JSON.parse(writes.at(-1)!)
      expect(sent.error).toMatchObject({ code: -32603, message: "boom" })
    })
  })

  describe("rejectAll", () => {
    it("rejects every in-flight request", async () => {
      const { peer } = makePeer()
      const p = peer.sendRequest("x")
      peer.rejectAll("disconnected")
      await expect(p).rejects.toThrow("disconnected")
    })
  })
})
