import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { ExecutionRun } from "@/types/execution/run"

import { handleHandoffCommand, type HandoffCommandDeps } from "./handoff"

const event = (): NormalizedInboundEvent =>
  ({
    platform: "lark",
    adapterId: "lark-1",
    selfId: "bot-1",
    messageId: "om-1",
    conversationRef: { platform: "lark", adapterId: "lark-1", channelId: "chat-1" },
    conversationKey: "lark:lark-1:chat-1",
    sender: {
      id: "identity-user",
      platform: "lark",
      adapterId: "lark-1",
      remoteUserId: "ou-user",
      displayName: "Dana",
    },
    channel: { id: "chat-1", kind: "private" },
    segments: [],
    plainText: "",
    mentions: { selfMentioned: false, users: [] },
    timestamp: 1,
    raw: {},
  }) as NormalizedInboundEvent

const delegation = (over: Partial<ExecutionRun> = {}): ExecutionRun =>
  ({
    id: "execution:delegation:d1",
    kind: "delegation",
    sourceId: "d1",
    title: "Migrate billing",
    status: "running",
    currentRevision: 4,
    startedAt: 1,
    updatedAt: 2,
    ...over,
  }) as ExecutionRun

function deps(over: Partial<HandoffCommandDeps> = {}): HandoffCommandDeps {
  return {
    listBindings: async () => [{ runId: "execution:delegation:d1", adapterId: "lark-1" }],
    getRun: async () => delegation(),
    listPendingInterrupts: async () => [],
    handOff: jest.fn(async () => ({ handedOff: true, interruptId: "i-1" })),
    execute: jest.fn(async () => ({ accepted: true })),
    operatorIds: [],
    ...over,
  }
}

describe("/handoff", () => {
  it("hands the running delegation to whoever typed it when given no name", async () => {
    const reply = jest.fn(async () => undefined)
    const handOff = jest.fn(async () => ({ handedOff: true, interruptId: "i-1" }))

    await handleHandoffCommand({ event: event(), arg: "", reply, deps: deps({ handOff }) })

    expect(handOff).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "execution:delegation:d1",
        assignee: expect.objectContaining({ kind: "human", id: "ou-user", label: "Dana" }),
      })
    )
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Dana"), "applied", undefined)
  })

  it("uses the named person and does not claim their platform id", async () => {
    // A typed label is a name, not an identity. Attaching the SENDER's id to
    // it would silently assign the work to the wrong person.
    const handOff = jest.fn(async () => ({ handedOff: true, interruptId: "i-1" }))
    await handleHandoffCommand({
      event: event(),
      arg: "Sam",
      reply: jest.fn(async () => undefined),
      deps: deps({ handOff }),
    })

    expect(handOff).toHaveBeenCalledWith(
      expect.objectContaining({ assignee: { kind: "human", label: "Sam" } })
    )
  })

  it("says so when nothing in this chat is delegated", async () => {
    const reply = jest.fn(async () => undefined)
    await handleHandoffCommand({
      event: event(),
      arg: "",
      reply,
      deps: deps({ getRun: async () => delegation({ status: "completed" }) }),
    })

    expect(reply).toHaveBeenCalledWith(expect.stringContaining("No delegated task"), "unknown")
  })

  it("only ever reaches a run bound to this conversation", async () => {
    // The binding is what makes a run belong to this thread, and it is the
    // same lookup the callback guard uses — so `/handoff` cannot reach a run
    // the caller could not already control from here.
    const reply = jest.fn(async () => undefined)
    const handOff = jest.fn()
    await handleHandoffCommand({
      event: event(),
      arg: "",
      reply,
      deps: deps({ listBindings: async () => [], handOff: handOff as never }),
    })

    expect(handOff).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("No delegated task"), "unknown")
  })

  it("refuses to hand off twice", async () => {
    const reply = jest.fn(async () => undefined)
    const handOff = jest.fn()
    await handleHandoffCommand({
      event: event(),
      arg: "Sam",
      reply,
      deps: deps({
        listPendingInterrupts: async () => [{ id: "i-1", type: "human_handoff", createdAt: 1 }],
        handOff: handOff as never,
      }),
    })

    expect(handOff).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("already handed off"), "unknown")
  })

  it("hands back through the same control gate every other verb uses", async () => {
    const execute = jest.fn(async () => ({ accepted: true }))
    const reply = jest.fn(async () => undefined)

    await handleHandoffCommand({
      event: event(),
      arg: "back start with the tests",
      reply,
      deps: deps({
        listPendingInterrupts: async () => [{ id: "i-1", type: "human_handoff", createdAt: 1 }],
        execute: execute as never,
      }),
    })

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "execution:delegation:d1",
        action: "resume",
        interruptId: "i-1",
        expectedRevision: 4,
        steerMessage: "start with the tests",
      }),
      { operatorIds: [] }
    )
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Handed back"), "applied", undefined)
  })

  it("reports a refused handback rather than claiming it landed", async () => {
    const reply = jest.fn(async () => undefined)
    await handleHandoffCommand({
      event: event(),
      arg: "back",
      reply,
      deps: deps({
        listPendingInterrupts: async () => [{ id: "i-1", type: "human_handoff", createdAt: 1 }],
        execute: (async () => ({ accepted: false, reason: "forbidden" })) as never,
      }),
    })

    expect(reply).toHaveBeenCalledWith(expect.stringContaining("not accepted"), "denied", {
      reason: "forbidden",
    })
  })

  it("refuses a handback on a task nobody holds", async () => {
    const reply = jest.fn(async () => undefined)
    const execute = jest.fn()
    await handleHandoffCommand({
      event: event(),
      arg: "back",
      reply,
      deps: deps({ execute: execute as never }),
    })

    expect(execute).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("not handed off"), "unknown")
  })
})
