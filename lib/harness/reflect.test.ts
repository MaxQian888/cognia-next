import { componentsOfEdit, parseReflection, reflectorUserPrompt } from "./reflect"
import { makeEvidence, makeExperience, makeTask } from "./test-fixtures"

const known = { labels: ["inv1", "dom1", "agg1"], retrievedIds: ["exp-1"] }

describe("reflectorUserPrompt", () => {
  it("lays out the task, decision, base rollouts, candidates and given lessons", () => {
    const text = reflectorUserPrompt({
      task: makeTask({ prompt: "Summarise data.csv and mail jane@example.com" }),
      base: [{ label: "base1", evidence: makeEvidence() }],
      candidates: [
        {
          label: "inv1",
          dim: "INV",
          notes: "- guardrails",
          diff: "+check numbers",
          evidence: makeEvidence(),
        },
        { label: "dom1", dim: "DOM", notes: "", diff: "", fellBack: true },
        { label: "c1", dim: "COMPOSE", round: 2, notes: "kept", diff: "", keptBase: true },
      ],
      decision: {
        outcome: "adopt",
        reason: "dominated",
        chosenLabel: "inv1",
        requiresApproval: false,
      },
      retrieved: [makeExperience()],
    })
    expect(text).not.toContain("jane@example.com")
    expect(text).toContain("- outcome: adopt (inv1)")
    expect(text).toContain("# Rollout base1")
    expect(text).toContain("### inv1 (INV)")
    expect(text).toContain("invalid twice")
    expect(text).toContain("### c1 (COMPOSE, round 2)")
    expect(text).toContain("kept its input unchanged")
    expect(text).toContain("(this candidate was not rolled)")
    expect(text).toContain("- exp-1: when CSV inputs use semicolon")
  })

  it("caps a large reflection", () => {
    const text = reflectorUserPrompt({
      task: makeTask(),
      base: [{ label: "base1", evidence: makeEvidence({ trajectory: "x".repeat(50_000) }) }],
      candidates: [],
      decision: { outcome: "keep-base", reason: "none", requiresApproval: false },
      retrieved: [],
      maxChars: 10_000,
    })
    expect(text.length).toBeLessThanOrEqual(10_100)
    expect(text).toContain("chars omitted")
  })
})

describe("parseReflection", () => {
  const answer = (value: unknown) => `Here you go:\n${JSON.stringify(value)}`

  it("keeps valid edit rows, known candidates, retrieved verdicts and one lesson", () => {
    const parsed = parseReflection(
      answer({
        edits: [
          {
            component: "memory.md",
            candidates: ["dom1", "ghost"],
            change: "note",
            observed: "parsed",
            verdict: "helped",
          },
          { component: "x", verdict: "maybe" },
          "junk",
          { component: "", verdict: "hurt" },
        ],
        retrieved: [
          { id: "exp-1", verdict: "helped" },
          { id: "exp-1", verdict: "hurt" },
          { id: "unknown", verdict: "helped" },
          { id: "exp-1x", verdict: "bad" },
        ],
        experience: {
          cue: "CSV with ; separators, key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
          lesson: "memory.md: mention separators",
          evidence: "dom1 vs base1",
          confidence: "high",
          applies_when: ["csv", 3],
          not_when: ["xlsx"],
          tags: ["Read"],
        },
      }),
      known
    )
    expect(parsed?.edits).toEqual([
      {
        component: "memory.md",
        candidates: ["dom1"],
        change: "note",
        observed: "parsed",
        verdict: "helped",
      },
    ])
    expect(parsed?.retrieved).toEqual([{ id: "exp-1", verdict: "helped" }])
    expect(parsed?.experience).toMatchObject({
      lesson: "memory.md: mention separators",
      confidence: "high",
      appliesWhen: ["csv"],
      notWhen: ["xlsx"],
      tags: ["read"],
    })
    expect(parsed?.experience?.cue).not.toContain("sk-ant-api03")
  })

  it("drops a lesson without an observable effect or without its parts", () => {
    const confounded = parseReflection(
      answer({
        edits: [
          {
            component: "memory.md",
            candidates: [],
            change: "c",
            observed: "o",
            verdict: "confounded",
          },
        ],
        experience: { cue: "a", lesson: "b", evidence: "c" },
      }),
      known
    )
    expect(confounded?.experience).toBeNull()
    expect(confounded?.droppedExperience).toMatch(/No edit had an observable effect/)
    const partial = parseReflection(
      answer({
        edits: [{ component: "memory.md", verdict: "hurt" }],
        experience: { cue: "a", lesson: "", evidence: "c", confidence: "weird" },
      }),
      known
    )
    expect(partial?.experience).toBeNull()
    expect(partial?.droppedExperience).toMatch(/missing/)
    expect(parseReflection(answer({ edits: [], experience: null }), known)).toEqual({
      edits: [],
      retrieved: [],
      experience: null,
    })
    expect(parseReflection("no json", known)).toBeNull()
  })
})

describe("componentsOfEdit", () => {
  it("maps paths and names to components", () => {
    expect(componentsOfEdit("harness/memory.md")).toEqual(["memory"])
    expect(componentsOfEdit("skills/csv/SKILL.md")).toEqual(["skills"])
    expect(componentsOfEdit("the toolRules list")).toEqual(["toolRules"])
    expect(componentsOfEdit("nothing")).toEqual([])
  })
})
