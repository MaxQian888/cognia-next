import { parseEml } from "./eml"

describe("parseEml", () => {
  it("parses a single message with headers + body", () => {
    const fixture = [
      "From: alice@example.com",
      "To: bob@example.com",
      "Subject: Hello",
      "Date: Fri, 1 Jan 2024 12:00:00 +0000",
      "",
      "Welcome aboard.",
    ].join("\n")
    const sources = parseEml(fixture, { twinId: "t1" })
    expect(sources).toHaveLength(1)
    expect(sources[0].id).toContain("_eml_")
    expect(sources[0].text).toContain("# Hello")
    expect(sources[0].text).toContain("Welcome aboard.")
    expect(sources[0].baseMetadata?.speakers).toContain("alice@example.com")
  })

  it("returns an empty list for empty input", () => {
    expect(parseEml("", { twinId: "t1" })).toEqual([])
  })
})
