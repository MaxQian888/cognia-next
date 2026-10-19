import {
  BASE,
  decisionLabelsFor,
  evidenceLabelsFor,
  finalLabels,
  planRun,
  plannedWork,
  rolloutLabel,
  statusForStep,
} from "./recursion"

describe("planRun", () => {
  it.each([1, 2, 3, 4])("schedules R = 4k rollouts and P = 3k sessions for k=%i", (k) => {
    for (const mode of ["parallel", "sequential"] as const) {
      expect(plannedWork(planRun(mode, k))).toEqual({
        rollouts: 4 * k,
        editorSessions: 3 * k,
        judgeCalls: 2,
      })
    }
  })

  it("gives every step a unique label", () => {
    for (const mode of ["parallel", "sequential"] as const) {
      const labels = planRun(mode, 3).map((s) => s.label)
      expect(new Set(labels).size).toBe(labels.length)
    }
  })

  it("plans parallel stages from the base with a whole-pool composer", () => {
    const steps = planRun("parallel", 2)
    expect(steps.map((s) => s.label)).toEqual([
      "base1",
      "base2",
      "inv1",
      "dom1",
      "inv2",
      "dom2",
      "roll:inv1",
      "roll:dom1",
      "roll:inv2",
      "roll:dom2",
      "agg1",
      "agg2",
      "roll:agg1",
      "roll:agg2",
      "select",
      "reflect",
    ])
    expect(steps.find((s) => s.label === "dom2")).toMatchObject({ dim: "DOM", input: BASE })
    expect(steps.find((s) => s.label === "agg2")?.pool).toEqual(["inv1", "dom1", "inv2", "dom2"])
  })

  it("chains sequential rounds through the composed harness", () => {
    const steps = planRun("sequential", 2)
    expect(steps.find((s) => s.label === "inv1")?.input).toBe(BASE)
    expect(steps.find((s) => s.label === "inv2")?.input).toBe("c1")
    expect(steps.find((s) => s.label === "c2")).toMatchObject({
      pool: ["inv2", "dom2"],
      input: "c1",
      round: 2,
    })
    expect(finalLabels("sequential", 2)).toEqual(["c1", "c2"])
    expect(finalLabels("parallel", 2)).toEqual(["agg1", "agg2"])
  })
})

describe("labels and statuses", () => {
  it("names rollouts", () => {
    expect(rolloutLabel(BASE, 3)).toBe("base3")
    expect(rolloutLabel("inv1")).toBe("roll:inv1")
  })

  it("maps steps to run statuses", () => {
    const steps = planRun("parallel", 1)
    expect(steps.map(statusForStep)).toEqual([
      "reference_running",
      "proposing",
      "proposing",
      "probing",
      "probing",
      "composing",
      "probing",
      "evaluating",
      "reflecting",
    ])
  })
})

describe("evidence and history", () => {
  it("shows parallel editors the base rollouts only", () => {
    const steps = planRun("parallel", 2)
    const agg = steps.find((s) => s.label === "agg1")!
    expect(evidenceLabelsFor(agg, steps)).toEqual(["base1", "base2"])
    expect(decisionLabelsFor(agg, steps)).toEqual([])
  })

  it("shows a sequential round everything earlier, its pool through the pool", () => {
    const steps = planRun("sequential", 2)
    const inv2 = steps.find((s) => s.label === "inv2")!
    expect(evidenceLabelsFor(inv2, steps)).toEqual([
      "base1",
      "base2",
      "roll:inv1",
      "roll:dom1",
      "roll:c1",
    ])
    expect(decisionLabelsFor(inv2, steps)).toEqual(["inv1", "dom1", "c1"])
    const c2 = steps.find((s) => s.label === "c2")!
    expect(evidenceLabelsFor(c2, steps)).not.toContain("roll:inv2")
    expect(
      decisionLabelsFor(
        steps.find((s) => s.label === "inv1")!,
        steps
      )
    ).toEqual([])
  })
})
