import type { HarnessComponentsV1 } from "@/types/harness/snapshot"
import { LOW_RISK_ALWAYS_ON_GROWTH, assessHarnessRisk, requiresApproval } from "./risk"
import { diffHarness } from "./snapshot"
import { makeComponents, makeSkill } from "./test-fixtures"

const base = makeComponents()

function assess(candidate: HarnessComponentsV1, execution: Record<string, unknown> = {}) {
  return assessHarnessRisk(
    base,
    candidate,
    diffHarness({ components: base, execution: {} }, { components: candidate, execution })
  )
}

describe("assessHarnessRisk", () => {
  it("rates an unchanged harness low", () => {
    expect(assess(base)).toEqual({ risk: "low", reasons: ["no change"] })
  })

  it("rates small additive knowledge low", () => {
    const result = assess({ ...base, memory: `${base.memory}\nCSV files use ; as separator.` })
    expect(result.risk).toBe("low")
    expect(result.reasons).toEqual(["memory.md modified"])
  })

  it.each<[string, HarnessComponentsV1]>([
    ["system prompt", { ...base, systemPrompt: "Different persona." }],
    [
      "skill body",
      {
        ...base,
        skills: [
          makeSkill({
            content: "1. Read the CSV.\n2. Run `scripts/summarize.py data.csv`.\n3. Stop.",
          }),
        ],
      },
    ],
    [
      "new skill",
      {
        ...base,
        skills: [
          ...base.skills,
          makeSkill({ key: "other", name: "other", content: "x", resources: [] }),
        ],
      },
    ],
    ["removed skill instructions", { ...base, skills: [] }],
    ["guardrail removed", { ...base, guardrails: "" }],
    [
      "tool rule added",
      {
        ...base,
        toolRules: [
          ...base.toolRules,
          { id: "trim", kind: "trim-output", tool: "Read", maxChars: 900 },
        ],
      },
    ],
    [
      "large growth",
      {
        ...base,
        toolGuidance: `${base.toolGuidance}\n${"x".repeat(LOW_RISK_ALWAYS_ON_GROWTH + 1)}`,
      },
    ],
  ])("rates a %s change medium or higher", (_label, candidate) => {
    expect(assess(candidate).risk).not.toBe("low")
  })

  it.each<[string, HarnessComponentsV1, RegExp]>([
    [
      "changed script",
      {
        ...base,
        skills: [
          makeSkill({ resources: [{ ...makeSkill().resources[0], content: "print(1)\n" }] }),
        ],
      },
      /script skills\/csv-report\/scripts\/summarize\.py modified/,
    ],
    [
      "changed subagent",
      { ...base, subagents: [{ ...base.subagents[0], prompt: "Check harder." }] },
      /subagent sub_agents\/checker\/AGENT\.md modified/,
    ],
    ["removed cap", { ...base, toolRules: [] }, /tool rule bash-cap removed/],
    [
      "wider pre-approval",
      { ...base, skills: [makeSkill({ allowedTools: ["Bash"] })] },
      /pre-approves Bash/,
    ],
  ])("rates a %s high", (_label, candidate, reason) => {
    const result = assess(candidate)
    expect(result.risk).toBe("high")
    expect(result.reasons.join("\n")).toMatch(reason)
  })

  it("rates an execution change high", () => {
    expect(assess(base, { model: "other" })).toMatchObject({ risk: "high" })
  })
})

describe("requiresApproval", () => {
  it("always asks for workspace and global scope", () => {
    expect(requiresApproval("low", "global", true)).toBe(true)
    expect(requiresApproval("low", "workspace", true)).toBe(true)
  })

  it("skips approval only for low risk at task/session scope with auto-adoption on", () => {
    expect(requiresApproval("low", "session", true)).toBe(false)
    expect(requiresApproval("low", "task", true)).toBe(false)
    expect(requiresApproval("low", "session", false)).toBe(true)
    expect(requiresApproval("medium", "session", true)).toBe(true)
  })
})
