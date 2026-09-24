import {
  PiFrameDecoder,
  PiFrameError,
  PiRpcPeer,
  frameHint,
  isCompleteFrame,
  PI_MAX_FRAME_BYTES,
  PI_MAX_BUFFER_BYTES,
  type PiEventFrame,
  type PiResponseFrame,
} from "./pi-rpc-peer"

const enc = (s: string) => new TextEncoder().encode(s)

describe("PiFrameDecoder", () => {
  it("splits complete frames on LF and drops the delimiter", () => {
    const d = new PiFrameDecoder()
    expect(d.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
  })

  it("holds a partial frame until its newline arrives", () => {
    const d = new PiFrameDecoder()
    expect(d.push('{"a":')).toEqual([])
    expect(d.bufferedBytes).toBe(5)
    expect(d.push("1}\n")).toEqual(['{"a":1}'])
    expect(d.bufferedBytes).toBe(0)
  })

  it("reassembles a frame split across many chunks", () => {
    const d = new PiFrameDecoder()
    const frame = JSON.stringify({ type: "message_update", text: "x".repeat(500) })
    const bytes = enc(frame + "\n")
    const out: string[] = []
    for (let i = 0; i < bytes.length; i += 7) {
      out.push(...d.push(bytes.subarray(i, i + 7)))
    }
    expect(out).toEqual([frame])
  })

  it("strips a trailing CR so CRLF input still parses", () => {
    const d = new PiFrameDecoder()
    expect(d.push('{"a":1}\r\n')).toEqual(['{"a":1}'])
  })

  /**
   * The regression this decoder exists for. Node's `readline` treats U+2028 /
   * U+2029 as line terminators and `JSON.stringify` does not escape them, so
   * one valid frame became three unparseable fragments. Splitting on the 0x0A
   * byte must keep the frame whole.
   */
  it("does not split on U+2028 / U+2029", () => {
    const d = new PiFrameDecoder()
    const frame = JSON.stringify({ type: "message_update", text: "A B C" })
    expect(frame).toContain(" ")

    const frames = d.push(frame + "\n")
    expect(frames).toHaveLength(1)
    expect(JSON.parse(frames[0])).toEqual({ type: "message_update", text: "A B C" })
  })

  it("does not split on a lone CR in the middle of a frame", () => {
    const d = new PiFrameDecoder()
    // A literal CR cannot appear inside a JSON string (it must be escaped), so
    // treating one as a delimiter could only ever break a well-formed frame.
    const frames = d.push('{"a":"x"}\r{"b":2}\n')
    expect(frames).toEqual(['{"a":"x"}\r{"b":2}'])
  })

  it("decodes multi-byte UTF-8 split across a chunk boundary", () => {
    const d = new PiFrameDecoder()
    const bytes = enc('{"t":"世界"}\n')
    // Cut inside the 3-byte sequence for 世.
    expect(d.push(bytes.subarray(0, 8))).toEqual([])
    expect(d.push(bytes.subarray(8))).toEqual(['{"t":"世界"}'])
  })

  it("ignores blank frames from a trailing newline", () => {
    const d = new PiFrameDecoder()
    expect(d.push('{"a":1}\n\n')).toEqual(['{"a":1}'])
  })

  it("throws once a single frame passes the frame ceiling", () => {
    const d = new PiFrameDecoder(64, 1024)
    expect(() => d.push("x".repeat(65) + "\n")).toThrow(PiFrameError)
  })

  it("throws once an unterminated frame passes the buffer ceiling", () => {
    const d = new PiFrameDecoder(1024, 64)
    expect(() => d.push("x".repeat(65))).toThrow(PiFrameError)
  })

  it("releases the buffer when a limit trips so a dead session frees memory", () => {
    const d = new PiFrameDecoder(1024, 64)
    expect(() => d.push("x".repeat(65))).toThrow(PiFrameError)
    expect(d.bufferedBytes).toBe(0)
  })

  it("reports residue left by a stream that ended mid-frame", () => {
    const d = new PiFrameDecoder()
    d.push('{"partial":')
    expect(d.flushResidue()).toBe('{"partial":')
    expect(d.flushResidue()).toBeNull()
  })

  it("ships ceilings large enough for real payloads", () => {
    expect(PI_MAX_FRAME_BYTES).toBe(16 * 1024 * 1024)
    expect(PI_MAX_BUFFER_BYTES).toBe(32 * 1024 * 1024)
  })
})

describe("PiRpcPeer", () => {
  function makePeer(overrides: Partial<Parameters<typeof createPeer>[0]> = {}) {
    return createPeer(overrides)
  }

  function createPeer(opts: {
    writeRaw?: (frame: string) => void
    onEvent?: (e: PiEventFrame) => void
    onOrphanResponse?: (r: PiResponseFrame) => void
    onProtocolError?: (e: PiFrameError) => void
  }) {
    const written: string[] = []
    const events: PiEventFrame[] = []
    const orphans: PiResponseFrame[] = []
    const errors: PiFrameError[] = []
    const peer = new PiRpcPeer({
      writeRaw: opts.writeRaw ?? ((f) => void written.push(f)),
      onEvent: opts.onEvent ?? ((e) => void events.push(e)),
      onOrphanResponse: opts.onOrphanResponse ?? ((r) => void orphans.push(r)),
      onProtocolError: opts.onProtocolError ?? ((e) => void errors.push(e)),
    })
    return { peer, written, events, orphans, errors }
  }

  const reply = (id: string, command: string, data: unknown = null) =>
    JSON.stringify({ id, type: "response", command, success: true, data }) + "\n"

  it("resolves a command with its response data", async () => {
    const { peer, written } = makePeer({})
    const promise = peer.sendCommand("get_state")

    const sent = JSON.parse(written[0]) as { type: string; id: string }
    expect(sent.type).toBe("get_state")
    peer.ingest(reply(sent.id, "get_state", { sessionId: "s1" }))

    await expect(promise).resolves.toEqual({ sessionId: "s1" })
    expect(peer.pendingCount).toBe(0)
  })

  it("rejects when the runtime reports success:false", async () => {
    const { peer, written } = makePeer({})
    const promise = peer.sendCommand("bogus")
    const { id } = JSON.parse(written[0]) as { id: string }

    peer.ingest(
      JSON.stringify({
        id,
        type: "response",
        command: "bogus",
        success: false,
        error: "Unknown command: bogus",
      }) + "\n"
    )

    await expect(promise).rejects.toThrow("Unknown command: bogus")
  })

  /**
   * Verified against Pi 0.84.1: an `abort` reply arrived after the reply to a
   * `get_state` issued later. Anything that assumes FIFO resolves the wrong
   * promise with the wrong payload.
   */
  it("correlates by id when responses arrive out of order", async () => {
    const { peer, written } = makePeer({})
    const first = peer.sendCommand("abort")
    const second = peer.sendCommand("get_state")

    const idA = (JSON.parse(written[0]) as { id: string }).id
    const idB = (JSON.parse(written[1]) as { id: string }).id

    peer.ingest(reply(idB, "get_state", { sessionId: "s2" }))
    peer.ingest(reply(idA, "abort", { aborted: true }))

    await expect(second).resolves.toEqual({ sessionId: "s2" })
    await expect(first).resolves.toEqual({ aborted: true })
  })

  /**
   * Also verified live: malformed input makes Pi answer
   * `{command:"parse", success:false}` with NO id. Treating that as a reply to
   * whatever is in flight would fail an unrelated healthy command; ignoring
   * `pending` entirely is the only safe reading.
   */
  it("routes an id-less error response to onOrphanResponse without touching pending work", async () => {
    const { peer, written, orphans } = makePeer({})
    const inFlight = peer.sendCommand("get_state")
    const { id } = JSON.parse(written[0]) as { id: string }

    peer.ingest(
      JSON.stringify({
        type: "response",
        command: "parse",
        success: false,
        error: "Failed to parse command",
      }) + "\n"
    )

    expect(orphans).toHaveLength(1)
    expect(orphans[0].command).toBe("parse")
    expect(peer.pendingCount).toBe(1)

    peer.ingest(reply(id, "get_state", { ok: true }))
    await expect(inFlight).resolves.toEqual({ ok: true })
  })

  it("routes a response for an already-timed-out command to onOrphanResponse", async () => {
    jest.useFakeTimers()
    try {
      const { peer, written, orphans } = makePeer({})
      const promise = peer.sendCommand("get_state", {}, 1000)
      const rejected = expect(promise).rejects.toThrow("timed out")

      jest.advanceTimersByTime(1001)
      await rejected

      const { id } = JSON.parse(written[0]) as { id: string }
      peer.ingest(reply(id, "get_state", { late: true }))
      expect(orphans).toHaveLength(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it("delivers events interleaved with responses", async () => {
    const { peer, written, events } = makePeer({})
    const promise = peer.sendCommand("set_thinking_level", { level: "high" })
    const { id } = JSON.parse(written[0]) as { id: string }

    // Pi emits the change event BEFORE acknowledging the command.
    peer.ingest(JSON.stringify({ type: "thinking_level_changed", level: "high" }) + "\n")
    peer.ingest(reply(id, "set_thinking_level"))

    await expect(promise).resolves.toBeNull()
    expect(events).toEqual([{ type: "thinking_level_changed", level: "high" }])
  })

  it("splits several frames delivered in one chunk", () => {
    const { peer, events } = makePeer({})
    peer.ingest(
      JSON.stringify({ type: "message_start" }) +
        "\n" +
        JSON.stringify({ type: "message_end" }) +
        "\n"
    )
    expect(events.map((e) => e.type)).toEqual(["message_start", "message_end"])
  })

  it("treats non-JSON stdout as terminal and closes", () => {
    const { peer, errors } = makePeer({})
    peer.ingest("this is not json\n")

    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(PiFrameError)
    // Closed: further traffic must not be processed on a stream we no longer trust.
    peer.ingest(JSON.stringify({ type: "message_start" }) + "\n")
    expect(errors).toHaveLength(1)
  })

  it("rejects a frame that is valid JSON but not a typed object", () => {
    const { peer, errors } = makePeer({})
    peer.ingest("[1,2,3]\n")
    expect(errors[0].message).toMatch(/not a JSON object/)
  })

  it("rejects an object with no string type", () => {
    const { peer, errors } = makePeer({})
    peer.ingest('{"id":"x"}\n')
    expect(errors[0].message).toMatch(/missing a string `type`/)
  })

  it("stops processing later frames in a chunk once one is fatal", () => {
    const { peer, events, errors } = makePeer({})
    peer.ingest('nope\n{"type":"message_start"}\n')
    expect(errors).toHaveLength(1)
    expect(events).toHaveLength(0)
  })

  it("rejects in-flight commands when the transport dies", async () => {
    const { peer } = makePeer({})
    const promise = peer.sendCommand("get_state")
    peer.rejectAll("Pi process exited")
    await expect(promise).rejects.toThrow("Pi process exited (command: get_state)")
  })

  it("rejects a command whose write fails", async () => {
    const { peer } = createPeer({
      writeRaw: () => {
        throw new Error("EPIPE")
      },
    })
    await expect(peer.sendCommand("get_state")).rejects.toThrow("EPIPE")
    expect(peer.pendingCount).toBe(0)
  })

  it("refuses new commands after close", async () => {
    const { peer } = makePeer({})
    peer.close()
    await expect(peer.sendCommand("get_state")).rejects.toThrow("closed")
  })

  it("is idempotent on close", async () => {
    const { peer } = makePeer({})
    const promise = peer.sendCommand("get_state")
    const assertion = expect(promise).rejects.toThrow("first")
    peer.close("first")
    peer.close("second")
    await assertion
  })

  it("reports a stream that ended mid-frame", () => {
    const { peer, errors } = makePeer({})
    peer.ingest('{"type":"message_up')
    peer.endOfStream()
    expect(errors[0].message).toMatch(/ended mid-frame/)
  })

  it("quotes enough of the broken frame to recognise what was lost", () => {
    const { peer, errors } = makePeer({})
    peer.ingest('{"type":"message_update","content":"the answer began like thi')
    peer.endOfStream()
    // A length alone says nothing. The head of the frame is the only evidence
    // of what the agent was in the middle of saying.
    expect(errors[0].message).toContain("message_update")
  })

  it("delivers a final frame that only lacked its newline", () => {
    const events: PiEventFrame[] = []
    const { peer, errors } = makePeer({ onEvent: (e) => void events.push(e) })
    // A program writing its last line without a terminator is ordinary. The
    // frame is whole, so discarding it lost a real message and failed the turn
    // over a missing byte.
    peer.ingest(JSON.stringify({ type: "agent_settled", reason: "done" }))
    peer.endOfStream()
    expect(errors).toHaveLength(0)
    expect(events).toEqual([{ type: "agent_settled", reason: "done" }])
  })

  it("still answers a pending command from an unterminated final response", async () => {
    const { peer } = makePeer({})
    const promise = peer.sendCommand("get_state")
    peer.ingest(
      JSON.stringify({
        type: "response",
        command: "get_state",
        id: "cognia-1",
        success: true,
        data: { ok: true },
      })
    )
    peer.endOfStream()
    await expect(promise).resolves.toEqual({ ok: true })
  })

  it("stays quiet when the stream ends on a frame boundary", () => {
    const { peer, errors } = makePeer({})
    peer.ingest(JSON.stringify({ type: "agent_settled" }) + "\n")
    peer.endOfStream()
    expect(errors).toHaveLength(0)
  })

  it("reports a framing violation instead of throwing out of ingest", () => {
    const written: string[] = []
    const errors: PiFrameError[] = []
    const peer = new PiRpcPeer({
      writeRaw: (f) => void written.push(f),
      onProtocolError: (e) => void errors.push(e),
      defaultTimeout: 10,
    })
    // No newline, past the ceiling — the decoder throws internally and the
    // peer must convert it rather than unwinding a stdout handler.
    expect(() => peer.ingest("x".repeat(PI_MAX_BUFFER_BYTES + 1))).not.toThrow()
    expect(errors).toHaveLength(1)
  })
})

describe("isCompleteFrame", () => {
  it("accepts a whole frame with no terminator", () => {
    expect(isCompleteFrame('{"type":"agent_settled"}')).toBe(true)
  })
  it("rejects a truncated one", () => {
    expect(isCompleteFrame('{"type":"agent_set')).toBe(false)
  })
  it("rejects valid JSON that is not a frame", () => {
    // Parsing is not enough. A bare array or a typeless object would be routed
    // as a frame and then fail deeper, where the cause is harder to see.
    expect(isCompleteFrame("[1,2,3]")).toBe(false)
    expect(isCompleteFrame('{"id":"x"}')).toBe(false)
  })
})

describe("frameHint", () => {
  it("keeps the head and marks what it dropped", () => {
    const hint = frameHint("x".repeat(400))
    expect(hint.length).toBeLessThanOrEqual(161)
    expect(hint.endsWith("…")).toBe(true)
  })
  it("collapses whitespace so a pretty-printed frame stays one line", () => {
    expect(frameHint('{\n  "type": "a"\n}')).toBe('{ "type": "a" }')
  })
  it("leaves a short frame whole", () => {
    expect(frameHint('{"type":"a"}')).toBe('{"type":"a"}')
  })
})
