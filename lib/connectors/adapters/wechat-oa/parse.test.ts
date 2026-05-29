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

  it("returns null for event pushes and unknown types", () => {
    const eventXml = `<xml><FromUserName><![CDATA[oU]]></FromUserName><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe]]></Event></xml>`
    expect(parseWechatOaXml(ADAPTER, "", eventXml)).toBeNull()
    const linkXml = `<xml><FromUserName><![CDATA[oU]]></FromUserName><MsgType><![CDATA[link]]></MsgType></xml>`
    expect(parseWechatOaXml(ADAPTER, "", linkXml)).toBeNull()
  })

  it("returns null when required fields are missing", () => {
    expect(parseWechatOaXml(ADAPTER, "", "<xml></xml>")).toBeNull()
  })
})
