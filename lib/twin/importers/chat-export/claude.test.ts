import { isClaudeExportShape, parseClaudeExport } from "./claude"

describe("parseClaudeExport", () => {
  it("returns no sources for empty input", () => {
    expect(parseClaudeExport("", { twinId: "t1" })).toEqual([])
  })

  it("parses a single conversation with text-field messages", () => {
    const sources = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "c1",
          name: "Onboarding chat",
          chat_messages: [
            { uuid: "m1", sender: "human", text: "Hi", created_at: "2024-01-15T09:23:00Z" },
            {
              uuid: "m2",
              sender: "assistant",
              text: "Hello!",
              created_at: "2024-01-15T09:23:05Z",
            },
          ],
        },
      ]),
      { twinId: "t_a" }
    )
    expect(sources).toHaveLength(1)
    expect(sources[0].text).toContain("### User")
    expect(sources[0].text).toContain("Hi")
    expect(sources[0].text).toContain("### Claude")
    expect(sources[0].text).toContain("Hello!")
    expect(sources[0].filename).toContain("Onboarding chat")
    expect(sources[0].baseMetadata?.platform).toBe("claude")
  })

  it("prefers structured content[] over text when both are present", () => {
    const sources = parseClaudeExport(
      JSON.stringify([
        {
          name: "Mixed",
          chat_messages: [
            {
              sender: "assistant",
              text: "fallback",
              content: [
                { type: "text", text: "First seg" },
                { type: "text", text: "Second seg" },
              ],
            },
          ],
        },
      ]),
      { twinId: "t1" }
    )
    expect(sources[0].text).toContain("First seg")
    expect(sources[0].text).toContain("Second seg")
    expect(sources[0].text).not.toContain("fallback")
  })

  it("skips conversations with no usable messages", () => {
    const sources = parseClaudeExport(JSON.stringify([{ name: "Empty", chat_messages: [] }]), {
      twinId: "t1",
    })
    expect(sources).toEqual([])
  })

  it("isClaudeExportShape detects the right shape", () => {
    expect(isClaudeExportShape([{ chat_messages: [] }])).toBe(true)
    expect(isClaudeExportShape({ chat_messages: [] })).toBe(true)
    expect(isClaudeExportShape({ mapping: {} })).toBe(false)
    expect(isClaudeExportShape(null)).toBe(false)
  })
})
