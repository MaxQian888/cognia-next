// Tests for the Gemini / Bard importer. Sample data approximates the shape
// Google Takeout produces (MyActivity.json).

import { detectGemini, parseGemini } from "./gemini-import"

const SAMPLE = [
  {
    header: "Bard",
    title: "Asked: What's React?",
    time: "2024-01-01T10:00:00Z",
  },
  {
    header: "Bard",
    title: "Bard answered: A JavaScript library for UIs.",
    time: "2024-01-01T10:00:30Z",
  },
  {
    header: "Bard",
    title: "Asked: When was it released?",
    time: "2024-01-01T10:01:00Z",
  },
  {
    header: "Bard",
    title: "Bard answered: 2013.",
    time: "2024-01-01T10:01:30Z",
  },
  // 31 minutes later — new conversation
  {
    header: "Gemini",
    title: "Asked: hi",
    time: "2024-01-01T10:32:30Z",
  },
  {
    header: "Gemini",
    title: "Gemini answered: hello!",
    time: "2024-01-01T10:33:00Z",
  },
]

describe("detectGemini", () => {
  it("matches Bard / Gemini headers", () => {
    expect(detectGemini(SAMPLE)).toBe(true)
  })
  it("matches when products array contains Gemini", () => {
    expect(detectGemini([{ products: ["Gemini"], header: "Other" }])).toBe(true)
  })
  it("rejects unrelated activity", () => {
    expect(detectGemini([{ header: "Search" }])).toBe(false)
    expect(detectGemini([])).toBe(false)
  })
})

describe("parseGemini", () => {
  it("groups activities by 30-minute gap into conversations", async () => {
    const out = await parseGemini(SAMPLE, {})
    expect(out).toHaveLength(2)
  })

  it("derives a title from the first user prompt", async () => {
    const out = await parseGemini(SAMPLE, {})
    expect(out[0].session.title.toLowerCase()).toContain("react")
  })

  it("alternates user/assistant turns", async () => {
    const out = await parseGemini(SAMPLE, {})
    expect(out[0].messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"])
  })

  it("strips the leading 'Asked:' / 'Bard answered:' label", async () => {
    const out = await parseGemini(SAMPLE, {})
    expect((out[0].messages[0].parts[0] as { text: string }).text).toBe("What's React?")
    expect((out[0].messages[1].parts[0] as { text: string }).text).toBe(
      "A JavaScript library for UIs."
    )
  })

  it("falls back to defaultTitle when no user prompts exist", async () => {
    const onlyAssistant = [
      { header: "Bard", title: "Bard answered: Hi", time: "2024-01-01T10:00:00Z" },
    ]
    const out = await parseGemini(onlyAssistant, { defaultTitle: "Imported" })
    expect(out[0].session.title).toBe("Imported")
  })
})
