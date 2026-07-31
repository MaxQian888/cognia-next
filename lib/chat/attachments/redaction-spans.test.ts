import { redactText } from "@cognia/redact"
import { countRedactions, splitRedactionSpans } from "./redaction-spans"

describe("splitRedactionSpans", () => {
  it("returns no spans for empty text", () => {
    expect(splitRedactionSpans("")).toEqual([])
  })

  it("returns a single plain span when nothing was redacted", () => {
    expect(splitRedactionSpans("just prose")).toEqual([{ text: "just prose", redacted: false }])
  })

  it("splits a placeholder out of surrounding prose", () => {
    expect(splitRedactionSpans("Contact <EMAIL_001> today")).toEqual([
      { text: "Contact ", redacted: false },
      { text: "<EMAIL_001>", redacted: true },
      { text: " today", redacted: false },
    ])
  })

  it("handles a placeholder at the very start and end", () => {
    expect(splitRedactionSpans("<EMAIL_001> and <PHONE_002>")).toEqual([
      { text: "<EMAIL_001>", redacted: true },
      { text: " and ", redacted: false },
      { text: "<PHONE_002>", redacted: true },
    ])
  })

  it("supports counters that grew past three digits", () => {
    const spans = splitRedactionSpans("x <EMAIL_1234> y")
    expect(spans[1]).toEqual({ text: "<EMAIL_1234>", redacted: true })
  })

  it("leaves angle-bracketed text that is not a known PII kind alone", () => {
    expect(splitRedactionSpans("see <DIV_001> here")).toEqual([
      { text: "see <DIV_001> here", redacted: false },
    ])
  })

  // Guards the "fresh regex per call" note: a shared /g/ regex would carry
  // lastIndex between calls and silently drop matches on the second one.
  it("is not stateful across calls", () => {
    const input = "a <EMAIL_001> b"
    expect(splitRedactionSpans(input)).toEqual(splitRedactionSpans(input))
  })

  // The whole point of the model view: what it renders must be reconstructible
  // from what actually goes on the wire.
  it("round-trips real redactor output", () => {
    const { redacted } = redactText("Reach me at alice@example.com please")
    const spans = splitRedactionSpans(redacted)
    expect(spans.map((s) => s.text).join("")).toBe(redacted)
    expect(spans.filter((s) => s.redacted)).toHaveLength(1)
    expect(spans.some((s) => s.text.includes("alice@example.com"))).toBe(false)
  })
})

describe("countRedactions", () => {
  it("counts zero for empty and clean text", () => {
    expect(countRedactions("")).toBe(0)
    expect(countRedactions("nothing here")).toBe(0)
  })

  it("counts each placeholder occurrence", () => {
    expect(countRedactions("<EMAIL_001> <PHONE_002> <EMAIL_001>")).toBe(3)
  })
})
