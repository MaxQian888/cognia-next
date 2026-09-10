import { invoke } from "@tauri-apps/api/core"
import { prepareWechatMessages } from "./media"
import type { OutboundRequest } from "@/types/connectors/outbound"

const mockInvoke = invoke as jest.Mock
const token = jest.fn(async () => "token")
const req = (segments: OutboundRequest["segments"]): OutboundRequest => ({
  conversationRef: { platform: "wechat-oa", adapterId: "oa", openId: "user" },
  segments,
  metadata: { idempotencyKey: "test" },
})
const uploadResponse = (body: unknown, status = 200) =>
  JSON.stringify({
    status,
    headers: {},
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
beforeEach(() => {
  mockInvoke.mockReset()
  token.mockClear()
})

it("preserves ordered text/image/voice/video and reuses existing media IDs", async () => {
  const messages = await prepareWechatMessages(
    req([
      { type: "text", text: "before" },
      { type: "image", url: "wxmedia://image" },
      { type: "voice", url: "wxmedia://voice" },
      { type: "video", url: "wxmedia://video", thumbnailUrl: "wxmedia://thumb" },
      { type: "text", text: "after" },
    ]),
    token,
    "https://api.weixin.qq.com"
  )
  expect(messages.map((m) => m.msgtype)).toEqual(["text", "image", "voice", "video", "text"])
  expect(messages[3]).toEqual({
    touser: "user",
    msgtype: "video",
    video: { media_id: "video", thumb_media_id: "thumb" },
  })
  expect(mockInvoke).not.toHaveBeenCalled()
})

it("uploads remote video and thumbnail separately", async () => {
  mockInvoke
    .mockResolvedValueOnce(uploadResponse({ media_id: "video" }))
    .mockResolvedValueOnce(uploadResponse({ media_id: "thumb" }))
  await prepareWechatMessages(
    req([
      {
        type: "video",
        url: "https://cdn.example/v.mp4",
        thumbnailUrl: "https://cdn.example/t.jpg",
      },
    ]),
    token,
    "https://api.weixin.qq.com"
  )
  expect(mockInvoke.mock.calls[0][1].req.uploadUrl).toContain("type=video")
  expect(mockInvoke.mock.calls[1][1].req).toMatchObject({
    sourceUrl: "https://cdn.example/t.jpg",
    contentType: "image/jpeg",
  })
  expect(mockInvoke.mock.calls[1][1].req.uploadUrl).toContain("type=thumb")
})

it("refreshes upload authentication once", async () => {
  mockInvoke
    .mockResolvedValueOnce(uploadResponse({ errcode: 40001 }))
    .mockResolvedValueOnce(uploadResponse({ media_id: "fresh" }))
  const messages = await prepareWechatMessages(
    req([{ type: "voice", url: "https://cdn.example/v.mp3" }]),
    token,
    "https://api.weixin.qq.com"
  )
  expect(token).toHaveBeenCalledTimes(2)
  expect(messages[0]).toMatchObject({ voice: { media_id: "fresh" } })
})

it.each(["data:image/png;base64,eA==", "invalid", "wxmedia://", "file://remote/share/f"])(
  "rejects unsupported source %s",
  async (source) => {
    await expect(
      prepareWechatMessages(
        req([{ type: "image", url: source }]),
        token,
        "https://api.weixin.qq.com"
      )
    ).rejects.toThrow()
    expect(mockInvoke).not.toHaveBeenCalled()
  }
)

it("validates video thumbnail before any media is uploaded", async () => {
  await expect(
    prepareWechatMessages(
      req([
        { type: "image", url: "https://cdn.example/i" },
        { type: "video", url: "https://cdn.example/v" },
      ]),
      token,
      "https://api.weixin.qq.com"
    )
  ).rejects.toThrow("thumbnailUrl")
  expect(mockInvoke).not.toHaveBeenCalled()
})

it.each([
  [uploadResponse({ errcode: 40007 }), false],
  [uploadResponse({ errcode: -1 }), true],
  [uploadResponse("bad gateway", 502), true],
  [uploadResponse({}), false],
])("classifies upload failure without sending messages", async (response, retryable) => {
  mockInvoke.mockResolvedValue(response)
  await expect(
    prepareWechatMessages(
      req([{ type: "image", url: "https://cdn.example/i" }]),
      token,
      "https://api.weixin.qq.com"
    )
  ).rejects.toMatchObject({ retryable })
})

it("rejects empty messages and missing recipient", async () => {
  await expect(prepareWechatMessages(req([]), token, "https://api.weixin.qq.com")).rejects.toThrow(
    "empty"
  )
  await expect(
    prepareWechatMessages({ ...req([]), conversationRef: {} }, token, "https://api.weixin.qq.com")
  ).rejects.toThrow("openId")
})

it("reports terminal upload authentication separately and retains rate-limit retryability", async () => {
  mockInvoke.mockResolvedValue(uploadResponse({ errcode: 42001 }))
  await expect(
    prepareWechatMessages(
      req([{ type: "voice", url: "https://cdn.example/" }]),
      token,
      "https://api.weixin.qq.com"
    )
  ).rejects.toMatchObject({ code: "auth_failed", retryable: false })
  expect(token).toHaveBeenCalledTimes(2)
  mockInvoke.mockResolvedValue(uploadResponse({ errcode: 45009 }, 429))
  await expect(
    prepareWechatMessages(
      req([{ type: "image", url: "file:///C:/photo.jpg" }]),
      token,
      "https://api.weixin.qq.com"
    )
  ).rejects.toMatchObject({ retryable: true })
  expect(mockInvoke.mock.calls.at(-1)?.[1].req.localPath).toBe("C:/photo.jpg")
})
