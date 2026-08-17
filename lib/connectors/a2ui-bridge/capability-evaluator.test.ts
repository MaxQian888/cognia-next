import { buildCapabilityPromptSection } from "./capability-evaluator"
import { buildA2UICapabilityMatrix } from "@/types/connectors/capability"

describe("buildCapabilityPromptSection", () => {
  it("includes native + fallback + unsupported sections", () => {
    const matrix = buildA2UICapabilityMatrix({
      Text: "native",
      Button: "native",
      Card: "fallback",
      Chart: "unsupported",
      Table: "unsupported",
    })
    const prompt = buildCapabilityPromptSection("Telegram", matrix)
    expect(prompt).toContain("Telegram")
    // Catalogue order: Text precedes Button (display family before forms).
    expect(prompt).toContain("Renders natively: Text, Button")
    expect(prompt).toContain("NOT supported")
    // Catalogue order: Table precedes Chart in the data family.
    expect(prompt).toContain("Table, Chart")
    expect(prompt).toContain("Degrades to plain text")
  })

  it("omits the unsupported bullet when nothing is unsupported", () => {
    const matrix = buildA2UICapabilityMatrix({
      Text: "native",
    })
    const prompt = buildCapabilityPromptSection("Slack", matrix)
    expect(prompt).toContain("Slack")
    expect(prompt).not.toContain("NOT supported")
  })

  it("includes the simulated bullet with multi-step UX warning when present", () => {
    const matrix = buildA2UICapabilityMatrix({
      Text: "native",
      TextField: "simulated",
      TextArea: "simulated",
    })
    const prompt = buildCapabilityPromptSection("Telegram", matrix)
    expect(prompt).toContain("Available via multi-step UX")
    expect(prompt).toContain("do not assume a synchronous reply")
    // Catalogue order: TextField precedes TextArea in the forms family.
    expect(prompt).toContain("TextField, TextArea")
  })

  it("appends a Built-in skills line when skillCapabilities is provided (ADR-0026)", () => {
    const matrix = buildA2UICapabilityMatrix({ Text: "native" })
    const out = buildCapabilityPromptSection("lark", matrix, [
      { family: "lark.calendar", mutations: ["read", "write"] },
      { family: "lark.doc", mutations: ["read", "write", "destructive"] },
    ])
    expect(out).toContain("Built-in skills available on this channel:")
    expect(out).toContain("lark.calendar (read+write)")
    expect(out).toContain("lark.doc (read+write+destructive)")
    expect(out).toContain("A2UI confirm card")
  })

  it("does NOT append a Built-in skills line when skillCapabilities is omitted or empty", () => {
    const matrix = buildA2UICapabilityMatrix({ Text: "native" })
    const out1 = buildCapabilityPromptSection("lark", matrix)
    const out2 = buildCapabilityPromptSection("lark", matrix, [])
    expect(out1).not.toContain("Built-in skills available")
    expect(out2).not.toContain("Built-in skills available")
  })

  it("omits the simulated bullet when no simulated kinds are present", () => {
    const matrix = buildA2UICapabilityMatrix({
      Text: "native",
      Button: "native",
    })
    const prompt = buildCapabilityPromptSection("Slack", matrix)
    expect(prompt).not.toContain("Available via multi-step UX")
  })
})
