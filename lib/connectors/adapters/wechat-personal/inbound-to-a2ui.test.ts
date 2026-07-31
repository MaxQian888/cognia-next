import { wechatPersonalInboundToA2UI } from "./inbound-to-a2ui"
import { ILINK_ITEM, type IlinkMessage } from "./protocol"

function msg(item_list: IlinkMessage["item_list"]): IlinkMessage {
  return {
    message_type: 1,
    from_user_id: "u@im.wechat",
    context_token: "ctx",
    item_list,
  } as IlinkMessage
}

describe("wechatPersonalInboundToA2UI", () => {
  it("returns null for non-object and empty item_list", () => {
    expect(wechatPersonalInboundToA2UI(undefined as unknown as IlinkMessage)).toBeNull()
    expect(wechatPersonalInboundToA2UI(msg([]))).toBeNull()
    expect(
      wechatPersonalInboundToA2UI(msg([{ type: ILINK_ITEM.text, text_item: { text: "" } }]))
    ).toBeNull()
  })

  it("maps text and image items", () => {
    const out = wechatPersonalInboundToA2UI(
      msg([
        { type: ILINK_ITEM.text, text_item: { text: "hi" } },
        { type: ILINK_ITEM.image, image_item: { url: "https://x/i.png" } },
      ])
    )
    expect(out!.body).toEqual([
      { kind: "text", text: "hi" },
      { kind: "image", url: "https://x/i.png" },
    ])
    expect(out!.source).toBe("wechat-personal")
  })

  it("skips items missing their media url and defaults the voice label", () => {
    // All items lack a usable payload → whole block is null.
    expect(
      wechatPersonalInboundToA2UI(
        msg([
          { type: ILINK_ITEM.image, image_item: {} },
          { type: ILINK_ITEM.voice, voice_item: {} },
          { type: ILINK_ITEM.video, video_item: {} },
          { type: ILINK_ITEM.file, file_item: {} },
          { type: 99 },
        ])
      )
    ).toBeNull()
    // Voice with a url but no transcript → default label.
    expect(
      wechatPersonalInboundToA2UI(
        msg([{ type: ILINK_ITEM.voice, voice_item: { url: "https://x/v" } }])
      )!.body[0]
    ).toEqual({ kind: "link", href: "https://x/v", label: "Voice message" })
    // File with a url but no name → default label.
    expect(
      wechatPersonalInboundToA2UI(
        msg([{ type: ILINK_ITEM.file, file_item: { url: "https://x/f" } }])
      )!.body[0]
    ).toEqual({ kind: "link", href: "https://x/f", label: "Attachment" })
  })

  it("maps voice (with transcript), video, and file to link nodes", () => {
    expect(
      wechatPersonalInboundToA2UI(
        msg([{ type: ILINK_ITEM.voice, voice_item: { url: "https://x/v", transcript: "said" } }])
      )!.body[0]
    ).toEqual({ kind: "link", href: "https://x/v", label: "said" })
    expect(
      wechatPersonalInboundToA2UI(
        msg([{ type: ILINK_ITEM.video, video_item: { url: "https://x/m" } }])
      )!.body[0]
    ).toEqual({ kind: "link", href: "https://x/m", label: "Video" })
    expect(
      wechatPersonalInboundToA2UI(
        msg([{ type: ILINK_ITEM.file, file_item: { url: "https://x/f", file_name: "a.pdf" } }])
      )!.body[0]
    ).toEqual({ kind: "link", href: "https://x/f", label: "a.pdf" })
  })
})
