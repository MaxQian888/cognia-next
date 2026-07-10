jest.mock("./_helpers", () => ({
  ...jest.requireActual("./_helpers"),
  resolveChatCapableAdapter: jest.fn(),
  withScopeCapture: jest.fn((_id: string, fn: () => Promise<unknown>) => fn()),
}))

import { getSharedBuiltInSkillRegistry } from "../registry"
import "./members"
import { resolveChatCapableAdapter } from "./_helpers"

const mResolve = resolveChatCapableAdapter as jest.Mock
const mAdd = jest.fn()
const mRemove = jest.fn()

function skill(id: "im.invite_members" | "im.remove_members") {
  const s = getSharedBuiltInSkillRegistry()
    .list()
    .find((x) => x.id === id)
  if (!s) throw new Error(`${id} not registered`)
  return s
}

beforeEach(() => {
  jest.clearAllMocks()
  mResolve.mockResolvedValue({
    adapterId: "a1",
    platform: "lark",
    adapter: { addChatMembers: mAdd, removeChatMembers: mRemove },
  })
  mAdd.mockResolvedValue({ succeeded: ["ou_a"], failed: [] })
  mRemove.mockResolvedValue({ succeeded: ["ou_a"], failed: [] })
})

describe("im.invite_members / im.remove_members", () => {
  it("invites with an explicit chatId and returns the partial-failure shape", async () => {
    mAdd.mockResolvedValue({
      succeeded: ["ou_a"],
      failed: [{ id: "ou_bad", reason: "invalid_member_id" }],
    })
    const out = await skill("im.invite_members").execute(
      { chatId: "oc_1", memberIds: ["ou_a", "ou_bad"] },
      { sessionId: "s" }
    )
    expect(mAdd).toHaveBeenCalledWith({ chatId: "oc_1", memberIds: ["ou_a", "ou_bad"] })
    expect(out).toEqual({
      succeeded: ["ou_a"],
      failed: [{ id: "ou_bad", reason: "invalid_member_id" }],
    })
  })

  it("defaults chatId to the bound IM conversation's remote chat id", async () => {
    await skill("im.invite_members").execute(
      { memberIds: ["ou_a"] },
      {
        sessionId: "s",
        imBinding: { adapterId: "a1", platform: "lark", conversationKey: "lark:a1:oc_bound" },
      }
    )
    expect(mAdd).toHaveBeenCalledWith({ chatId: "oc_bound", memberIds: ["ou_a"] })
  })

  it("throws an actionable error when no chatId is derivable (desktop, none passed)", async () => {
    await expect(
      skill("im.invite_members").execute({ memberIds: ["ou_a"] }, { sessionId: "s" })
    ).rejects.toThrow(/chatId is required/)
  })

  it("remove_members routes to removeChatMembers", async () => {
    await skill("im.remove_members").execute(
      { chatId: "oc_1", memberIds: ["ou_a"] },
      { sessionId: "s" }
    )
    expect(mRemove).toHaveBeenCalledWith({ chatId: "oc_1", memberIds: ["ou_a"] })
    expect(mAdd).not.toHaveBeenCalled()
  })
})
