import { extractXmlField, parseWechatOaXml } from "./parse"

const ADAPTER = "wxoa-1"

function textXml(content: string, from = "oUser123") {
  return `<xml><ToUserName><![CDATA[gh_bot]]></ToUserName><FromUserName><![CDATA[${from}]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content><MsgId>12345</MsgId></xml>`
}

describe("extractXmlField", () => {
  it("unwraps CDATA", () => {
    expect(extractXmlField("<A><![CDATA[hi]]></A>", "A")).toBe("hi")
  })
  it("reads a bare field", () => {
    expect(extractXmlField("<CreateTime>123</CreateTime>", "CreateTime")).toBe("123")
  })
  it("returns undefined for a missing field", () => {
    expect(extractXmlField("<A>x</A>", "B")).toBeUndefined()
  })
})

describe("parseWechatOaXml", () => {
  it("parses a text message", () => {
    const out = parseWechatOaXml(ADAPTER, "", textXml("hello bot"))
    expect(out).not.toBeNull()
    expect(out!.plainText).toBe("hello bot")
    expect(out!.conversationRef).toMatchObject({ openId: "oUser123" })
    expect(out!.conversationKey).toBe(`wechat-oa:${ADAPTER}:oUser123`)
    expect(out!.channel.kind).toBe("private")
    expect(out!.mentions.selfMentioned).toBe(true)
    expect(out!.messageId).toBe("12345")
  })

  it("parses an image message", () => {
    const xml = `<xml><FromUserName><![CDATA[oU]]></FromUserName><CreateTime>1</CreateTime><MsgType><![CDATA[image]]></MsgType><PicUrl><![CDATA[https://e/p.jpg]]></PicUrl><MediaId><![CDATA[MID]]></MediaId><MsgId>9</MsgId></xml>`
    const out = parseWechatOaXml(ADAPTER, "", xml)
    expect(out!.segments[0]).toMatchObject({ type: "image", url: "https://e/p.jpg" })
  })

  it("parses a voice message with recognition transcript", () => {
    const xml = `<xml><FromUserName><![CDATA[oU]]></FromUserName><CreateTime>1</CreateTime><MsgType><![CDATA[voice]]></MsgType><MediaId><![CDATA[VID]]></MediaId><Recognition><![CDATA[hello there]]></Recognition><MsgId>9</MsgId></xml>`
    const out = parseWechatOaXml(ADAPTER, "", xml)
    expect(out!.segments[0]).toMatchObject({ type: "voice", transcript: "hello there" })
  })

  it("carries the selfId through to the event", () => {
    const out = parseWechatOaXml(ADAPTER, "gh_bot", textXml("hi"))
    expect(out!.selfId).toBe("gh_bot")
  })

  it("parses a link message into a text segment with title, description, and url", () => {
    const xml = `<xml><FromUserName><![CDATA[oU]]></FromUserName><CreateTime>1</CreateTime><MsgType><![CDATA[link]]></MsgType><Title><![CDATA[T]]></Title><Description><![CDATA[D]]></Description><Url><![CDATA[https://x/a]]></Url><MsgId>9</MsgId></xml>`
    const out = parseWechatOaXml(ADAPTER, "", xml)
    expect(out!.segments).toEqual([{ type: "text", text: "T\nD\nhttps://x/a" }])
    expect(out!.plainText).toBe("T\nD\nhttps://x/a")
  })

  it("returns null for a link message with no fields at all", () => {
    const linkXml = `<xml><FromUserName><![CDATA[oU]]></FromUserName><MsgType><![CDATA[link]]></MsgType></xml>`
    expect(parseWechatOaXml(ADAPTER, "", linkXml)).toBeNull()
  })

  it("parses a location message into a location segment", () => {
    const xml = `<xml><FromUserName><![CDATA[oU]]></FromUserName><CreateTime>1</CreateTime><MsgType><![CDATA[location]]></MsgType><Location_X>23.13</Location_X><Location_Y>113.35</Location_Y><Scale>20</Scale><Label><![CDATA[Office]]></Label><MsgId>9</MsgId></xml>`
    const out = parseWechatOaXml(ADAPTER, "", xml)
    expect(out!.segments).toEqual([{ type: "location", lat: 23.13, lon: 113.35, name: "Office" }])
  })

  it("falls back to a text segment when a location has a label but no coordinates", () => {
    const xml = `<xml><FromUserName><![CDATA[oU]]></FromUserName><MsgType><![CDATA[location]]></MsgType><Label><![CDATA[Office]]></Label></xml>`
    const out = parseWechatOaXml(ADAPTER, "", xml)
    expect(out!.segments).toEqual([{ type: "text", text: "Location: Office" }])
  })

  it("returns null for a location with neither coordinates nor label", () => {
    const xml = `<xml><FromUserName><![CDATA[oU]]></FromUserName><MsgType><![CDATA[location]]></MsgType></xml>`
    expect(parseWechatOaXml(ADAPTER, "", xml)).toBeNull()
  })

  it("projects a subscribe event as a member_added system event", () => {
    const xml = `<xml><ToUserName><![CDATA[gh_bot]]></ToUserName><FromUserName><![CDATA[oU]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe]]></Event></xml>`
    const out = parseWechatOaXml(ADAPTER, "gh_bot", xml)
    expect(out).toMatchObject({
      kind: "system",
      systemKind: "member_added",
      selfId: "gh_bot",
      segments: [],
      plainText: "",
      channel: { kind: "private" },
    })
    expect(out!.mentions.selfMentioned).toBe(false)
    expect(out!.conversationKey).toBe(`wechat-oa:${ADAPTER}:oU`)
  })

  it("drops unsubscribe events", () => {
    const xml = `<xml><FromUserName><![CDATA[oU]]></FromUserName><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[unsubscribe]]></Event></xml>`
    expect(parseWechatOaXml(ADAPTER, "", xml)).toBeNull()
  })

  it("projects a menu CLICK event as a text message carrying the EventKey", () => {
    const xml = `<xml><FromUserName><![CDATA[oU]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[CLICK]]></Event><EventKey><![CDATA[MENU_HELP]]></EventKey></xml>`
    const out = parseWechatOaXml(ADAPTER, "", xml)
    expect(out!.kind).toBe("create")
    expect(out!.plainText).toBe("MENU_HELP")
    expect(out!.segments).toEqual([{ type: "text", text: "MENU_HELP" }])
  })

  it("drops a CLICK event without an EventKey", () => {
    const xml = `<xml><FromUserName><![CDATA[oU]]></FromUserName><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[CLICK]]></Event></xml>`
    expect(parseWechatOaXml(ADAPTER, "", xml)).toBeNull()
  })

  it("drops VIEW and other event pushes", () => {
    const view = `<xml><FromUserName><![CDATA[oU]]></FromUserName><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[VIEW]]></Event><EventKey><![CDATA[https://x]]></EventKey></xml>`
    expect(parseWechatOaXml(ADAPTER, "", view)).toBeNull()
    const scan = `<xml><FromUserName><![CDATA[oU]]></FromUserName><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[SCAN]]></Event></xml>`
    expect(parseWechatOaXml(ADAPTER, "", scan)).toBeNull()
    const noEvent = `<xml><FromUserName><![CDATA[oU]]></FromUserName><MsgType><![CDATA[event]]></MsgType></xml>`
    expect(parseWechatOaXml(ADAPTER, "", noEvent)).toBeNull()
  })

  it("returns null when required fields are missing", () => {
    expect(parseWechatOaXml(ADAPTER, "", "<xml></xml>")).toBeNull()
  })
})
