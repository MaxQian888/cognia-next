jest.mock("./_helpers", () => ({
  ...jest.requireActual("./_helpers"),
  resolveChatCapableAdapter: jest.fn(),
  withScopeCapture: jest.fn((_id: string, fn: () => Promise<unknown>) => fn()),
}))

jest.mock("@/lib/connectors/conversation-bootstrap", () => ({
  bootstrapConversation: jest.fn(),
}))

jest.mock("@/lib/db/outbound-jobs", () => ({
  enqueueOutbound: jest.fn().mockResolvedValue({ id: "job1" }),
}))

jest.mock("@cognia/redact", () => ({
  hasNoLeakingPiiDeep: jest.fn(() => true),
}))

jest.mock("@/lib/connectors/audit", () => ({
  appendAudit: jest.fn().mockResolvedValue(undefined),
}))

import { getSharedBuiltInSkillRegistry } from "../registry"
import "./create-chat"
import { resolveChatCapableAdapter } from "./_helpers"
import { bootstrapConversation } from "@/lib/connectors/conversation-bootstrap"
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { appendAudit } from "@/lib/connectors/audit"

const mResolve = resolveChatCapableAdapter as jest.Mock
const mBootstrap = bootstrapConversation as jest.Mock
const mEnqueue = enqueueOutbound as jest.Mock
const mPii = hasNoLeakingPiiDeep as jest.Mock
const mAudit = appendAudit as jest.Mock

const mCreateChat = jest.fn()

function skill() {
  const s = getSharedBuiltInSkillRegistry()
    .list()
    .find((x) => x.id === "im.create_chat")
  if (!s) throw new Error("im.create_chat not registered")
  return s
}

beforeEach(() => {
  jest.clearAllMocks()
  mPii.mockReturnValue(true)
  mResolve.mockResolvedValue({
    adapterId: "a1",
    platform: "lark",
    adapter: { createChat: mCreateChat },
  })
  mCreateChat.mockResolvedValue({ chatId: "oc_new" })
  mBootstrap.mockResolvedValue({
    conversationKey: "lark:a1:oc_new",
    sessionId: "s_new",
    created: true,
  })
})

describe("im.create_chat execute", () => {
  it("creates the chat, bootstraps the conversation, and sends the first message", async () => {
    const out = await skill().execute(
      { name: "Project X", memberIds: ["ou_a"], firstMessage: "hello team" },
      { sessionId: "s" }
    )
    expect(mCreateChat).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Project X", memberIds: ["ou_a"] })
    )
    // Platform-side idempotency uuid always minted.
    expect(mCreateChat.mock.calls[0][0].idempotencyKey).toEqual(expect.any(String))
    expect(mBootstrap).toHaveBeenCalledWith({
      platform: "lark",
      adapterId: "a1",
      remoteChatId: "oc_new",
      name: "Project X",
      source: "im.create_chat",
    })
    expect(mEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "a1",
        conversationKey: "lark:a1:oc_new",
        source: "skill",
      })
    )
    expect(out).toEqual({
      chatId: "oc_new",
      conversationKey: "lark:a1:oc_new",
      sessionId: "s_new",
      firstMessage: "sent",
    })
  })

  it("reports rejected member ids as a partial outcome", async () => {
    mCreateChat.mockResolvedValue({ chatId: "oc_new", invalidMemberIds: ["ou_bad"] })
    const out = (await skill().execute(
      { name: "G", memberIds: ["ou_a", "ou_bad"] },
      { sessionId: "s" }
    )) as { invalidMemberIds?: string[] }
    expect(out.invalidMemberIds).toEqual(["ou_bad"])
  })

  it("blocks a PII-leaking first message but keeps the created chat (partial result + audit)", async () => {
    mPii.mockReturnValue(false)
    const out = (await skill().execute(
      { name: "G", memberIds: [], firstMessage: "mail alice@corp.com" },
      { sessionId: "s" }
    )) as { firstMessage?: string }
    expect(out.firstMessage).toBe("pii_blocked")
    expect(mEnqueue).not.toHaveBeenCalled()
    expect(mAudit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "adapter.error", reason: "pii_blocked" })
    )
  })

  it("skips the first-message pipeline entirely when none was requested", async () => {
    const out = (await skill().execute({ name: "G", memberIds: [] }, { sessionId: "s" })) as {
      firstMessage?: string
    }
    expect(out.firstMessage).toBeUndefined()
    expect(mEnqueue).not.toHaveBeenCalled()
  })

  it("threads the explicit adapterId into adapter resolution", async () => {
    await skill().execute({ name: "G", memberIds: [], adapterId: "a-other" }, { sessionId: "s" })
    expect(mResolve).toHaveBeenCalledWith(expect.anything(), ["chat.create"], "a-other")
  })
})
