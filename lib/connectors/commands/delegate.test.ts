import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { ExecutionRun } from "@/types/execution/run"

import { handleDelegateCommand, type DelegateCommandDeps } from "./delegate"

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

const run = (over: Partial<ExecutionRun> = {}): ExecutionRun =>
  ({
    id: "execution:agent-turn:t1",
    kind: "agent-turn",
    sourceId: "t1",
    sessionId: "s1",
    title: "Rewrite the importer",
    status: "running",
    currentRevision: 3,
    startedAt: 1,
    updatedAt: 2,
    ...over,
  }) as ExecutionRun

function deps(over: Partial<DelegateCommandDeps> = {}): DelegateCommandDeps {
  return {
    listBindings: async () => [{ runId: "execution:agent-turn:t1" }],
    getRun: async () => run(),
    accept: jest.fn(async () => ({ runId: "execution:delegation:x", created: true })),
    adopt: jest.fn(async () => true),
    loadSession: async () => ({ id: "s1" }),
    ...over,
  }
}

describe("/delegate", () => {
  it("promotes the turn already in flight rather than starting anything", async () => {
    // Promotion is the point: a turn earns a delegation when there is evidence
    // it is long, not because someone guessed up front.
    const accept = jest.fn(async () => ({ runId: "execution:delegation:x", created: true }))
    const adopt = jest.fn(async () => true)
    const reply = jest.fn(async () => undefined)

    await handleDelegateCommand({
      event: event(),
      arg: "",
      reply,
      deps: deps({ accept, adopt }),
    })

    expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({
        // Keyed on the promoted run, so a repeated `/delegate` is the same
        // commitment rather than a second card.
        delegationId: "execution:agent-turn:t1",
        title: "Rewrite the importer",
        sessionId: "s1",
        initiator: expect.objectContaining({ remoteUserId: "ou-user" }),
      })
    )
    expect(adopt).toHaveBeenCalledWith("execution:agent-turn:t1", "execution:delegation:x")
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("steer:"), "applied")
  })

  it("uses a supplied title so the card says what the work is", async () => {
    const accept = jest.fn(async () => ({ runId: "execution:delegation:x", created: true }))
    await handleDelegateCommand({
      event: event(),
      arg: "Q3 billing migration",
      reply: jest.fn(async () => undefined),
      deps: deps({ accept }),
    })
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ title: "Q3 billing migration" }))
  })

  it("says so when nothing is running", async () => {
    const accept = jest.fn()
    const reply = jest.fn(async () => undefined)
    await handleDelegateCommand({
      event: event(),
      arg: "",
      reply,
      deps: deps({ listBindings: async () => [], accept: accept as never }),
    })
    expect(accept).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Nothing is running"), "unknown")
  })

  it("refuses to promote a settled run", async () => {
    const accept = jest.fn()
    const reply = jest.fn(async () => undefined)
    await handleDelegateCommand({
      event: event(),
      arg: "",
      reply,
      deps: deps({ getRun: async () => run({ status: "completed" }), accept: accept as never }),
    })
    expect(accept).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Nothing is running"), "unknown")
  })

  it("does not stack a second delegation on work already being carried", async () => {
    const accept = jest.fn()
    const reply = jest.fn(async () => undefined)
    await handleDelegateCommand({
      event: event(),
      arg: "",
      reply,
      deps: deps({
        getRun: async () => run({ parentRunId: "execution:delegation:already" }),
        accept: accept as never,
      }),
    })
    expect(accept).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("already a delegated task"),
      "unknown"
    )
  })

  it("recognises the delegation run itself as already delegated", async () => {
    const accept = jest.fn()
    const reply = jest.fn(async () => undefined)
    await handleDelegateCommand({
      event: event(),
      arg: "",
      reply,
      deps: deps({
        getRun: async () => run({ kind: "delegation", id: "execution:delegation:d1" }),
        accept: accept as never,
      }),
    })
    expect(accept).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("already a delegated task"),
      "unknown"
    )
  })

  it("ignores kinds that already have their own long-form surface", async () => {
    // A plan or a goal reports progress on its own; wrapping one in a
    // delegation would give the person two cards for one piece of work.
    const accept = jest.fn()
    const reply = jest.fn(async () => undefined)
    await handleDelegateCommand({
      event: event(),
      arg: "",
      reply,
      deps: deps({ getRun: async () => run({ kind: "plan" }), accept: accept as never }),
    })
    expect(accept).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("Nothing is running"), "unknown")
  })

  it("still promotes when the conversation has no bound session, just uncarded", async () => {
    const accept = jest.fn(async () => ({ runId: "execution:delegation:x", created: true }))
    await handleDelegateCommand({
      event: event(),
      arg: "",
      reply: jest.fn(async () => undefined),
      deps: deps({ accept, loadSession: async () => undefined }),
    })
    expect(accept).toHaveBeenCalledWith(expect.not.objectContaining({ session: expect.anything() }))
  })
})
