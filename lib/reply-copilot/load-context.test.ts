jest.mock("@/lib/db/adapter-instances", () => ({ getAdapterInstance: jest.fn() }))
jest.mock("@/lib/db/messages", () => ({ listRecentMessages: jest.fn() }))
jest.mock("@/lib/db/platform-identities", () => ({
  getByPlatformUser: jest.fn(),
  contactProfileOf: (row: { relationship?: string; note?: string }) => ({
    ...(row.relationship ? { relationship: row.relationship } : {}),
    ...(row.note ? { note: row.note } : {}),
  }),
}))
jest.mock("@/lib/memory/retrieve/retriever", () => ({ retrieveMemories: jest.fn() }))

import type { AppSettings } from "@cognia/agent-config-types"
import type { PlatformIdentityRow } from "@/lib/db/connector-types"
import type { TranscriptRow } from "./build-state"
import { copilotMemoryAllowed, loadCopilotContext, type LoadContextDeps } from "./load-context"

const inbound: TranscriptRow = {
  role: "user",
  parts: [{ type: "text", text: "你到了吗" }],
  metadata: {
    platformMessage: {
      messageId: "m1",
      platform: "telegram",
      sender: { id: "pid_x", platform: "telegram", remoteUserId: "u1", displayName: "Ann" },
    },
  },
}

const echo: TranscriptRow = {
  role: "user",
  parts: [{ type: "text", text: "马上到" }],
  metadata: {
    platformMessage: {
      messageId: "m2",
      platform: "telegram",
      sender: { id: "pid_bot", platform: "telegram", remoteUserId: "bot-1", displayName: "Me" },
    },
  },
}

const optedIn = {
  composerAssistance: { replyCopilot: { memory: true } },
  memory: { enabled: true, useMemory: true },
} as unknown as AppSettings

function deps(overrides: Partial<LoadContextDeps> = {}): LoadContextDeps {
  return {
    listRows: async () => [inbound, echo],
    selfPlatformIds: async () => new Set(["bot-1"]),
    resolveContact: async () =>
      ({ id: "pid_x", displayName: "Ann", relationship: "sister" }) as PlatformIdentityRow,
    recall: async () => ["likes hotpot"],
    ...overrides,
  }
}

const session = {
  id: "s1",
  platformBinding: { adapterId: "tg1", conversationKey: "telegram:tg1:42" },
} as never

describe("copilotMemoryAllowed", () => {
  it("needs both the copilot opt-in and a recall-allowing policy", () => {
    expect(copilotMemoryAllowed({}, optedIn)).toBe(true)
    expect(copilotMemoryAllowed({ memoryUse: false }, optedIn)).toBe(false)
    expect(copilotMemoryAllowed({}, { ...optedIn, composerAssistance: {} } as AppSettings)).toBe(
      false
    )
    expect(
      copilotMemoryAllowed({}, { ...optedIn, memory: { enabled: false } } as unknown as AppSettings)
    ).toBe(false)
    expect(copilotMemoryAllowed({}, null)).toBe(false)
  })
})

describe("loadCopilotContext", () => {
  it("classifies the bot's own echo as me and reads the contact + memory", async () => {
    const resolveContact = jest.fn(deps().resolveContact)
    const recall = jest.fn(async () => ["likes hotpot"])
    const ctx = await loadCopilotContext(session, optedIn, deps({ resolveContact, recall }))
    expect(ctx.transcript.turns).toEqual([
      { from: "other", text: "你到了吗" },
      { from: "me", text: "马上到" },
    ])
    expect(resolveContact).toHaveBeenCalledWith({
      sender: expect.objectContaining({ remoteUserId: "u1" }),
      conversationKey: "telegram:tg1:42",
      isGroup: false,
    })
    expect(ctx.knowledge).toMatchObject({ relationship: "sister", memoryLines: 1 })
    expect(recall).toHaveBeenCalledWith(optedIn, expect.any(String))
  })

  it("does not recall without the opt-in", async () => {
    const recall = jest.fn(async () => ["x"])
    const ctx = await loadCopilotContext(session, {} as AppSettings, deps({ recall }))
    expect(recall).not.toHaveBeenCalled()
    expect(ctx.knowledge.memorySkipped).toBe("disabled")
  })
})
