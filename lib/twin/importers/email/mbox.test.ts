import { detectMbox, parseMbox } from "./mbox"

describe("parseMbox", () => {
  it("returns no sources for empty input", () => {
    expect(parseMbox("", { twinId: "t1" })).toEqual([])
    expect(parseMbox("   \n", { twinId: "t1" })).toEqual([])
  })

  it("splits a 2-message mbox file by the From boundary", () => {
    const fixture = [
      "From sender@example.com Fri Jan 01 12:00:00 2024",
      "From: alice@example.com",
      "To: bob@example.com",
      "Subject: First",
      "Date: Fri, 1 Jan 2024 12:00:00 +0000",
      "",
      "Body of the first message.",
      "",
      "From sender@example.com Fri Jan 02 12:00:00 2024",
      "From: alice@example.com",
      "To: charlie@example.com",
      "Subject: Second",
      "Date: Fri, 2 Jan 2024 12:00:00 +0000",
      "",
      "Body of the second message.",
    ].join("\n")
    const sources = parseMbox(fixture, { twinId: "t1" })
    expect(sources).toHaveLength(2)
    expect(sources[0].text).toContain("# First")
    expect(sources[0].text).toContain("Body of the first message")
    expect(sources[0].baseMetadata?.speakers).toContain("alice@example.com")
    expect(sources[1].text).toContain("# Second")
  })

  it("falls back gracefully when there's no header/body separator", () => {
    const fixture = "From s@x 0\nLine without headers"
    const sources = parseMbox(fixture, { twinId: "t1" })
    expect(sources).toHaveLength(1)
    expect(sources[0].text).toContain("Line without headers")
  })

  it("unfolds RFC-2822 continuation lines in headers", () => {
    const fixture = [
      "From s@x 0",
      "From: alice@example.com",
      "Subject: Long subject that is",
      " continued onto the next line",
      "",
      "Hello.",
    ].join("\n")
    const [source] = parseMbox(fixture, { twinId: "t1" })
    expect(source.text).toContain("Long subject that is continued onto the next line")
  })

  it("captures parsable timestamps as numeric metadata", () => {
    const fixture = [
      "From s@x 0",
      "From: alice@example.com",
      "Subject: Stamped",
      "Date: Fri, 1 Jan 2024 12:00:00 +0000",
      "",
      "Body",
    ].join("\n")
    const [source] = parseMbox(fixture, { twinId: "t1" })
    expect(typeof source.baseMetadata?.timestamp).toBe("number")
    expect(source.baseMetadata?.timestamp).toBe(Date.parse("Fri, 1 Jan 2024 12:00:00 +0000"))
  })

  it("handles a file with no boundary markers as a single message", () => {
    const fixture = "Subject: standalone\n\nbody only"
    const sources = parseMbox(fixture, { twinId: "t1" })
    expect(sources).toHaveLength(1)
    expect(sources[0].text).toContain("body only")
  })
})

describe("detectMbox", () => {
  it("returns true for content starting with a From line", () => {
    expect(detectMbox("From sender@x Fri Jan 01 2024\n...")).toBe(true)
  })

  it("returns false for plain prose without a From line", () => {
    expect(detectMbox("Just some prose with no From marker.")).toBe(false)
  })
})
