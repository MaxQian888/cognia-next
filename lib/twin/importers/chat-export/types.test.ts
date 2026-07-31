import { parseChatExportJson } from "./types"

describe("parseChatExportJson", () => {
  it("returns the parsed object for valid JSON", () => {
    expect(parseChatExportJson('{"messages":[]}', "Slack")).toEqual({ messages: [] })
  })

  it("returns the parsed array for a top-level JSON array", () => {
    expect(parseChatExportJson("[1,2,3]", "Slack")).toEqual([1, 2, 3])
  })

  it("throws a platform-labelled error on malformed JSON", () => {
    expect(() => parseChatExportJson("not json", "Slack")).toThrow(/Slack import: malformed JSON/)
  })

  it("includes the underlying parser reason in the message", () => {
    let captured = ""
    try {
      parseChatExportJson("{bad}", "Lark")
    } catch (err) {
      captured = err instanceof Error ? err.message : String(err)
    }
    expect(captured).toMatch(/Lark import: malformed JSON —/)
  })
})
