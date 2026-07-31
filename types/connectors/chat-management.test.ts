import { ChatManagementScopeError } from "./chat-management"
import type {
  ChatMembersResult,
  ContactCandidate,
  CreateChatInput,
  CreateChatResult,
} from "./chat-management"
import { ALL_CAPABILITIES, hasCapability } from "./capability"

describe("chat-management types", () => {
  it("ChatManagementScopeError carries the required scope and platform", () => {
    const err = new ChatManagementScopeError("missing scope", "im:chat:create", "lark")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("ChatManagementScopeError")
    expect(err.requiredScope).toBe("im:chat:create")
    expect(err.platform).toBe("lark")
    expect(err.message).toBe("missing scope")
  })

  it("the four chat-management capability flags are registered", () => {
    for (const cap of ["chat.create", "chat.members", "chat.update", "contact.resolve"] as const) {
      expect(ALL_CAPABILITIES).toContain(cap)
      expect(hasCapability(ALL_CAPABILITIES, cap)).toBe(true)
    }
  })

  it("shapes round-trip as plain data (wire-compatible)", () => {
    const input: CreateChatInput = {
      name: "Project X",
      memberIds: ["ou_a", "ou_b"],
      description: "desc",
      idempotencyKey: "idem-1",
    }
    const result: CreateChatResult = { chatId: "oc_1", invalidMemberIds: ["ou_b"] }
    const members: ChatMembersResult = {
      succeeded: ["ou_a"],
      failed: [{ id: "ou_b", reason: "invalid" }],
    }
    const candidate: ContactCandidate = {
      memberId: "ou_a",
      displayName: "Alice",
      email: "a@x.com",
      confidence: "exact",
    }
    expect(JSON.parse(JSON.stringify({ input, result, members, candidate }))).toEqual({
      input,
      result,
      members,
      candidate,
    })
  })
})
