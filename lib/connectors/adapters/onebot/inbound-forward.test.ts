import { resolveForwardContent } from "./inbound-forward"
import type { OneBotTransport, OneBotRpcResponse } from "./transport"

function makeTransport(send: jest.Mock): OneBotTransport {
  return {
    start: jest.fn(),
    send: send as unknown as OneBotTransport["send"],
    stop: jest.fn(),
  }
}

function okResponse(data: unknown): OneBotRpcResponse {
  return { status: "ok", retcode: 0, data, echo: "e" }
}

describe("resolveForwardContent", () => {
  it("fetches get_forward_msg and splices nodes into an unresolved forward segment", async () => {
    const nodes = [
      {
        type: "node",
        data: { nickname: "Bob", content: [{ type: "text", data: { text: "hi" } }] },
      },
    ]
    const send = jest.fn().mockResolvedValue(okResponse({ messages: nodes }))
    const transport = makeTransport(send)

    const event = {
      post_type: "message",
      message: [{ type: "forward", data: { id: "fwd-1" } }],
    }
    const result = (await resolveForwardContent(event, transport)) as typeof event

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].action).toBe("get_forward_msg")
    const seg = result.message[0] as { data: { content?: unknown } }
    expect(seg.data.content).toEqual(nodes)
  })

  it("accepts a get_forward_msg response using the `message` key", async () => {
    const nodes = [{ type: "node", data: { content: [] } }]
    const send = jest.fn().mockResolvedValue(okResponse({ message: nodes }))
    const event = { message: [{ type: "forward", data: { id: "fwd-2" } }] }
    const result = (await resolveForwardContent(event, makeTransport(send))) as typeof event
    expect((result.message[0] as { data: { content?: unknown } }).data.content).toEqual(nodes)
  })

  it("leaves the segment untouched when the fetch fails", async () => {
    const send = jest.fn().mockRejectedValue(new Error("timeout"))
    const event = { message: [{ type: "forward", data: { id: "fwd-3" } }] }
    const result = (await resolveForwardContent(event, makeTransport(send))) as typeof event
    expect((result.message[0] as { data: { content?: unknown } }).data.content).toBeUndefined()
  })

  it("leaves the segment untouched on a non-ok response", async () => {
    const send = jest
      .fn()
      .mockResolvedValue({ status: "failed", retcode: 1, data: null, echo: "e" })
    const event = { message: [{ type: "forward", data: { id: "fwd-4" } }] }
    const result = (await resolveForwardContent(event, makeTransport(send))) as typeof event
    expect((result.message[0] as { data: { content?: unknown } }).data.content).toBeUndefined()
  })

  it("skips forward segments that already carry inlined content (zero RPC)", async () => {
    const send = jest.fn()
    const event = {
      message: [{ type: "forward", data: { id: "x", content: [{ type: "node", data: {} }] } }],
    }
    await resolveForwardContent(event, makeTransport(send))
    expect(send).not.toHaveBeenCalled()
  })

  it("does nothing (zero RPC) when there is no forward segment", async () => {
    const send = jest.fn()
    const event = { message: [{ type: "text", data: { text: "hello" } }] }
    const result = await resolveForwardContent(event, makeTransport(send))
    expect(send).not.toHaveBeenCalled()
    expect(result).toBe(event)
  })

  it("ignores CQ-code string messages and non-object events", async () => {
    const send = jest.fn()
    expect(
      await resolveForwardContent({ message: "[CQ:forward,id=1]" }, makeTransport(send))
    ).toEqual({
      message: "[CQ:forward,id=1]",
    })
    expect(await resolveForwardContent(null, makeTransport(send))).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })

  it("skips a forward segment missing an id", async () => {
    const send = jest.fn()
    const event = { message: [{ type: "forward", data: {} }] }
    await resolveForwardContent(event, makeTransport(send))
    expect(send).not.toHaveBeenCalled()
  })
})
