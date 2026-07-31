import type { PlatformBinding } from "./binding"
import type { ChatSession } from "@cognia/agent-config-types"

describe("PlatformBinding", () => {
  it("attaches to ChatSession via platformBinding optional", () => {
    const binding: PlatformBinding = {
      adapterId: "tg-personal",
      conversationKey: "telegram:tg-personal:12345",
      platform: "telegram",
      conversationRef: { platform: "telegram", adapterId: "tg-personal", chatId: 12345 },
    }
    const session: ChatSession = {
      id: "s1",
      title: "DM with Alice",
      createdAt: 0,
      updatedAt: 0,
      platformBinding: binding,
    }
    expect(session.platformBinding?.platform).toBe("telegram")
  })

  it("persists the complete delivery target for scoped proactive replies", () => {
    const binding: PlatformBinding = {
      adapterId: "lark-main",
      conversationKey: "lark:lark-main:oc_1:omt_1",
      platform: "lark",
      conversationRef: { platform: "lark", adapterId: "lark-main", channelId: "oc_1" },
      deliveryTarget: {
        address: {
          conversationKey: "lark:lark-main:oc_1:omt_1",
          platform: "lark",
          adapterId: "lark-main",
          scopeKind: "thread",
          containerId: "oc_1",
          topicId: "omt_1",
        },
        conversationRef: {
          platform: "lark",
          adapterId: "lark-main",
          channelId: "oc_1",
          threadTs: "omt_1",
          threadRootMessageId: "om_anchor",
        },
        sourceMessageId: "om_anchor",
        refreshedAt: 10,
      },
    }

    expect(binding.deliveryTarget?.address.topicId).toBe("omt_1")
    expect(binding.deliveryTarget?.sourceMessageId).toBe("om_anchor")
  })
})
