import type { ChatSession } from "@cognia/agent-config-types"

const mockMessageGet = jest.fn()
const mockJobGet = jest.fn()
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ messages: { get: mockMessageGet }, outboundQueue: { get: mockJobGet } }),
}))

jest.mock("@/lib/connectors/inbox-writes", () => ({
  sendManualReply: jest.fn(),
}))

import { sendManualReply } from "@/lib/connectors/inbox-writes"
import {
  NotPlatformBoundError,
  sendManualTextToConversation,
  sendManualMessageToConversation,
} from "./manual-send"

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
    await expect(
      sendManualTextToConversation({ session: plain, text: "x" })
    ).rejects.toBeInstanceOf(NotPlatformBoundError)
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

describe("sendManualMessageToConversation", () => {
  it("sends original attachment bytes, platform reply identity and thread through the shared relay", async () => {
    await sendManualMessageToConversation({
      session: {
        ...bound,
        platformBinding: {
          ...bound.platformBinding!,
          conversationRef: { ...bound.platformBinding!.conversationRef, threadId: "topic-9" },
        },
      },
      text: " hello ",
      files: [
        { url: "data:text/plain;base64,aGk=", mediaType: "text/plain", filename: "note.txt" },
      ],
      replyTo: { messageId: "local-1", platformMessageId: "remote-1", preview: "earlier" },
    })
    expect(sendManualReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        segments: [
          { type: "text", text: "hello" },
          {
            type: "file",
            url: "data:text/plain;base64,aGk=",
            name: "note.txt",
            mimeType: "text/plain",
            sizeBytes: 2,
          },
        ],
        replyTo: { messageId: "remote-1" },
        threadId: "topic-9",
      })
    )
  })

  it("accepts image-only sends", async () => {
    await sendManualMessageToConversation({
      session: bound,
      text: "",
      files: [{ url: "data:image/png;base64,aGk=", filename: "photo.png", mediaType: "image/png" }],
    })
    expect(sendManualReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        segments: [
          {
            type: "image",
            url: "data:image/png;base64,aGk=",
            alt: "photo.png",
            mimeType: "image/png",
          },
        ],
      })
    )
  })

  it("rejects a lost attachment before sending any text", async () => {
    await expect(
      sendManualMessageToConversation({
        session: bound,
        text: "hello",
        files: [{ url: "blob:revoked", filename: "lost.txt" }],
      })
    ).rejects.toThrow("attachment")
    expect(sendManualReplyMock).not.toHaveBeenCalled()
  })
})

it("resolves a reply to a delivered outbound message using the job's platform id", async () => {
  mockMessageGet.mockResolvedValueOnce({
    sessionId: "s1",
    metadata: { outboundJobId: "job-parent" },
  })
  mockJobGet.mockResolvedValueOnce({ platformMessageId: "remote-parent" })
  await sendManualMessageToConversation({
    session: bound,
    text: "reply",
    files: [],
    replyTo: { messageId: "local-parent", preview: "quoted" },
  })
  expect(sendManualReplyMock).toHaveBeenCalledWith(
    expect.objectContaining({
      replyTo: { messageId: "remote-parent" },
      messageMetadata: { replyTo: { messageId: "local-parent", preview: "quoted" } },
    })
  )
})

it("refuses a reply to an unrelated session instead of sending its local id to the platform", async () => {
  mockMessageGet.mockResolvedValueOnce({ sessionId: "other", platformMessageId: "outside" })
  await expect(
    sendManualMessageToConversation({
      session: bound,
      text: "reply",
      files: [],
      replyTo: { messageId: "local", preview: "quoted" },
    })
  ).rejects.toThrow("reply target unavailable")
  expect(sendManualReplyMock).not.toHaveBeenCalled()
})

it("resolves an inbound message's platform id and retains template provenance internally", async () => {
  mockMessageGet.mockResolvedValueOnce({ sessionId: "s1", platformMessageId: "inbound" })
  const templateRun = {
    templateId: "t",
    version: "1",
    text: "hi {{who}}",
    params: { who: { kind: "text" as const, value: "Jane" } },
  }
  await sendManualMessageToConversation({
    session: bound,
    text: "hi Jane",
    files: [],
    replyTo: { messageId: "local", preview: "quoted" },
    templateRun,
  })
  expect(sendManualReplyMock).toHaveBeenCalledWith(
    expect.objectContaining({
      replyTo: { messageId: "inbound" },
      messageMetadata: expect.objectContaining({ templateRun }),
    })
  )
})

it("requires a platform binding and nonempty content for rich sends", async () => {
  await expect(
    sendManualMessageToConversation({
      session: { ...bound, platformBinding: undefined },
      text: "hi",
      files: [],
    })
  ).rejects.toThrow(NotPlatformBoundError)
  await expect(
    sendManualMessageToConversation({ session: bound, text: " ", files: [] })
  ).rejects.toThrow("empty text")
})

it("derives MIME and fallback names from original data URLs", async () => {
  await sendManualMessageToConversation({
    session: { ...bound, title: undefined } as never,
    text: "",
    files: [{ url: "data:;base64,aGk=" }],
  })
  expect(sendManualReplyMock).toHaveBeenCalledWith(
    expect.objectContaining({
      label: bound.platformBinding!.conversationKey,
      segments: [
        {
          type: "file",
          url: "data:;base64,aGk=",
          name: "attachment",
          mimeType: "application/octet-stream",
          sizeBytes: 2,
        },
      ],
    })
  )
  await sendManualMessageToConversation({
    session: bound,
    text: "",
    files: [{ url: "data:text/plain;base64,aGk=", filename: "note.txt" }],
  })
  expect(sendManualReplyMock).toHaveBeenLastCalledWith(
    expect.objectContaining({ segments: [expect.objectContaining({ mimeType: "text/plain" })] })
  )
})

it("rejects attachments with no persisted bytes", async () => {
  await expect(
    sendManualMessageToConversation({ session: bound, text: "x", files: [{}] })
  ).rejects.toThrow("attachment")
})

it("resolves legacy inbound metadata and rejects missing or undelivered targets", async () => {
  mockMessageGet.mockResolvedValueOnce({
    sessionId: "s1",
    metadata: { platformMessage: { messageId: "legacy" } },
  })
  await sendManualMessageToConversation({
    session: bound,
    text: "reply",
    files: [],
    replyTo: { messageId: "local", preview: "quote" },
  })
  expect(sendManualReplyMock).toHaveBeenCalledWith(
    expect.objectContaining({ replyTo: { messageId: "legacy" } })
  )
  mockMessageGet.mockResolvedValueOnce(undefined)
  await expect(
    sendManualMessageToConversation({
      session: bound,
      text: "reply",
      files: [],
      replyTo: { messageId: "missing", preview: "quote" },
    })
  ).rejects.toThrow("reply target unavailable")
  mockMessageGet.mockResolvedValueOnce({
    sessionId: "s1",
    metadata: { outboundJobId: "not-delivered" },
  })
  mockJobGet.mockResolvedValueOnce(undefined)
  await expect(
    sendManualMessageToConversation({
      session: bound,
      text: "reply",
      files: [],
      replyTo: { messageId: "pending", preview: "quote" },
    })
  ).rejects.toThrow("reply target unavailable")
})

it.each(["dingtalk", "wechat-oa", "qq-official"])(
  "rejects unsupported %s inline uploads before queue acceptance",
  async (platform) => {
    await expect(
      sendManualMessageToConversation({
        session: { ...bound, platformBinding: { ...bound.platformBinding!, platform } },
        text: "attached",
        files: [{ url: "data:text/plain;base64,aGk=", filename: "note.txt" }],
      })
    ).rejects.toMatchObject({ name: "UnsupportedPlatformAttachmentsError", platform })
    expect(sendManualReplyMock).not.toHaveBeenCalled()
  }
)

it("refuses delivery evidence that is only an idempotency key, not a platform reply identity", async () => {
  mockMessageGet.mockResolvedValueOnce({
    sessionId: "s1",
    metadata: { outboundJobId: "file-upload" },
  })
  mockJobGet.mockResolvedValueOnce({
    platformMessageId: "delivery-key",
    idempotencyKey: "delivery-key",
  })
  await expect(
    sendManualMessageToConversation({
      session: bound,
      text: "reply",
      files: [],
      replyTo: { messageId: "file-message", preview: "file" },
    })
  ).rejects.toThrow("platform reply target unavailable")
  expect(sendManualReplyMock).not.toHaveBeenCalled()
})
