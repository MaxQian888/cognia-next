import { isLarkDocUrl, parseLarkDocUrl } from "./lark-url"

describe("parseLarkDocUrl", () => {
  it("parses a feishu.cn docx URL", () => {
    expect(parseLarkDocUrl("https://acme.feishu.cn/docx/doxcnAbCdEfGh1234567890")).toEqual({
      kind: "docx",
      token: "doxcnAbCdEfGh1234567890",
      host: "acme.feishu.cn",
    })
  })

  it("parses a wiki URL on larksuite.com", () => {
    expect(parseLarkDocUrl("https://acme.larksuite.com/wiki/wikcnAbCdEfGh123456789")).toEqual({
      kind: "wiki",
      token: "wikcnAbCdEfGh123456789",
      host: "acme.larksuite.com",
    })
  })

  it("parses a legacy /docs/ URL as kind doc", () => {
    const ref = parseLarkDocUrl("https://acme.feishu.cn/docs/doccnLegacyToken12345")
    expect(ref?.kind).toBe("doc")
    expect(ref?.token).toBe("doccnLegacyToken12345")
  })

  it("parses larkoffice.com hosts", () => {
    const ref = parseLarkDocUrl("https://acme.larkoffice.com/docx/doxcnAbCdEfGh1234567890")
    expect(ref).toMatchObject({ kind: "docx", host: "acme.larkoffice.com" })
    expect(ref?.lowConfidence).toBeUndefined()
  })

  it("strips query string and hash", () => {
    const ref = parseLarkDocUrl(
      "https://acme.feishu.cn/docx/doxcnAbCdEfGh1234567890?from=share#heading-1"
    )
    expect(ref?.token).toBe("doxcnAbCdEfGh1234567890")
  })

  it("flags unknown hosts with a matching path as lowConfidence", () => {
    const ref = parseLarkDocUrl("https://portal.example.com/docx/doxcnAbCdEfGh1234567890")
    expect(ref).toMatchObject({
      kind: "docx",
      token: "doxcnAbCdEfGh1234567890",
      host: "portal.example.com",
      lowConfidence: true,
    })
  })

  it("parses bare docx tokens (doxcn/doxbc prefixes)", () => {
    expect(parseLarkDocUrl("doxcnAbCdEfGh1234567890")).toEqual({
      kind: "docx",
      token: "doxcnAbCdEfGh1234567890",
    })
    expect(parseLarkDocUrl("doxbcAbCdEfGh1234567890")?.kind).toBe("docx")
  })

  it("parses bare wiki tokens", () => {
    expect(parseLarkDocUrl("wikcnAbCdEfGh123456789")).toEqual({
      kind: "wiki",
      token: "wikcnAbCdEfGh123456789",
    })
  })

  it("rejects non-Lark URLs and unknown bare strings", () => {
    expect(parseLarkDocUrl("https://github.com/anthropics/claude-code")).toBeNull()
    expect(parseLarkDocUrl("https://acme.feishu.cn/sheets/shtcnAbCdEfGh123456789")).toBeNull()
    expect(parseLarkDocUrl("https://acme.feishu.cn/base/bascnAbCdEfGh123456789")).toBeNull()
    expect(parseLarkDocUrl("hello world")).toBeNull()
    expect(parseLarkDocUrl("randomtoken1234567890")).toBeNull()
    expect(parseLarkDocUrl("")).toBeNull()
    expect(parseLarkDocUrl("   ")).toBeNull()
  })

  it("rejects non-http(s) schemes and malformed URLs", () => {
    expect(parseLarkDocUrl("ftp://acme.feishu.cn/docx/doxcnAbCdEfGh1234567890")).toBeNull()
    expect(parseLarkDocUrl("https://")).toBeNull()
  })

  it("rejects kind segments with invalid or missing tokens", () => {
    expect(parseLarkDocUrl("https://acme.feishu.cn/docx/")).toBeNull()
    expect(parseLarkDocUrl("https://acme.feishu.cn/docx/short")).toBeNull()
    expect(parseLarkDocUrl("https://acme.feishu.cn/docx/has%20space%20chars%20here")).toBeNull()
  })
})

describe("isLarkDocUrl", () => {
  it("mirrors parseLarkDocUrl truthiness", () => {
    expect(isLarkDocUrl("https://acme.feishu.cn/docx/doxcnAbCdEfGh1234567890")).toBe(true)
    expect(isLarkDocUrl("https://example.com/blog/post")).toBe(false)
  })
})
