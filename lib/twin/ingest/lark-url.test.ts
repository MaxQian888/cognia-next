import { isLarkDocUrl, isLarkResourceUrl, parseLarkDocUrl, parseLarkResourceUrl } from "./lark-url"

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

describe("parseLarkResourceUrl", () => {
  it("parses the sheet and Bitable paths the doc parser rejects", () => {
    expect(parseLarkResourceUrl("https://acme.feishu.cn/sheets/shtcnAbCdEfGh1234567890")).toEqual({
      kind: "sheet",
      token: "shtcnAbCdEfGh1234567890",
      host: "acme.feishu.cn",
    })
    expect(parseLarkResourceUrl("https://acme.feishu.cn/base/bascnAbCdEfGh1234567890")).toEqual({
      kind: "bitable",
      token: "bascnAbCdEfGh1234567890",
      host: "acme.feishu.cn",
    })
  })

  it("parses bare legacy doc tokens so search results resolve without a URL", () => {
    expect(parseLarkResourceUrl("doccnAbCdEfGh1234567890")).toEqual({
      kind: "doc",
      token: "doccnAbCdEfGh1234567890",
    })
    expect(parseLarkDocUrl("doccnAbCdEfGh1234567890")).toEqual({
      kind: "doc",
      token: "doccnAbCdEfGh1234567890",
    })
  })

  it("parses bare sheet and Bitable tokens", () => {
    expect(parseLarkResourceUrl("shtcnAbCdEfGh1234567890")).toEqual({
      kind: "sheet",
      token: "shtcnAbCdEfGh1234567890",
    })
    expect(parseLarkResourceUrl("basbcAbCdEfGh1234567890")).toEqual({
      kind: "bitable",
      token: "basbcAbCdEfGh1234567890",
    })
  })

  it("still parses every doc kind identically to parseLarkDocUrl", () => {
    for (const url of [
      "https://acme.feishu.cn/docx/doxcnAbCdEfGh1234567890",
      "https://acme.feishu.cn/wiki/wikcnAbCdEfGh123456789",
      "https://acme.larksuite.com/docs/doccnAbCdEfGh1234567890",
      "doxbcAbCdEfGh1234567890",
    ]) {
      expect(parseLarkResourceUrl(url)).toEqual(parseLarkDocUrl(url))
    }
  })

  it("flags an unknown host as low confidence for the new kinds too", () => {
    expect(parseLarkResourceUrl("https://docs.acme.dev/sheets/shtcnAbCdEfGh1234567890")).toEqual({
      kind: "sheet",
      token: "shtcnAbCdEfGh1234567890",
      host: "docs.acme.dev",
      lowConfidence: true,
    })
  })

  it("rejects slides, unknown prefixes and malformed input", () => {
    expect(parseLarkResourceUrl("https://acme.feishu.cn/slides/slicnAbCdEfGh12345678")).toBeNull()
    expect(parseLarkResourceUrl("zzzcnAbCdEfGh1234567890")).toBeNull()
    expect(parseLarkResourceUrl("   ")).toBeNull()
    expect(parseLarkResourceUrl("ftp://acme.feishu.cn/sheets/shtcnAbCdEfGh1234567890")).toBeNull()
  })
})

describe("parseLarkDocUrl narrowing", () => {
  it("keeps rejecting sheets and Bitable so the twin pipeline is unchanged", () => {
    expect(parseLarkDocUrl("https://acme.feishu.cn/sheets/shtcnAbCdEfGh1234567890")).toBeNull()
    expect(parseLarkDocUrl("https://acme.feishu.cn/base/bascnAbCdEfGh1234567890")).toBeNull()
    expect(parseLarkDocUrl("shtcnAbCdEfGh1234567890")).toBeNull()
    expect(parseLarkDocUrl("bascnAbCdEfGh1234567890")).toBeNull()
  })
})

describe("isLarkResourceUrl", () => {
  it("mirrors parseLarkResourceUrl truthiness and is wider than isLarkDocUrl", () => {
    const sheet = "https://acme.feishu.cn/sheets/shtcnAbCdEfGh1234567890"
    expect(isLarkResourceUrl(sheet)).toBe(true)
    expect(isLarkDocUrl(sheet)).toBe(false)
    expect(isLarkResourceUrl("https://example.com/blog/post")).toBe(false)
  })
})
