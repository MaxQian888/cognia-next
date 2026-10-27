import { wechatOaInboundToA2UI } from "./inbound-to-a2ui"

const wrap = (inner: string) => `<xml>${inner}</xml>`

describe("wechatOaInboundToA2UI", () => {
  it("returns null for non-string, empty, missing-type, event, and unknown", () => {
    expect(wechatOaInboundToA2UI(undefined as unknown as string)).toBeNull()
    expect(wechatOaInboundToA2UI("")).toBeNull()
    expect(wechatOaInboundToA2UI(wrap("<FromUserName>u</FromUserName>"))).toBeNull()
    expect(wechatOaInboundToA2UI(wrap("<MsgType>event</MsgType>"))).toBeNull()
  })

  it("maps text", () => {
    expect(
      wechatOaInboundToA2UI(
        wrap("<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hello]]></Content>")
      )!.body
    ).toEqual([{ kind: "text", text: "hello" }])
  })

  it("keeps XML-looking user text literal and reads the envelope type outside CDATA", () => {
    const content = "<MsgType>image</MsgType> literal </Content> text"
    const block = wechatOaInboundToA2UI(
      wrap(`<Content><![CDATA[${content}]]></Content><MsgType>text</MsgType>`)
    )
    expect(block!.body).toEqual([{ kind: "text", text: content }])
  })

  it("decodes escaped shared-link attributes without changing CDATA prose", () => {
    const block = wechatOaInboundToA2UI(
      wrap(
        "<MsgType>link</MsgType><Title><![CDATA[A &amp; B]]></Title><Url>https://example.com/?a=1&amp;b=2</Url>"
      )
    )
    expect(block!.body[0]).toMatchObject({
      title: "A &amp; B",
      children: [{ kind: "link", href: "https://example.com/?a=1&b=2", label: "A &amp; B" }],
    })
  })

  it("maps image to an image node using PicUrl", () => {
    expect(
      wechatOaInboundToA2UI(wrap("<MsgType>image</MsgType><PicUrl>https://x/p.jpg</PicUrl>"))!
        .body[0]
    ).toEqual({ kind: "image", url: "https://x/p.jpg" })
  })

  it("maps voice with and without recognition", () => {
    expect(
      wechatOaInboundToA2UI(wrap("<MsgType>voice</MsgType><Recognition>spoken</Recognition>"))!
        .body[0]
    ).toEqual({ kind: "text", text: "spoken", emphasis: undefined })
    expect(wechatOaInboundToA2UI(wrap("<MsgType>voice</MsgType>"))!.body[0]).toEqual({
      kind: "text",
      text: "[voice]",
      emphasis: "muted",
    })
  })

  it("maps video and shortvideo to a marker", () => {
    expect(wechatOaInboundToA2UI(wrap("<MsgType>video</MsgType>"))!.body[0]).toEqual({
      kind: "text",
      text: "[video]",
      emphasis: "muted",
    })
    expect(wechatOaInboundToA2UI(wrap("<MsgType>shortvideo</MsgType>"))!.body[0].kind).toBe("text")
  })

  it("maps a shared link to a card", () => {
    const out = wechatOaInboundToA2UI(
      wrap(
        "<MsgType>link</MsgType><Title>T</Title><Description>D</Description><Url>https://x/a</Url>"
      )
    )
    expect(out!.body[0]).toEqual({
      kind: "card",
      title: "T",
      subtitle: "D",
      children: [{ kind: "link", href: "https://x/a", label: "T" }],
    })
    expect(out!.source).toBe("wechat-oa")
  })

  it("maps location to a pinned text node", () => {
    expect(
      wechatOaInboundToA2UI(wrap("<MsgType>location</MsgType><Label>Office</Label>"))!.body[0]
    ).toEqual({ kind: "text", text: "📍 Office" })
  })

  it("returns null when link has no Url and location has no Label", () => {
    expect(wechatOaInboundToA2UI(wrap("<MsgType>link</MsgType><Title>T</Title>"))).toBeNull()
    expect(wechatOaInboundToA2UI(wrap("<MsgType>location</MsgType>"))).toBeNull()
  })

  it("uses the Url as the link label when Title/Description are absent", () => {
    const out = wechatOaInboundToA2UI(wrap("<MsgType>link</MsgType><Url>https://x/a</Url>"))
    expect(out!.body[0]).toEqual({
      kind: "card",
      title: undefined,
      subtitle: undefined,
      children: [{ kind: "link", href: "https://x/a", label: "https://x/a" }],
    })
  })
})
