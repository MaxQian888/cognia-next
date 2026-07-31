jest.mock("./http", () => ({
  ...jest.requireActual("./http"),
  larkTenantRequest: jest.fn(),
  larkUserRequest: jest.fn(),
}))

import { larkTenantRequest, larkUserRequest } from "./http"
import { LarkApiError } from "./auth-retry"
import { createLarkChatManagement } from "./chat-management"
import { ChatManagementScopeError } from "@/types/connectors/chat-management"

const mTenant = larkTenantRequest as jest.Mock
const mUser = larkUserRequest as jest.Mock

const CREDS = { appId: "cli_x", appSecret: "sec" }
const mgmt = createLarkChatManagement("adapter-1", async () => CREDS)

beforeEach(() => {
  jest.clearAllMocks()
})

describe("createChat", () => {
  it("POSTs /im/v1/chats with bot-manager + open_id + uuid idempotency and parses the result", async () => {
    mTenant.mockResolvedValue({
      code: 0,
      data: { chat_id: "oc_new", invalid_user_id_list: ["ou_bad"] },
    })
    const out = await mgmt.createChat({
      name: "Project X",
      memberIds: ["ou_a", "ou_bad"],
      description: "d",
      idempotencyKey: "idem-1",
    })
    expect(out).toEqual({ chatId: "oc_new", invalidMemberIds: ["ou_bad"] })
    const [creds, method, path, body] = mTenant.mock.calls[0]
    expect(creds).toEqual(CREDS)
    expect(method).toBe("POST")
    expect(path).toContain("/im/v1/chats?")
    expect(path).toContain("set_bot_manager=true")
    expect(path).toContain("user_id_type=open_id")
    expect(path).toContain("uuid=idem-1")
    expect(body).toEqual({ name: "Project X", description: "d", user_id_list: ["ou_a", "ou_bad"] })
  })

  it("omits the uuid param when no idempotency key is provided", async () => {
    mTenant.mockResolvedValue({ code: 0, data: { chat_id: "oc_2" } })
    const out = await mgmt.createChat({ name: "G", memberIds: [] })
    expect(out).toEqual({ chatId: "oc_2" })
    expect(mTenant.mock.calls[0][2]).not.toContain("uuid=")
  })

  it("throws loudly when the response carries no chat_id", async () => {
    mTenant.mockResolvedValue({ code: 0, data: {} })
    await expect(mgmt.createChat({ name: "G", memberIds: [] })).rejects.toThrow(/no chat_id/)
  })

  it("maps permission failures to ChatManagementScopeError naming im:chat:create", async () => {
    mTenant.mockRejectedValue(new LarkApiError({ status: 200, code: 99991672, message: "denied" }))
    const err = await mgmt.createChat({ name: "G", memberIds: [] }).catch((e) => e)
    expect(err).toBeInstanceOf(ChatManagementScopeError)
    expect((err as ChatManagementScopeError).requiredScope).toBe("im:chat:create")
  })
})

describe("chat members", () => {
  it("addChatMembers requests partial-success semantics and splits succeeded/failed", async () => {
    mTenant.mockResolvedValue({ code: 0, data: { invalid_id_list: ["ou_bad"] } })
    const out = await mgmt.addChatMembers({ chatId: "oc_1", memberIds: ["ou_a", "ou_bad"] })
    expect(out).toEqual({
      succeeded: ["ou_a"],
      failed: [{ id: "ou_bad", reason: "invalid_member_id" }],
    })
    const [, method, path] = mTenant.mock.calls[0]
    expect(method).toBe("POST")
    expect(path).toBe("/im/v1/chats/oc_1/members?member_id_type=open_id&succeed_type=1")
  })

  it("removeChatMembers issues DELETE on the members path", async () => {
    mTenant.mockResolvedValue({ code: 0, data: {} })
    const out = await mgmt.removeChatMembers({ chatId: "oc_1", memberIds: ["ou_a"] })
    expect(out).toEqual({ succeeded: ["ou_a"], failed: [] })
    const [, method, path] = mTenant.mock.calls[0]
    expect(method).toBe("DELETE")
    expect(path).toBe("/im/v1/chats/oc_1/members?member_id_type=open_id")
  })

  it("maps member-write permission failures to im:chat.members:write_only", async () => {
    mTenant.mockRejectedValue(new LarkApiError({ status: 403, code: null, message: "forbidden" }))
    const err = await mgmt.addChatMembers({ chatId: "oc_1", memberIds: ["ou_a"] }).catch((e) => e)
    expect(err).toBeInstanceOf(ChatManagementScopeError)
    expect((err as ChatManagementScopeError).requiredScope).toBe("im:chat.members:write_only")
  })
})

describe("updateChat", () => {
  it("PUTs only the provided fields", async () => {
    mTenant.mockResolvedValue({ code: 0 })
    await mgmt.updateChat({ chatId: "oc_1", name: "New name" })
    const [, method, path, body] = mTenant.mock.calls[0]
    expect(method).toBe("PUT")
    expect(path).toContain("/im/v1/chats/oc_1")
    expect(body).toEqual({ name: "New name" })
  })
})

describe("resolveContacts", () => {
  it("resolves emails/phones via batch_get_id into exact candidates, skipping not-found rows", async () => {
    mTenant.mockResolvedValue({
      code: 0,
      data: {
        user_list: [
          { user_id: "ou_a", email: "a@x.com" },
          { email: "ghost@x.com" }, // not found — no user_id
          { user_id: "ou_b", mobile: "+8613800000000" },
        ],
      },
    })
    const out = await mgmt.resolveContacts({
      emails: ["a@x.com", "ghost@x.com"],
      phones: ["+8613800000000"],
    })
    expect(out).toEqual([
      { memberId: "ou_a", email: "a@x.com", confidence: "exact" },
      { memberId: "ou_b", phone: "+8613800000000", confidence: "exact" },
    ])
    const [, method, path, body] = mTenant.mock.calls[0]
    expect(method).toBe("POST")
    expect(path).toBe("/contact/v3/users/batch_get_id?user_id_type=open_id")
    expect(body).toEqual({ emails: ["a@x.com", "ghost@x.com"], mobiles: ["+8613800000000"] })
  })

  it("name search throws an actionable error when no user token is connected", async () => {
    mUser.mockResolvedValue(null)
    await expect(mgmt.resolveContacts({ query: "Alice" })).rejects.toThrow(
      /connect user OAuth|email\/phone/i
    )
  })

  it("name search maps users to fuzzy candidates via the user-token endpoint", async () => {
    mUser.mockResolvedValue({
      code: 0,
      data: { users: [{ open_id: "ou_z", name: "Zhang San" }, { name: "no-id" }] },
    })
    const out = await mgmt.resolveContacts({ query: "张三" })
    expect(out).toEqual([{ memberId: "ou_z", displayName: "Zhang San", confidence: "fuzzy" }])
    const [adapterId, , method, path] = mUser.mock.calls[0]
    expect(adapterId).toBe("adapter-1")
    expect(method).toBe("GET")
    expect(path).toContain("/search/v1/user?query=")
    expect(path).toContain(encodeURIComponent("张三"))
  })

  it("combines exact and fuzzy results in one call", async () => {
    mTenant.mockResolvedValue({ code: 0, data: { user_list: [{ user_id: "ou_a" }] } })
    mUser.mockResolvedValue({ code: 0, data: { users: [{ open_id: "ou_z", name: "Z" }] } })
    const out = await mgmt.resolveContacts({ emails: ["a@x.com"], query: "Z" })
    expect(out.map((c) => c.memberId)).toEqual(["ou_a", "ou_z"])
  })
})
