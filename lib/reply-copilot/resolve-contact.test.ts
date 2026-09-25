import type { PlatformIdentityRow } from "@/lib/db/connector-types"

jest.mock("@/lib/db/platform-identities", () => ({ getByPlatformUser: jest.fn() }))
jest.mock("@/lib/connectors/session-bindings", () => ({ findSessionByConversationKey: jest.fn() }))
jest.mock("@/lib/db/messages", () => ({ listRecentMessages: jest.fn() }))
jest.mock("@/lib/db/adapter-instances", () => ({ getAdapterInstance: jest.fn() }))

import { getAdapterInstance } from "@/lib/db/adapter-instances"
import type { TranscriptRow } from "./build-state"
import {
  resolveConversationContact,
  resolveCopilotContact,
  selfPlatformIdsForAdapter,
} from "./resolve-contact"

const row = (remoteUserId: string) =>
  ({ id: `pid_${remoteUserId}`, platform: "slack", remoteUserId }) as PlatformIdentityRow

describe("resolveCopilotContact", () => {
  it("resolves the latest sender through the directory", async () => {
    const getByPlatformUser = jest.fn(async () => row("U1"))
    const found = await resolveCopilotContact(
      {
        sender: { platform: "slack", remoteUserId: "U1" },
        conversationKey: "slack:a1:D9",
        isGroup: false,
      },
      { getByPlatformUser }
    )
    expect(found?.id).toBe("pid_U1")
    expect(getByPlatformUser).toHaveBeenCalledWith("slack", "U1")
  })

  it("never treats a DM channel id as a user id when a sender is known", async () => {
    const getByPlatformUser = jest.fn(async () => undefined)
    const found = await resolveCopilotContact(
      {
        sender: { platform: "slack", remoteUserId: "U1" },
        conversationKey: "slack:a1:D9",
        isGroup: false,
      },
      { getByPlatformUser }
    )
    expect(found).toBeNull()
    expect(getByPlatformUser).toHaveBeenCalledTimes(1)
  })

  it("falls back to the chat id only for a sender-less one-to-one chat", async () => {
    const getByPlatformUser = jest.fn(async (_p: string, id: string) =>
      id === "42" ? row("42") : undefined
    )
    expect(
      (
        await resolveCopilotContact(
          { sender: null, conversationKey: "telegram:tg1:42", isGroup: false },
          { getByPlatformUser }
        )
      )?.id
    ).toBe("pid_42")
    expect(
      await resolveCopilotContact(
        { sender: null, conversationKey: "telegram:tg1:42", isGroup: true },
        { getByPlatformUser }
      )
    ).toBeNull()
    expect(
      await resolveCopilotContact(
        { sender: null, conversationKey: "bad", isGroup: false },
        { getByPlatformUser }
      )
    ).toBeNull()
    expect(
      await resolveCopilotContact({ sender: null, isGroup: false }, { getByPlatformUser })
    ).toBeNull()
  })
})

function inbound(userId: string): TranscriptRow {
  return {
    role: "user",
    parts: [{ type: "text", text: `from ${userId}` }],
    metadata: {
      platformMessage: {
        messageId: `m-${userId}`,
        platform: "slack",
        sender: { id: `pid-${userId}`, platform: "slack", remoteUserId: userId },
      },
    },
  }
}

describe("resolveConversationContact", () => {
  const getByPlatformUser = jest.fn(async (_p: string, id: string) => row(id))

  it("resolves the DM contact by the latest sender, not the channel id", async () => {
    const found = await resolveConversationContact("slack:a1:D9", {
      getByPlatformUser,
      recentRows: async () => [inbound("U1")],
      selfPlatformIds: async () => new Set(),
    })
    expect(found?.id).toBe("pid_U1")
  })

  it("returns null for a group and for malformed keys", async () => {
    expect(
      await resolveConversationContact("slack:a1:C1", {
        getByPlatformUser,
        recentRows: async () => [inbound("U1"), inbound("U2")],
        selfPlatformIds: async () => new Set(),
      })
    ).toBeNull()
    expect(
      await resolveConversationContact("bad", {
        getByPlatformUser,
        recentRows: async () => [],
        selfPlatformIds: async () => new Set(),
      })
    ).toBeNull()
  })

  it("ignores the bot's own echoes when counting senders", async () => {
    const found = await resolveConversationContact("slack:a1:D9", {
      getByPlatformUser,
      recentRows: async () => [inbound("U1"), inbound("BOT")],
      selfPlatformIds: async () => new Set(["BOT"]),
    })
    expect(found?.id).toBe("pid_U1")
  })
})

describe("selfPlatformIdsForAdapter", () => {
  it("collects the confirmed account and bot ids", async () => {
    ;(getAdapterInstance as jest.Mock).mockResolvedValueOnce({
      selfIdentity: {
        platformAccountId: "A",
        platformBotId: "B",
        source: "whoami",
        confirmedAt: 1,
      },
    })
    expect(await selfPlatformIdsForAdapter("a1")).toEqual(new Set(["A", "B"]))
    ;(getAdapterInstance as jest.Mock).mockRejectedValueOnce(new Error("db"))
    expect(await selfPlatformIdsForAdapter("a1")).toEqual(new Set())
  })
})
