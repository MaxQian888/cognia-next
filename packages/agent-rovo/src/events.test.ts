/** @jest-environment node */
import { decodeRovoEvent, readRovoStream } from "./events"

describe("Rovo Dev native event contract", () => {
  it("decodes Atlassian part wrappers without dropping fragmented JSON", () => {
    expect(
      decodeRovoEvent("part_delta", {
        delta: { part_delta_kind: "tool_call", tool_call_id: "t", args_delta: '{"a":' },
      })
    ).toEqual({
      kind: "tool-call",
      data: { part_delta_kind: "tool_call", tool_call_id: "t", args_delta: '{"a":' },
    })
  })
  it("preserves named SSE events, comments and split frames", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const t of [
          ": keepalive\n\nevent: te",
          'xt\ndata: {"content_delta":"ok"}\n\nevent: close\ndata: {}\n\n',
        ])
          c.enqueue(new TextEncoder().encode(t))
        c.close()
      },
    })
    const events = []
    for await (const e of readRovoStream(body)) events.push(e)
    expect(events).toEqual([
      { kind: "text", data: { content_delta: "ok" } },
      { kind: "close", data: {} },
    ])
  })
  it("rejects unknown execution events and malformed known events", () => {
    expect(() => decodeRovoEvent("imagined-success", {})).toThrow(/Unsupported/)
    expect(() => decodeRovoEvent("part_start", {})).toThrow(/Malformed/)
  })
})
