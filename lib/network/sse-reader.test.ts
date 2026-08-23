import { readServerSentEvents } from "./sse-reader"

function streamOf(...pieces: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece))
      controller.close()
    },
  })
}

async function collect(body: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = []
  for await (const data of readServerSentEvents(body)) out.push(data)
  return out
}

describe("readServerSentEvents", () => {
  it("yields the data payload of each blank-line-delimited block", async () => {
    expect(await collect(streamOf('data: {"a":1}\n\ndata: {"b":2}\n\n'))).toEqual([
      '{"a":1}',
      '{"b":2}',
    ])
  })

  it("reassembles an event split across chunk boundaries", async () => {
    // The transport chunks wherever the socket did; an event is not guaranteed
    // to arrive whole, which is the entire reason this buffers.
    expect(await collect(streamOf('data: {"a":', "1}\n", "\n"))).toEqual(['{"a":1}'])
  })

  it("joins multi-line data fields with newlines", async () => {
    expect(await collect(streamOf("data: first\ndata: second\n\n"))).toEqual(["first\nsecond"])
  })

  it("ignores comments, event names and ids", async () => {
    expect(
      await collect(streamOf(": keep-alive\n\nevent: message\nid: 7\ndata: payload\n\n"))
    ).toEqual(["payload"])
  })

  it("accepts CRLF and bare-CR line endings", async () => {
    expect(await collect(streamOf("data: crlf\r\n\r\n"))).toEqual(["crlf"])
    expect(await collect(streamOf("data: cr\r\r"))).toEqual(["cr"])
  })

  it("emits a final event that arrives without a trailing blank line", async () => {
    // A server that closes right after writing is well-behaved; dropping its
    // last frame would silently truncate every short stream.
    expect(await collect(streamOf("data: one\n\ndata: last\n"))).toEqual(["one", "last"])
  })

  it("skips blocks with no data field rather than yielding empty strings", async () => {
    expect(await collect(streamOf("event: ping\n\ndata: real\n\n"))).toEqual(["real"])
  })

  it("yields nothing for an empty stream", async () => {
    expect(await collect(streamOf())).toEqual([])
  })

  it("releases the reader even when the consumer stops early", async () => {
    const body = streamOf("data: one\n\ndata: two\n\n")
    const iterator = readServerSentEvents(body)[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toBe("one")
    await iterator.return?.(undefined)

    // A leaked lock makes the body unreadable and un-cancellable, which shows
    // up much later as a stream that never tears down.
    await expect(body.cancel()).resolves.toBeUndefined()
  })

  it("propagates a stream error to the consumer", async () => {
    // Errored after the first block is consumed, not before: `controller.error`
    // discards whatever the stream still holds, so erroring up front would
    // never deliver "one" and the test would prove nothing about ordering.
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController
        controller.enqueue(new TextEncoder().encode("data: one\n\n"))
      },
    })

    const iterator = readServerSentEvents(body)[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toBe("one")
    controller.error(new Error("connection reset"))
    await expect(iterator.next()).rejects.toThrow("connection reset")
  })
})
