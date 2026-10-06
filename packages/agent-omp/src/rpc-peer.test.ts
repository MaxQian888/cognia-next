import { OmpRpcPeer } from "./rpc-peer"

function harness(options: { gate?: (payload: unknown) => boolean } = {}) {
  const frames: Record<string, unknown>[] = []
  const events: unknown[] = []
  const peer = new OmpRpcPeer({
    send: async (line) => {
      frames.push(JSON.parse(line))
    },
    outboundGate: options.gate ?? (() => true),
    onEvent: (event) => {
      events.push(event)
    },
    timeoutMs: 100,
  })
  const feed = (frame: unknown) => peer.feed(JSON.stringify(frame) + "\n")
  const respond = (frame: Record<string, unknown>, data?: unknown) =>
    feed({ type: "response", id: frame.id, command: frame.type, success: true, data })
  return { peer, frames, events, feed, respond }
}

test("waits for ready and negotiates v2 before releasing commands", async () => {
  const h = harness()
  const ready = h.peer.ready()
  const state = h.peer.request("get_state")
  expect(h.frames).toEqual([])
  h.feed({ type: "ready", supportedProtocolVersions: [1, 2] })
  await Promise.resolve()
  expect(h.frames[0].type).toBe("negotiate_protocol")
  h.respond(h.frames[0], { protocolVersion: 2 })
  await ready
  await Promise.resolve()
  expect(h.frames[1].type).toBe("get_state")
  h.respond(h.frames[1], { isSettled: true })
  expect(await state).toEqual({ isSettled: true })
  h.peer.dispose()
})

test("correlates interleaved prompt tickets, keeping yield distinct from settled", async () => {
  const h = harness()
  h.feed({ type: "ready" })
  const a = h.peer.prompt({ message: "a" })
  const b = h.peer.prompt({ message: "b", streamingBehavior: "followUp" })
  await h.peer.ready()
  await Promise.resolve()
  h.respond(h.frames[0], {})
  h.respond(h.frames[1], {})
  await Promise.all([a.ack, b.ack])
  h.feed({
    type: "prompt_result",
    id: b.id,
    status: "completed",
    agentInvoked: true,
    sessionSettled: false,
  })
  expect((await b.result).sessionSettled).toBe(false)
  h.feed({
    type: "prompt_result",
    id: a.id,
    status: "aborted",
    agentInvoked: true,
    sessionSettled: true,
  })
  expect((await a.result).status).toBe("aborted")
  h.peer.dispose()
})

test("completes synchronous commands from acknowledgement without awaiting an event", async () => {
  const h = harness()
  h.feed({ type: "ready" })
  const ticket = h.peer.prompt({ message: "/help" })
  await h.peer.ready()
  await Promise.resolve()
  h.respond(h.frames[0], { agentInvoked: false })
  expect(await ticket.result).toMatchObject({ agentInvoked: false, status: "completed" })
  h.peer.dispose()
})

test("blocks both command and host callback before transport when gate rejects", async () => {
  const h = harness({ gate: () => false })
  h.feed({ type: "ready" })
  await expect(h.peer.request("bash", { command: "secret" })).rejects.toThrow(/gate/i)
  await expect(
    h.peer.sendFrame({ type: "extension_ui_response", id: "x", cancelled: true })
  ).rejects.toThrow(/gate/i)
  expect(h.frames).toEqual([])
  h.peer.dispose()
})

test("rejects pending work and clears timers on malformed input and disposal", async () => {
  const h = harness()
  h.feed({ type: "ready" })
  const request = h.peer.request("get_state")
  h.peer.feed("{broken\n")
  await expect(request).rejects.toThrow()
  await expect(h.peer.request("get_state")).rejects.toThrow()
  h.peer.dispose()
})

test("request timeout does not replay a command and late responses cannot resolve another request", async () => {
  const h = harness()
  h.feed({ type: "ready" })
  await expect(h.peer.request("get_state", undefined, 5)).rejects.toThrow(/timed out/i)
  h.respond(h.frames[0], { late: true })
  expect(h.frames).toHaveLength(1)
  h.peer.dispose()
})

test("retains machine-readable RPC failure codes", async () => {
  const h = harness()
  h.feed({ type: "ready" })
  const request = h.peer.request("get_messages_page", { cursor: "stale" })
  await h.peer.ready()
  await Promise.resolve()
  h.feed({
    type: "response",
    id: h.frames[0].id,
    command: "get_messages_page",
    success: false,
    error: "Snapshot changed",
    code: "stale_cursor",
  })
  await expect(request).rejects.toMatchObject({
    code: "stale_cursor",
    command: "get_messages_page",
  })
  expect(h.peer.pendingCount).toBe(0)
  h.peer.dispose()
})

test("rejects both prompt promises on transport failure without leaking its completion timer", async () => {
  const h = harness()
  h.feed({ type: "ready" })
  const ticket = h.peer.prompt({ message: "run" })
  await h.peer.ready()
  await Promise.resolve()
  h.peer.dispose(new Error("Process exited"))
  await expect(ticket.ack).rejects.toThrow("Process exited")
  await expect(ticket.result).rejects.toThrow("Process exited")
  expect(h.peer.pendingCount).toBe(0)
  expect(h.peer.promptCount).toBe(0)
})

test("times out a prompt independently after acknowledgement", async () => {
  const frames: Record<string, unknown>[] = []
  const peer = new OmpRpcPeer({
    send: async (line) => {
      frames.push(JSON.parse(line))
    },
    outboundGate: () => true,
    promptTimeoutMs: 5,
  })
  peer.feed('{"type":"ready"}\n')
  const ticket = peer.prompt({ message: "long" })
  await peer.ready()
  await Promise.resolve()
  peer.feed(
    JSON.stringify({ type: "response", id: frames[0].id, command: "prompt", success: true }) + "\n"
  )
  await ticket.ack
  await expect(ticket.result).rejects.toThrow(/completion timed out/)
  expect(peer.promptCount).toBe(0)
  peer.dispose()
})

test("accepts LF-delimited raw bytes split within a UTF-8 code point and preserves Unicode separators", () => {
  const h = harness()
  const bytes = Buffer.from('{"type":"ready"}\n{"type":"command_output","text":"🙂\u2028hi"}\n')
  const emoji = bytes.indexOf(Buffer.from("🙂"))
  h.peer.feed(bytes.subarray(0, emoji + 1))
  h.peer.feed(bytes.subarray(emoji + 1))
  expect(h.events[1]).toEqual({ type: "command_output", text: "🙂\u2028hi" })
  h.peer.dispose()
})

test("invalid UTF-8 fails instead of silently replacing source bytes", async () => {
  const h = harness()
  h.peer.feed(Uint8Array.from([0xff, 0x0a]))
  await expect(h.peer.ready()).rejects.toThrow()
})

test("EOF reports incomplete JSONL and aborts pending work", async () => {
  const h = harness()
  h.peer.feed('{"type":"rea')
  h.peer.end()
  await expect(h.peer.ready()).rejects.toThrow(/incomplete/)
})

test("rejects mismatched responses rather than resolving another command", async () => {
  const h = harness()
  h.feed({ type: "ready" })
  const request = h.peer.request("get_state")
  await h.peer.ready()
  await Promise.resolve()
  h.feed({ type: "response", id: h.frames[0].id, command: "bash", success: true })
  await expect(request).rejects.toThrow(/mismatched/)
})

test("rejects v2 chunks before negotiation and reports server overflow", async () => {
  for (const frame of [{ type: "rpc_chunk" }, { type: "rpc_frame_error", error: "Too big" }]) {
    const h = harness()
    h.feed({ type: "ready" })
    const request = h.peer.request("get_state")
    h.feed(frame)
    await expect(request).rejects.toThrow()
  }
})

test("fails startup when ready never arrives", async () => {
  const peer = new OmpRpcPeer({ send: async () => {}, outboundGate: () => true, timeoutMs: 5 })
  await expect(peer.ready()).rejects.toThrow(/ready timed out/)
})

test("v2 acknowledgement and chunked event in the same stdout read are handled in order", async () => {
  const h = harness()
  h.feed({ type: "ready", supportedProtocolVersions: [1, 2] })
  const expected = { type: "command_output", text: "a".repeat(1024 * 1024) }
  const bytes = Buffer.from(JSON.stringify(expected))
  const count = Math.ceil(bytes.length / (256 * 1024))
  const frames = Array.from({ length: count }, (_, index) => ({
    type: "rpc_chunk",
    chunkId: "large",
    index,
    count,
    byteLength: bytes.length,
    data: bytes.subarray(index * 256 * 1024, (index + 1) * 256 * 1024).toString("base64"),
  }))
  h.peer.feed(
    [
      {
        type: "response",
        command: "negotiate_protocol",
        id: h.frames[0].id,
        success: true,
        data: { protocolVersion: 2 },
      },
      ...frames,
    ]
      .map((frame) => JSON.stringify(frame) + "\n")
      .join("")
  )
  await h.peer.ready()
  expect(h.events[1]).toEqual(expected)
  expect(h.peer.protocolVersion).toBe(2)
  h.peer.dispose()
})

test("transport write failure rejects every pending request and prompt", async () => {
  let breakSend!: (error: Error) => void
  const peer = new OmpRpcPeer({
    send: () =>
      new Promise<void>((_, reject) => {
        breakSend = reject
      }),
    outboundGate: () => true,
  })
  peer.feed('{"type":"ready"}\n')
  const state = peer.request("get_state")
  const ticket = peer.prompt({ message: "run" })
  await peer.ready()
  await Promise.resolve()
  breakSend(new Error("EPIPE"))
  await expect(state).rejects.toThrow("EPIPE")
  await expect(ticket.ack).rejects.toThrow("EPIPE")
  await expect(ticket.result).rejects.toThrow("EPIPE")
  expect(peer.pendingCount).toBe(0)
  expect(peer.promptCount).toBe(0)
})
