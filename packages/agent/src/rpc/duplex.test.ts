import { PassThrough } from "node:stream"

import {
  createLineReader,
  RpcFrameSink,
  RpcStreamSource,
  utf8ByteLength,
  type RpcReadable,
} from "./duplex"
import { RpcPeer } from "./peer"

function collectLines(readable: RpcReadable) {
  const lines: string[] = []
  let closed = false
  const reader = createLineReader(readable, {
    onLine: (line) => lines.push(line),
    onClose: () => {
      closed = true
    },
  })
  return { lines, reader, isClosed: () => closed }
}

describe("utf8ByteLength", () => {
  it("agrees with Buffer.byteLength across every UTF-8 width", () => {
    // The peer measures frames against the negotiated limit with this function
    // while the host measures the same bytes with a real UTF-8 encoder. A
    // disagreement in either direction is a protocol break, not a rounding
    // detail: too small and we ship a frame the host rejects, too large and we
    // refuse a frame that would have been legal.
    for (const sample of [
      "",
      "plain ascii",
      "ünïcödé",
      "中文内容",
      "🙂🙃",
      "mixed 中 🙂 ascii",
      '{"jsonrpc":"2.0","id":1,"method":"runtime/status"}',
    ]) {
      expect(utf8ByteLength(sample)).toBe(Buffer.byteLength(sample, "utf8"))
    }
  })

  it("counts a lone surrogate as the replacement character, never as zero", () => {
    const loneHigh = "\ud83d"
    const loneLow = "\ude42"
    expect(utf8ByteLength(loneHigh)).toBe(Buffer.byteLength(loneHigh, "utf8"))
    expect(utf8ByteLength(loneLow)).toBe(Buffer.byteLength(loneLow, "utf8"))
    expect(utf8ByteLength(loneHigh)).toBe(3)
  })
})

describe("createLineReader", () => {
  it("splits on LF and CRLF and strips the delimiter", () => {
    const source = new RpcStreamSource()
    const { lines } = collectLines(source)

    source.push("one\ntwo\r\nthree\n")

    expect(lines).toEqual(["one", "two", "three"])
  })

  it("does not invent an empty line when CRLF straddles two chunks", () => {
    // `readline` with `crlfDelay: Infinity` holds a trailing `\r` back for
    // exactly this case. Emitting "four" then "" would feed the peer an empty
    // line, and an empty line is not valid JSON.
    const source = new RpcStreamSource()
    const { lines } = collectLines(source)

    source.push("four\r")
    source.push("\nfive\n")

    expect(lines).toEqual(["four", "five"])
  })

  it("flushes a trailing partial line once, before reporting close", () => {
    const source = new RpcStreamSource()
    const { lines, isClosed } = collectLines(source)

    source.push("no newline yet")
    expect(lines).toEqual([])

    source.end()
    expect(lines).toEqual(["no newline yet"])
    expect(isClosed()).toBe(true)

    source.end()
    expect(lines).toEqual(["no newline yet"])
  })

  it("decodes a multi-byte character split across two binary chunks", () => {
    const readable = new PassThrough()
    const { lines } = collectLines(readable)
    const encoded = Buffer.from("中文\n", "utf8")

    readable.write(encoded.subarray(0, 2))
    readable.write(encoded.subarray(2))

    expect(lines).toEqual(["中文"])
    readable.end()
  })

  it("stops delivering lines once closed by the caller", () => {
    const source = new RpcStreamSource()
    const { lines, reader, isClosed } = collectLines(source)

    reader.close()
    expect(isClosed()).toBe(true)
    source.push("ignored\n")

    expect(lines).toEqual([])
  })

  it("reads a real node stream unchanged", () => {
    const readable = new PassThrough()
    const { lines } = collectLines(readable)

    readable.write("from-node\n")

    expect(lines).toEqual(["from-node"])
    readable.end()
  })
})

describe("RpcFrameSink", () => {
  it("emits one newline-free frame per message and never an empty one", () => {
    // The worker ingress rejects any frame containing a newline outright, so
    // the delimiter has to be consumed here rather than forwarded.
    const frames: string[] = []
    const sink = new RpcFrameSink((frame) => frames.push(frame))

    sink.write('{"a":1}\n')
    sink.write("\n")
    sink.write('{"b":2}\n{"c":3}\n')

    expect(frames).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
    expect(frames.every((frame) => !frame.includes("\n"))).toBe(true)
  })

  it("holds a partial frame until its delimiter arrives", () => {
    const frames: string[] = []
    const sink = new RpcFrameSink((frame) => frames.push(frame))

    sink.write('{"split"')
    expect(frames).toEqual([])

    sink.write(":true}\n")
    expect(frames).toEqual(['{"split":true}'])
  })

  it("surfaces a failing transport as a stream error instead of throwing at the writer", () => {
    // The peer tears the connection down from `error`; letting the throw escape
    // would instead reject whichever `call()` happened to be writing and leave
    // every other pending request hanging.
    const errors: Error[] = []
    const sink = new RpcFrameSink(() => {
      throw new Error("connection is unavailable")
    })
    sink.on("error", (error: Error) => errors.push(error))

    expect(sink.write('{"a":1}\n')).toBe(false)
    expect(errors.map((error) => error.message)).toEqual(["connection is unavailable"])
  })

  it("refuses writes after end", () => {
    const frames: string[] = []
    const sink = new RpcFrameSink((frame) => frames.push(frame))

    sink.end()

    expect(sink.write('{"a":1}\n')).toBe(false)
    expect(frames).toEqual([])
  })
})

describe("RpcPeer over the neutral duplex", () => {
  it("completes a request/response round trip without any node stream", async () => {
    // This is the shape the desktop WebView uses: frames arrive out-of-band
    // from an IPC channel and leave through an invoke, with no child process
    // and no `node:stream` anywhere in the graph.
    const inbound = new RpcStreamSource()
    const outbound: string[] = []
    const peer = new RpcPeer({
      readable: inbound,
      writable: new RpcFrameSink((frame) => {
        outbound.push(frame)
        const request = JSON.parse(frame) as { id: number }
        inbound.push(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n`)
      }),
    })

    await expect(peer.call("runtime/status", {}, { timeoutMs: 1_000 })).resolves.toEqual({})
    expect(outbound).toHaveLength(1)
    expect(JSON.parse(outbound[0]!)).toMatchObject({ method: "runtime/status" })

    peer.close()
  })

  it("rejects every in-flight call when the transport drops", async () => {
    const inbound = new RpcStreamSource()
    const peer = new RpcPeer({ readable: inbound, writable: new RpcFrameSink(() => {}) })

    const pending = peer.call("runtime/status", {}, { timeoutMs: 1_000 })
    inbound.end()

    await expect(pending).rejects.toThrow("connection closed")
  })
})
