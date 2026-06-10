import { dingtalkInboundToA2UI } from "./inbound-to-a2ui"
import type { DingTalkBotMessage } from "./parse"

function msg(partial: Partial<DingTalkBotMessage>): DingTalkBotMessage {
  return {
    conversationId: "c1",
    conversationType: "1",
    msgId: "m1",
    msgtype: "text",
    ...partial,
  } as DingTalkBotMessage
}

describe("dingtalkInboundToA2UI", () => {
  it("returns null for non-object and empty text", () => {
    expect(dingtalkInboundToA2UI(undefined as unknown as DingTalkBotMessage)).toBeNull()
    expect(dingtalkInboundToA2UI(msg({ msgtype: "text", text: { content: "  " } }))).toBeNull()
  })

  it("maps plain text (trimmed)", () => {
    expect(
      dingtalkInboundToA2UI(msg({ msgtype: "text", text: { content: " hi " } }))!.body
    ).toEqual([{ kind: "text", text: "hi" }])
  })

  it("maps richText runs to text nodes and marks pictures", () => {
    const out = dingtalkInboundToA2UI(
      msg({
        msgtype: "richText",
        richText: [
          { text: "before" },
          { type: "picture", pictureDownloadCode: "code" },
          { text: "after" },
        ],
      })
    )
    expect(out!.body).toEqual([
      { kind: "text", text: "before" },
      { kind: "text", text: "[picture]", emphasis: "muted" },
      { kind: "text", text: "after" },
    ])
    expect(out!.source).toBe("dingtalk")
  })

  it("surfaces audio recognition transcript when present", () => {
    expect(
      dingtalkInboundToA2UI(msg({ msgtype: "audio", content: { recognition: "spoken words" } }))!
        .body
    ).toEqual([{ kind: "text", text: "spoken words", emphasis: undefined }])
    expect(dingtalkInboundToA2UI(msg({ msgtype: "audio", content: {} }))!.body).toEqual([
      { kind: "text", text: "[audio]", emphasis: "muted" },
    ])
  })

  it("returns null for a text msgtype with no text field", () => {
    expect(dingtalkInboundToA2UI(msg({ msgtype: "text" }))).toBeNull()
  })

  it("skips richText runs that are neither text nor picture", () => {
    const out = dingtalkInboundToA2UI(
      msg({ msgtype: "richText", richText: [{}, { text: "" }, { text: "kept" }] })
    )
    expect(out!.body).toEqual([{ kind: "text", text: "kept" }])
  })

  it("renders picture / video / file markers", () => {
    expect(dingtalkInboundToA2UI(msg({ msgtype: "picture" }))!.body[0]).toEqual({
      kind: "text",
      text: "[picture]",
      emphasis: "muted",
    })
    expect(dingtalkInboundToA2UI(msg({ msgtype: "video" }))!.body[0]).toEqual({
      kind: "text",
      text: "[video]",
      emphasis: "muted",
    })
    expect(
      dingtalkInboundToA2UI(msg({ msgtype: "file", content: { fileName: "x.zip" } }))!.body[0]
    ).toEqual({ kind: "text", text: "[file: x.zip]", emphasis: "muted" })
    expect(dingtalkInboundToA2UI(msg({ msgtype: "file", content: {} }))!.body[0]).toEqual({
      kind: "text",
      text: "[file]",
      emphasis: "muted",
    })
  })
})
