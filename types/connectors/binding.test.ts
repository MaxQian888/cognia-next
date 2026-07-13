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
})
