import { SUPPORT_DOC_CORPUS, retrieveSupportDocumentation } from "./knowledge"

describe("Support documentation corpus", () => {
  it("bundles the complete bilingual Markdown documentation set", () => {
    expect(SUPPORT_DOC_CORPUS.en.length).toBeGreaterThan(300)
    expect(SUPPORT_DOC_CORPUS.zh.length).toBeGreaterThan(300)
    expect(SUPPORT_DOC_CORPUS.en.some((doc) => doc.path === "index.mdx")).toBe(true)
    expect(SUPPORT_DOC_CORPUS.zh.some((doc) => doc.path === "index.mdx")).toBe(true)
  })

  it("retrieves relevant English documentation with source paths", () => {
    const result = retrieveSupportDocumentation({
      locale: "en",
      query: "How do plugin permissions and capabilities work?",
    })
    expect(result).toContain("docs/content/docs/en/")
    expect(result.toLowerCase()).toContain("plugin")
  })

  it("retrieves the Chinese corpus for a Chinese locale", () => {
    const result = retrieveSupportDocumentation({ locale: "zh-CN", query: "如何配置 MCP 服务器？" })
    expect(result).toContain("docs/content/docs/zh/")
    expect(result).toMatch(/MCP|服务器/)
  })

  it("keeps retrieved context within the requested bound", () => {
    const result = retrieveSupportDocumentation({
      locale: "en",
      query: "architecture runtime plugins workflow mobile diagnostics",
      maxChars: 1_200,
      limit: 20,
    })
    expect(result.length).toBeLessThanOrEqual(1_200)
  })
})
