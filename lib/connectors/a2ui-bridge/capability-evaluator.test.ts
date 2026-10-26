import { buildCapabilityPromptSection, CONNECTOR_CAPABILITY_PROMPTS } from "./capability-evaluator"
import { buildA2UICapabilityMatrix } from "@/types/connectors/capability"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"

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

describe("capability section wording (ADR-0236)", () => {
  afterEach(() => {
    __setPromptOverrideSnapshotForTests(null)
    __resetPromptVerdictsForTests()
  })

  it("sends published line wording with the channel's own kind lists", () => {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob",
          promptId: CONNECTOR_CAPABILITY_PROMPTS.unsupported.id,
          scope: "account",
          targetId: "",
          revisionId: "por-cap-unsupported",
          body: "- Never send these components: {{kinds}}.",
          contractVersion: CONNECTOR_CAPABILITY_PROMPTS.unsupported.contractVersion,
        },
      ])
    )
    const matrix = buildA2UICapabilityMatrix({ Text: "native", Chart: "unsupported" })
    const lines = buildCapabilityPromptSection("Telegram", matrix).split("\n")
    expect(lines[0]).toBe(
      "This conversation is delivered via Telegram. The platform supports a limited A2UI subset:"
    )
    expect(lines[1]).toBe("- Renders natively: Text.")
    expect(lines.at(-1)).toBe("- Never send these components: Chart.")
    expect(lines.join("\n")).not.toContain("NOT supported")
  })

  it("still skips a line whose level has no kinds, whatever its wording", () => {
    // Every kind defaults to "fallback": only the header and that line remain.
    const prompt = buildCapabilityPromptSection("Slack", buildA2UICapabilityMatrix({}))
    const lines = prompt.split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatch(/^- Degrades to plain text on this channel: /)
  })
})
