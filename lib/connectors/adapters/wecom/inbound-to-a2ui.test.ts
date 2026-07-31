import { wecomInboundToA2UI } from "./inbound-to-a2ui"
import type { WeComInboundMsgBody } from "./protocol"

function body(partial: Partial<WeComInboundMsgBody>): WeComInboundMsgBody {
  return {
    msgid: "m1",
    aibotid: "bot",
    chatid: "c1",
    chattype: "single",
    msgtype: "text",
    ...partial,
  } as WeComInboundMsgBody
}

describe("wecomInboundToA2UI", () => {
  it("returns null for non-object and empty content", () => {
    expect(wecomInboundToA2UI(undefined as unknown as WeComInboundMsgBody)).toBeNull()
    expect(wecomInboundToA2UI(body({ msgtype: "text", text: { content: "" } }))).toBeNull()
  })

  it("maps text and markdown to text nodes", () => {
    expect(wecomInboundToA2UI(body({ msgtype: "text", text: { content: "hi" } }))!.body).toEqual([
      { kind: "text", text: "hi" },
    ])
    expect(
      wecomInboundToA2UI(body({ msgtype: "markdown", markdown: { content: "# H" } }))!.body
    ).toEqual([{ kind: "text", text: "# H" }])
  })

  it("maps image to an image node", () => {
    expect(
      wecomInboundToA2UI(body({ msgtype: "image", image: { url: "https://x/i.png" } }))!.body[0]
    ).toEqual({ kind: "image", url: "https://x/i.png" })
  })

  it("maps voice/video/file to link nodes", () => {
    expect(
      wecomInboundToA2UI(
        body({ msgtype: "voice", voice: { url: "https://x/v", transcript: "hello there" } })
      )!.body[0]
    ).toEqual({ kind: "link", href: "https://x/v", label: "hello there" })
    expect(
      wecomInboundToA2UI(body({ msgtype: "video", video: { url: "https://x/m" } }))!.body[0]
    ).toEqual({ kind: "link", href: "https://x/m", label: "Video" })
    expect(
      wecomInboundToA2UI(
        body({ msgtype: "file", file: { url: "https://x/f", filename: "a.pdf" } })
      )!.body[0]
    ).toEqual({ kind: "link", href: "https://x/f", label: "a.pdf" })
  })

  it("returns null when the typed body field is absent", () => {
    expect(wecomInboundToA2UI(body({ msgtype: "text" }))).toBeNull()
    expect(wecomInboundToA2UI(body({ msgtype: "image" }))).toBeNull()
  })

  it("uses default labels for voice/file without transcript/filename", () => {
    expect(
      wecomInboundToA2UI(body({ msgtype: "voice", voice: { url: "https://x/v" } }))!.body[0]
    ).toEqual({ kind: "link", href: "https://x/v", label: "Voice message" })
    expect(
      wecomInboundToA2UI(body({ msgtype: "file", file: { url: "https://x/f" } }))!.body[0]
    ).toEqual({
      kind: "link",
      href: "https://x/f",
      label: "Attachment",
    })
  })

  it("interleaves mixed text + image items", () => {
    const out = wecomInboundToA2UI(
      body({
        msgtype: "mixed",
        mixed: {
          msg_item: [{ text: { content: "see" } }, { image: { url: "https://x/p.png" } }],
        },
      })
    )
    expect(out!.body).toEqual([
      { kind: "text", text: "see" },
      { kind: "image", url: "https://x/p.png" },
    ])
    expect(out!.source).toBe("wecom")
  })
})
