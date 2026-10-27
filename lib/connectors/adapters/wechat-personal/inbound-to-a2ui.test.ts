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
  it("projects official CDN media and quotes in occurrence order", () => {
    const out = wechatPersonalInboundToA2UI(
      msg([
        {
          type: ILINK_ITEM.text,
          text_item: { text: "caption" },
          ref_msg: {
            title: "quoted",
            message_item: {
              type: ILINK_ITEM.image,
              image_item: { media: { full_url: "https://cdn/quoted" } },
            },
          },
        },
        { type: ILINK_ITEM.image, image_item: { media: { encrypt_query_param: "image-ref" } } },
        { type: ILINK_ITEM.voice, voice_item: { text: "voice transcript" } },
      ])
    )
    expect(out?.body).toEqual([
      { kind: "text", text: "[reply:quoted]" },
      { kind: "image", url: "wechat-personal-media:https://cdn/quoted" },
      { kind: "text", text: "caption" },
      {
        kind: "image",
        url: "wechat-personal-media:https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=image-ref",
      },
      { kind: "text", text: "voice transcript" },
    ])
  })

  it("skips malformed values without discarding valid neighboring nodes", () => {
    expect(wechatPersonalInboundToA2UI(msg({} as never))).toBeNull()
    expect(
      wechatPersonalInboundToA2UI(
        msg([
          null,
          { type: ILINK_ITEM.text, text_item: { text: { bad: true } } },
          { type: ILINK_ITEM.image, image_item: { url: {} } },
          { type: ILINK_ITEM.text, text_item: { text: "kept" } },
        ] as never)
      )?.body
    ).toEqual([{ kind: "text", text: "kept" }])
  })

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
      { kind: "image", url: "wechat-personal-media:https://x/i.png" },
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
    ).toEqual({ kind: "link", href: "wechat-personal-media:https://x/v", label: "Voice message" })
    // File with a url but no name → default label.
    expect(
      wechatPersonalInboundToA2UI(
        msg([{ type: ILINK_ITEM.file, file_item: { url: "https://x/f" } }])
      )!.body[0]
    ).toEqual({ kind: "link", href: "wechat-personal-media:https://x/f", label: "Attachment" })
  })

  it("maps voice (with transcript), video, and file to link nodes", () => {
    expect(
      wechatPersonalInboundToA2UI(
        msg([{ type: ILINK_ITEM.voice, voice_item: { url: "https://x/v", transcript: "said" } }])
      )!.body[0]
    ).toEqual({ kind: "link", href: "wechat-personal-media:https://x/v", label: "said" })
    expect(
      wechatPersonalInboundToA2UI(
        msg([{ type: ILINK_ITEM.video, video_item: { url: "https://x/m" } }])
      )!.body[0]
    ).toEqual({ kind: "link", href: "wechat-personal-media:https://x/m", label: "Video" })
    expect(
      wechatPersonalInboundToA2UI(
        msg([{ type: ILINK_ITEM.file, file_item: { url: "https://x/f", file_name: "a.pdf" } }])
      )!.body[0]
    ).toEqual({ kind: "link", href: "wechat-personal-media:https://x/f", label: "a.pdf" })
  })
})
