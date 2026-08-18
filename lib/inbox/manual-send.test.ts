import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("@/lib/connectors/inbox-writes", () => ({
  sendManualReply: jest.fn(),
}))

import { sendManualReply } from "@/lib/connectors/inbox-writes"
import { NotPlatformBoundError, sendManualTextToConversation } from "./manual-send"

const sendManualReplyMock = sendManualReply as jest.Mock

const bound = {
  id: "s1",
  title: "Alice",
  createdAt: 1,
  updatedAt: 2,
  platformBinding: {
    adapterId: "a1",
    conversationKey: "telegram:a1:1001",
    platform: "telegram",
    conversationRef: { platform: "telegram", adapterId: "a1", chatId: "1001" },
  },
} as unknown as ChatSession

beforeEach(() => {
  sendManualReplyMock.mockReset()
  sendManualReplyMock.mockResolvedValue({
    jobId: "job1",
    messageId: "msg1",
    reused: false,
    route: "local",
    idempotencyKey: "idem",
  })
})

describe("sendManualTextToConversation", () => {
  it("relays the session's binding and trimmed text, leaving key minting to the relay", async () => {
    const out = await sendManualTextToConversation({ session: bound, text: "  hello there \n" })
    expect(out).toEqual({
      jobId: "job1",
      messageId: "msg1",
      route: "local",
      sessionId: "s1",
      conversationKey: "telegram:a1:1001",
    })
    expect(sendManualReplyMock).toHaveBeenCalledTimes(1)
    expect(sendManualReplyMock).toHaveBeenCalledWith({
      adapterId: "a1",
      conversationKey: "telegram:a1:1001",
      conversationRef: { platform: "telegram", adapterId: "a1", chatId: "1001" },
      sessionId: "s1",
      segments: [{ type: "text", text: "hello there" }],
    })
  })

  it("passes a remote outcome through without a job id", async () => {
    sendManualReplyMock.mockResolvedValueOnce({
      messageId: "msg2",
      reused: false,
      route: "remote",
      idempotencyKey: "idem2",
    })
    const out = await sendManualTextToConversation({ session: bound, text: "a" })
    expect(out).toEqual({
      jobId: undefined,
      messageId: "msg2",
      route: "remote",
      sessionId: "s1",
      conversationKey: "telegram:a1:1001",
    })
  })

  it("refuses a session without a platform binding, before touching the relay", async () => {
    const plain = { id: "p", title: "Plain" } as unknown as ChatSession
    await expect(sendManualTextToConversation({ session: plain, text: "x" })).rejects.toBeInstanceOf(
      NotPlatformBoundError
    )
    expect(sendManualReplyMock).not.toHaveBeenCalled()
  })

  it("refuses empty text", async () => {
    await expect(sendManualTextToConversation({ session: bound, text: "   " })).rejects.toThrow(
      "empty text"
    )
    expect(sendManualReplyMock).not.toHaveBeenCalled()
  })

  it("propagates relay failures", async () => {
    sendManualReplyMock.mockRejectedValueOnce(new Error("unavailable"))
    await expect(sendManualTextToConversation({ session: bound, text: "x" })).rejects.toThrow(
      "unavailable"
    )
  })
})
