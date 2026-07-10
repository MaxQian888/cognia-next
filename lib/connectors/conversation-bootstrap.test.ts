jest.mock("@/lib/connectors/session-bindings", () => ({
  findSessionByConversationKey: jest.fn(),
  createPlatformSession: jest.fn(),
}))

jest.mock("@/lib/connectors/audit", () => ({
  appendAudit: jest.fn().mockResolvedValue(undefined),
}))

import {
  createPlatformSession,
  findSessionByConversationKey,
} from "@/lib/connectors/session-bindings"
import { appendAudit } from "@/lib/connectors/audit"
import { bootstrapConversation } from "./conversation-bootstrap"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

const mFind = findSessionByConversationKey as jest.Mock
const mCreate = createPlatformSession as jest.Mock
const mAudit = appendAudit as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  mFind.mockResolvedValue(undefined)
  mCreate.mockResolvedValue({ id: "s_new" })
})

describe("bootstrapConversation", () => {
  it("mints the conversationKey and pre-creates a platform-bound session", async () => {
    const out = await bootstrapConversation({
      platform: "lark",
      adapterId: "a1",
      remoteChatId: "oc_x",
      name: "Project X",
      characterId: "c1",
      source: "im.create_chat",
    })
    expect(out).toEqual({ conversationKey: "lark:a1:oc_x", sessionId: "s_new", created: true })
    expect(mCreate).toHaveBeenCalledTimes(1)
    const [event, characterId] = mCreate.mock.calls[0] as [NormalizedInboundEvent, string]
    expect(characterId).toBe("c1")
    // Everything createPlatformSession reads must be present and correct.
    expect(event.platform).toBe("lark")
    expect(event.adapterId).toBe("a1")
    expect(event.conversationKey).toBe("lark:a1:oc_x")
    expect(event.conversationRef).toEqual({ platform: "lark", adapterId: "a1", channelId: "oc_x" })
    expect(event.channel).toEqual({
      id: "oc_x",
      name: "Project X",
      kind: "group",
      platformChannelId: "oc_x",
    })
    expect(event.sender.displayName).toBe("Project X")
    // Inert defaults — never mistaken for a real message.
    expect(event.segments).toEqual([])
    expect(event.plainText).toBe("")
    expect(event.kind).toBe("system")
    expect(event.messageId).toBe("bootstrap:lark:a1:oc_x")
  })

  it("audits conversation.created with provenance fields", async () => {
    await bootstrapConversation({
      platform: "lark",
      adapterId: "a1",
      remoteChatId: "oc_x",
      name: "Project X",
      source: "im.create_chat",
    })
    expect(mAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "a1",
        kind: "conversation.created",
        conversationKey: "lark:a1:oc_x",
        fields: expect.objectContaining({
          remoteChatId: "oc_x",
          name: "Project X",
          source: "im.create_chat",
        }),
      })
    )
  })

  it("omits optional audit fields and defaults the title when name/source are absent", async () => {
    await bootstrapConversation({ platform: "lark", adapterId: "a1", remoteChatId: "oc_x" })
    const [event, characterId] = mCreate.mock.calls[0] as [NormalizedInboundEvent, undefined]
    expect(characterId).toBeUndefined()
    expect(event.channel.name).toBeUndefined()
    expect(event.sender.displayName).toBeUndefined()
    const auditArg = mAudit.mock.calls[0][0] as { fields: Record<string, unknown> }
    expect(auditArg.fields).toEqual({ remoteChatId: "oc_x" })
  })

  it("is idempotent — an existing bound session is reused, nothing created or audited", async () => {
    mFind.mockResolvedValue({ id: "s_existing" })
    const out = await bootstrapConversation({
      platform: "lark",
      adapterId: "a1",
      remoteChatId: "oc_x",
    })
    expect(out).toEqual({
      conversationKey: "lark:a1:oc_x",
      sessionId: "s_existing",
      created: false,
    })
    expect(mCreate).not.toHaveBeenCalled()
    expect(mAudit).not.toHaveBeenCalled()
  })
})
