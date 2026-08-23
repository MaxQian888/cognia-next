import { createRunHandle } from "./run-handle"
import type { AgentEventEnvelope, AgentTurnOutcome, CommandReceipt } from "./types"

const envelope = (id: string): AgentEventEnvelope => ({
  eventId: id,
  sequence: 0,
  event: { kind: "text-delta" },
})

function stream(ids: readonly string[]): AsyncIterable<AgentEventEnvelope> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const id of ids) yield envelope(id)
    },
  }
}

const completed: AgentTurnOutcome = {
  status: "completed",
  result: { status: "completed", text: "done" },
}

describe("createRunHandle", () => {
  it("exposes the identity a caller needs to retry idempotently", () => {
    const handle = createRunHandle({
      sessionId: "s1",
      commandId: "cmd-1",
      startCursor: "head-0",
      subscribe: () => stream([]),
      result: Promise.resolve(completed),
      abort: async () => ({ commandId: "cmd-1" }),
    })
    expect(handle.sessionId).toBe("s1")
    expect(handle.commandId).toBe("cmd-1")
    expect(handle.cursor).toBe("head-0")
  })

  it("advances the cursor as events are consumed", async () => {
    const handle = createRunHandle({
      sessionId: "s1",
      commandId: "cmd-1",
      startCursor: "head-0",
      subscribe: () => stream(["e1", "e2", "e3"]),
      result: Promise.resolve(completed),
      abort: async () => ({ commandId: "cmd-1" }),
    })
    const seen: string[] = []
    for await (const event of handle.events()) {
      seen.push(event.eventId)
      expect(handle.cursor).toBe(event.eventId)
    }
    expect(seen).toEqual(["e1", "e2", "e3"])
    expect(handle.cursor).toBe("e3")
  })

  it("anchors every stream at the pre-run head so a late reader sees the whole turn", async () => {
    const anchors: (string | undefined)[] = []
    const handle = createRunHandle({
      sessionId: "s1",
      commandId: "cmd-1",
      startCursor: "head-0",
      subscribe: (afterEventId) => {
        anchors.push(afterEventId)
        return stream(["e1"])
      },
      result: Promise.resolve(completed),
      abort: async () => ({ commandId: "cmd-1" }),
    })
    for await (const _ of handle.events()) void _
    for await (const _ of handle.events()) void _
    // Both streams replay from the same anchor, not from the moved cursor.
    expect(anchors).toEqual(["head-0", "head-0"])
  })

  it("passes the caller's capacity and signal through to the subscription", async () => {
    const received: unknown[] = []
    const controller = new AbortController()
    const handle = createRunHandle({
      sessionId: "s1",
      commandId: "cmd-1",
      startCursor: undefined,
      subscribe: (_after, options) => {
        received.push(options)
        return stream([])
      },
      result: Promise.resolve(completed),
      abort: async () => ({ commandId: "cmd-1" }),
    })
    for await (const _ of handle.events({ capacity: 16, signal: controller.signal })) void _
    expect(received).toEqual([{ capacity: 16, signal: controller.signal }])
  })

  it("forwards an abort reason", async () => {
    const reasons: (string | undefined)[] = []
    const handle = createRunHandle({
      sessionId: "s1",
      commandId: "cmd-1",
      startCursor: undefined,
      subscribe: () => stream([]),
      result: Promise.resolve(completed),
      abort: async (reason): Promise<CommandReceipt> => {
        reasons.push(reason)
        return { commandId: "cmd-1", accepted: true }
      },
    })
    await expect(handle.abort("operator cancelled")).resolves.toMatchObject({ accepted: true })
    expect(reasons).toEqual(["operator cancelled"])
  })

  it("does not raise an unhandled rejection when the caller ignores the result", async () => {
    const handle = createRunHandle({
      sessionId: "s1",
      commandId: "cmd-1",
      startCursor: undefined,
      subscribe: () => stream([]),
      result: Promise.reject(new Error("turn exploded")),
      abort: async () => ({ commandId: "cmd-1" }),
    })
    // The handle attaches its own catch; awaiting later still sees the error.
    await new Promise((resolve) => setTimeout(resolve, 5))
    await expect(handle.result).rejects.toThrow("turn exploded")
  })
})
