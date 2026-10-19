import {
  HARNESS_EVOLUTION_START_MODES,
  HARNESS_TOOL_RULE_KINDS,
  HARNESS_TOOL_RULES_VERSION,
  hasHarnessContent,
} from "./agent-harness"

describe("hasHarnessContent", () => {
  it("is false for nothing, blanks and an adoption pointer alone", () => {
    expect(hasHarnessContent(undefined)).toBe(false)
    expect(hasHarnessContent(null)).toBe(false)
    expect(hasHarnessContent({ guardrails: "  ", subagents: [], toolRules: [] })).toBe(false)
    expect(hasHarnessContent({ adoptedSnapshotId: "snap-1" })).toBe(false)
  })

  it.each([
    [{ guardrails: "x" }],
    [{ memory: "x" }],
    [{ toolGuidance: "x" }],
    [{ subagents: [{ name: "a", description: "d", prompt: "p" }] }],
    [{ toolRules: [{ id: "r", kind: "trim-output" as const, tool: "Read", maxChars: 500 }] }],
  ])("is true for %j", (harness) => {
    expect(hasHarnessContent(harness)).toBe(true)
  })
})

describe("harness constants", () => {
  it("pins the rule schema version and the closed vocabularies", () => {
    expect(HARNESS_TOOL_RULES_VERSION).toBe(1)
    expect(HARNESS_TOOL_RULE_KINDS).toEqual([
      "error-hint",
      "trim-output",
      "call-cap",
      "verify-after-write",
    ])
    expect(HARNESS_EVOLUTION_START_MODES).toEqual([
      "disabled",
      "manual",
      "failure-triggered",
      "background",
    ])
  })
})
