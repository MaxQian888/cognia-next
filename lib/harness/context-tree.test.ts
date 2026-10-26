import type { HarnessExecutionEvidence } from "@/types/harness/evolution"
import type { HarnessExperience } from "@/types/harness/experience"
import { HARNESS_COMPONENT_NAMES } from "@/types/harness/snapshot"
import { buildContextTree, harnessTreeOf, inlineContextTree } from "./context-tree"
import { makeComponents, makeTask } from "./test-fixtures"
import { componentsToTree } from "./tree"

const evidence = {
  snapshotId: "s",
  inputFingerprint: "i",
  environmentFingerprint: "e",
  output: "Report written.",
  trajectory: "[ACTION] Write {}",
  deliverables: [{ path: "report.md", bytes: 3, text: "abc" }],
  metrics: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    latencyMs: 1,
    toolCalls: 1,
    toolFailures: 0,
    steps: 1,
  },
  validation: [],
  blockedActions: [],
  delegations: [],
  degraded: false,
  delivered: true,
} as HarnessExecutionEvidence

const experience = {
  id: "exp-1",
  domain: "office/reports",
  validationStatus: "verified",
  confidence: "high",
  helpedCount: 2,
  hurtCount: 0,
  retrievedCount: 2,
  problemPattern: "CSV with ; separators\nmore",
  lesson: "memory.md: state the separator",
  evidenceSummary: "base misparsed",
  excludedConditions: ["comma files"],
} as unknown as HarnessExperience

describe("buildContextTree", () => {
  const current = makeComponents()

  it("lays out rules, task, rollouts, deliverables and the harness", () => {
    const tree = buildContextTree({
      task: makeTask({ prompt: "Summarise data.csv for a@example.com" }),
      current,
      editable: ["memory", "skills"],
      rollouts: [{ label: "base1", evidence }],
    })
    expect(Object.keys(tree)).toEqual(
      expect.arrayContaining([
        "RULES.md",
        "context/task.md",
        "rollouts/base1.md",
        "deliverables/base1/produced.md",
        "harness/systemprompt.md",
        "harness/skills/csv-report/SKILL.md",
      ])
    )
    expect(tree["RULES.md"]).toMatch(/- memory\n- skills/)
    expect(tree["RULES.md"]).toMatch(/Locked \(must stay byte-identical\)/)
    expect(tree["context/task.md"]).not.toContain("a@example.com")
    expect(tree["context/task.md"]).toContain("deliverable report.md")
    expect(tree["context/task.md"]).toContain("scratch copy")
    expect(harnessTreeOf(tree)).toEqual(componentsToTree(current))
  })

  it("adds the pool with diffs, decisions and retrieved lessons", () => {
    const candidate = makeComponents({ memory: "Reports go in report.md.\nUse ; separators." })
    const tree = buildContextTree({
      task: makeTask({ isolation: "git" }),
      current,
      editable: HARNESS_COMPONENT_NAMES,
      rollouts: [],
      pool: [
        { label: "inv1", components: current },
        { label: "dom1", components: candidate, rollout: evidence, notes: "- memory: separator" },
      ],
      decisions: [
        { label: "c1", dim: "COMPOSE", round: 1, notes: "kept dom", outcome: "delivered" },
        { label: "inv1", notes: "", fellBack: true },
      ],
      experiences: [experience],
    })
    expect(tree["pool/inv1/harness.diff"]).toBe("(identical to the current harness)\n")
    expect(tree["pool/dom1/harness.diff"]).toContain("+Use ; separators.")
    expect(tree["pool/dom1/rollout.md"]).toMatch(/^# Rollout dom1/)
    expect(tree["pool/dom1/notes.md"]).toBe("- memory: separator")
    expect(tree["pool/dom1/harness/memory.md"]).toContain("separators")
    expect(tree["decisions/c1.md"]).toMatch(/# c1 \(COMPOSE\), round 1/)
    expect(tree["decisions/inv1.md"]).toContain("invalid twice")
    expect(tree["library/INDEX.md"]).toContain("- exp-1 [verified, high] CSV with ; separators")
    expect(tree["library/exp-1.md"]).toContain("## Not when")
    expect(tree["context/task.md"]).toContain("git worktree")
  })
})

describe("inlineContextTree", () => {
  it("orders files for reading and always keeps the harness whole", () => {
    const tree = {
      "harness/memory.md": "MEM",
      "rollouts/base1.md": "R".repeat(50),
      "RULES.md": "rules",
      "context/task.md": "task",
    }
    const text = inlineContextTree(tree, 10_000)
    expect(text.indexOf("FILE: RULES.md")).toBeLessThan(text.indexOf("FILE: context/task.md"))
    expect(text.indexOf("FILE: rollouts/base1.md")).toBeLessThan(
      text.indexOf("FILE: harness/memory.md")
    )
    const tight = inlineContextTree(tree, 250)
    expect(tight).toContain("FILE: harness/memory.md")
    expect(tight).toContain("OMITTED")
    expect(tight).toContain("- rollouts/base1.md (50 chars)")
  })
})
