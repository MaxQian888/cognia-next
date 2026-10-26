import {
  applyRetrievedVerdict,
  contentTokens,
  evictionCandidates,
  experienceFromReflection,
  experienceScopeFor,
  findConflicts,
  findDuplicate,
  isVisibleTo,
  jaccard,
  lifecycleStatus,
  markExperienceAdopted,
  mergeExperience,
  polarityOf,
  retrieveExperiences,
} from "./experience"
import { makeExperience, makeRun, makeRunConfig, makeTask } from "./test-fixtures"

const proposed = {
  cue: "CSV inputs use semicolon separators and the agent parses them as commas",
  lesson: "memory.md: state that CSV files may use ; and to check the header first",
  evidence: "dom1 parsed it, base1 did not",
  confidence: "medium" as const,
  appliesWhen: ["csv input"],
  notWhen: ["excel files"],
  tags: ["csv"],
}

const helpedEdit = {
  component: "memory.md",
  candidates: ["dom1"],
  change: "separator note",
  observed: "dom1 parsed the file",
  verdict: "helped" as const,
}

describe("text measures", () => {
  it("tokenises content words and measures overlap", () => {
    expect([...contentTokens("The CSV file, and the CSV header!")].sort()).toEqual([
      "csv",
      "file",
      "header",
    ])
    expect(jaccard(new Set(["a1", "b1"]), new Set(["a1"]))).toBe(0.5)
    expect(contentTokens("分号分隔的文件")).toEqual(
      new Set(["分号", "号分", "分隔", "隔的", "的文", "文件"])
    )
    expect(jaccard(new Set(), new Set())).toBe(0)
  })

  it("derives polarity from verdicts", () => {
    expect(polarityOf([helpedEdit])).toBe("positive")
    expect(polarityOf([{ ...helpedEdit, verdict: "hurt" }])).toBe("negative")
    expect(polarityOf([helpedEdit, { ...helpedEdit, verdict: "hurt" }])).toBe("mixed")
    expect(polarityOf([])).toBe("mixed")
  })
})

describe("experienceFromReflection", () => {
  it("verifies a lesson whose helpful edit was adopted", () => {
    const run = makeRun({
      baseSnapshotId: "snap-base",
      decision: {
        outcome: "adopt",
        reason: "r",
        chosenLabel: "dom1",
        chosenSnapshotId: "snap-dom1",
        requiresApproval: false,
      },
    })
    const exp = experienceFromReflection({
      id: "e1",
      now: 50,
      run,
      scope: "agent",
      proposed,
      edits: [
        helpedEdit,
        { ...helpedEdit, component: "guardrails.md", verdict: "no observed effect" },
      ],
      runtimeFingerprint: "hrf1-a",
      modelFamily: "claude",
      evidenceRefs: ["run-1:dom1", "run-1:dom1", "run-1:base1"],
      adopted: true,
    })
    expect(exp).toMatchObject({
      validationStatus: "verified",
      lastValidatedAt: 50,
      components: ["memory"],
      adoptedSnapshotId: "snap-dom1",
      baseSnapshotId: "snap-base",
      domain: "office/reports",
      evidenceRefs: ["run-1:dom1", "run-1:base1"],
      changeSummary: "memory.md: separator note (helped)",
      observedBenefits: ["dom1 parsed the file"],
      knownLimitations: ["excel files"],
      supportRunIds: ["run-1"],
      modelFamily: "claude",
    })
  })

  it("leaves an unadopted lesson proposed and infers components from its text", () => {
    const exp = experienceFromReflection({
      id: "e1",
      now: 1,
      run: makeRun({ decision: { outcome: "keep-base", reason: "r", requiresApproval: false } }),
      scope: "agent",
      proposed: { ...proposed, lesson: "Add a toolRules cap on Bash" },
      edits: [{ ...helpedEdit, component: "unknown thing", verdict: "hurt", observed: "looped" }],
      runtimeFingerprint: "f",
      evidenceRefs: [],
      adopted: false,
    })
    expect(exp.validationStatus).toBe("proposed")
    expect(exp.components).toEqual(["toolRules"])
    expect(exp.knownLimitations).toEqual(["excel files", "looped"])
    expect(exp.baseSnapshotId).toBe("")
  })

  it("waits for the adoption before verifying, then verifies on adoption", () => {
    const run = makeRun({
      decision: {
        outcome: "adopt",
        reason: "r",
        chosenLabel: "dom1",
        chosenSnapshotId: "snap-dom1",
        requiresApproval: true,
      },
    })
    const pending = experienceFromReflection({
      id: "e1",
      now: 1,
      run,
      scope: "agent",
      proposed,
      edits: [helpedEdit],
      runtimeFingerprint: "f",
      evidenceRefs: [],
      adopted: false,
    })
    expect(pending.validationStatus).toBe("proposed")
    const adopted = markExperienceAdopted(
      pending,
      { chosenLabel: "dom1", chosenSnapshotId: "snap-dom1" },
      9
    )
    expect(adopted).toMatchObject({
      validationStatus: "verified",
      lastValidatedAt: 9,
      adoptedSnapshotId: "snap-dom1",
    })
    const unrelated = markExperienceAdopted(
      pending,
      { chosenLabel: "inv1", chosenSnapshotId: "snap-inv1" },
      9
    )
    expect(unrelated.validationStatus).toBe("proposed")
    expect(unrelated.adoptedSnapshotId).toBe("snap-inv1")
  })

  it("scopes lessons to what the run can vouch for", () => {
    expect(
      experienceScopeFor({ projectId: "p", config: makeRunConfig({ scope: "workspace" }) })
    ).toBe("workspace")
    expect(experienceScopeFor({ config: makeRunConfig({ scope: "workspace" }) })).toBe("agent")
    expect(experienceScopeFor({ config: makeRunConfig({ scope: "global" }) })).toBe("global")
    expect(experienceScopeFor({ config: makeRunConfig({ scope: "session" }) })).toBe("agent")
  })
})

describe("visibility, duplicates and conflicts", () => {
  it("shows agent, workspace and global entries to the right runs", () => {
    const q = { characterIds: ["agent-1", "base-agent"], projectId: "p1" }
    expect(isVisibleTo(makeExperience(), q)).toBe(true)
    expect(isVisibleTo(makeExperience({ characterId: "other" }), q)).toBe(false)
    expect(isVisibleTo(makeExperience({ scope: "workspace", projectId: "p1" }), q)).toBe(true)
    expect(isVisibleTo(makeExperience({ scope: "workspace", projectId: "p2" }), q)).toBe(false)
    expect(
      isVisibleTo(makeExperience({ scope: "workspace", projectId: "p1" }), { characterIds: [] })
    ).toBe(false)
    expect(isVisibleTo(makeExperience({ scope: "global", characterId: "x" }), q)).toBe(true)
  })

  it("finds the same lesson and merges it", () => {
    const existing = makeExperience({ id: "old", confidence: "low", validationStatus: "proposed" })
    const incoming = makeExperience({
      id: "new",
      sourceRunId: "run-9",
      confidence: "high",
      validationStatus: "verified",
      lesson: "memory.md: state that CSV files may use ; and to check the header row first",
      tags: ["csv", "read"],
      evidenceRefs: ["run-9:dom1"],
    })
    expect(findDuplicate(incoming, [existing])?.id).toBe("old")
    expect(findDuplicate(incoming, [{ ...existing, domain: "coding" }])).toBeUndefined()
    expect(findDuplicate(incoming, [{ ...existing, validationStatus: "rejected" }])).toBeUndefined()
    expect(findDuplicate(incoming, [{ ...existing, characterId: "other" }])).toBeUndefined()
    expect(findDuplicate(incoming, [{ ...existing, components: ["toolRules"] }])).toBeUndefined()
    expect(
      findDuplicate(incoming, [{ ...existing, edits: [{ ...helpedEdit, verdict: "hurt" }] }])
    ).toBeUndefined()
    expect(
      findDuplicate(incoming, [
        { ...existing, lesson: "totally unrelated words here", problemPattern: "zzz yyy" },
      ])
    ).toBeUndefined()

    const merged = mergeExperience(existing, incoming, 99)
    expect(merged).toMatchObject({
      id: "old",
      confidence: "high",
      validationStatus: "verified",
      lastValidatedAt: 99,
      supportRunIds: ["run-0", "run-9"],
      tags: ["csv", "read"],
      updatedAt: 99,
    })
    expect(merged.evidenceRefs).toEqual(["run-0:dom1", "run-9:dom1"])
    expect(
      mergeExperience({ ...existing, validationStatus: "deprecated" }, incoming, 1).validationStatus
    ).toBe("deprecated")
  })

  it("flags opposite lessons about the same situation", () => {
    const helped = makeExperience({ id: "a" })
    const hurt = makeExperience({
      id: "b",
      edits: [{ ...helpedEdit, verdict: "hurt" }],
      lesson: "do not add separator notes",
    })
    expect(findConflicts(hurt, [helped])).toEqual(["a"])
    expect(findConflicts(hurt, [{ ...helped, domain: "coding" }])).toEqual([])
    expect(findConflicts(makeExperience({ id: "c", edits: [] }), [helped])).toEqual([])
    expect(findConflicts(makeExperience({ id: "d" }), [helped])).toEqual([])
  })
})

describe("lifecycle", () => {
  it("verifies on help, rejects on repeated harm and never undoes a person's call", () => {
    let e = makeExperience()
    e = applyRetrievedVerdict(e, "helped", 10)
    expect(e).toMatchObject({ helpedCount: 1, validationStatus: "verified", lastValidatedAt: 10 })
    e = applyRetrievedVerdict(e, "hurt", 11)
    e = applyRetrievedVerdict(e, "hurt", 12)
    expect(e.validationStatus).toBe("rejected")
    expect(applyRetrievedVerdict(makeExperience(), "no observed effect", 1).validationStatus).toBe(
      "proposed"
    )
    expect(lifecycleStatus({ validationStatus: "deprecated", helpedCount: 5, hurtCount: 0 })).toBe(
      "deprecated"
    )
    expect(lifecycleStatus({ validationStatus: "verified", helpedCount: 1, hurtCount: 2 })).toBe(
      "rejected"
    )
    expect(lifecycleStatus({ validationStatus: "verified", helpedCount: 0, hurtCount: 1 })).toBe(
      "proposed"
    )
    expect(lifecycleStatus({ validationStatus: "proposed", helpedCount: 1, hurtCount: 1 })).toBe(
      "proposed"
    )
  })
})

describe("retrieveExperiences", () => {
  const query = {
    characterIds: ["agent-1"],
    domain: "office/reports",
    taskText: "Summarise the CSV input with semicolon separators",
    editable: ["memory", "skills"] as const,
    runtimeFingerprint: "hrf1-a",
  }

  it("ranks visible, relevant, healthy entries and explains why", () => {
    const entries = [
      makeExperience({ id: "verified", validationStatus: "verified", helpedCount: 2 }),
      makeExperience({ id: "plain" }),
      makeExperience({ id: "stale", runtimeFingerprint: "hrf1-old" }),
      makeExperience({ id: "rejected", validationStatus: "rejected" }),
      makeExperience({ id: "off", disabled: true }),
      makeExperience({ id: "other-agent", characterId: "x" }),
      makeExperience({ id: "other-component", components: ["toolRules"] }),
      makeExperience({ id: "other-domain", domain: "coding" }),
      makeExperience({ id: "parent-domain", domain: "office" }),
      makeExperience({
        id: "excluded",
        excludedConditions: ["semicolon separators csv input summarise"],
      }),
    ]
    const matches = retrieveExperiences(entries, {
      ...query,
      editable: [...query.editable],
      limit: 10,
    })
    const ids = matches.map((m) => m.experience.id)
    expect(ids[0]).toBe("verified")
    expect(ids).toEqual(expect.arrayContaining(["plain", "stale", "parent-domain", "excluded"]))
    expect(ids).not.toEqual(expect.arrayContaining(["rejected"]))
    for (const gone of ["rejected", "off", "other-agent", "other-component", "other-domain"]) {
      expect(ids).not.toContain(gone)
    }
    const stale = matches.find((m) => m.experience.id === "stale")
    expect(stale?.stale).toBe(true)
    expect(stale?.reasons).toContain("recorded on another runtime")
    expect(matches.find((m) => m.experience.id === "verified")?.reasons).toEqual(
      expect.arrayContaining(["same domain", "verified", "helped 2, hurt 0"])
    )
    expect(matches.find((m) => m.experience.id === "excluded")?.reasons).toContain(
      "matches an excluded condition"
    )
    expect(retrieveExperiences(entries, { ...query, editable: [...query.editable] })).toHaveLength(
      5
    )
  })
})

describe("retrieveExperiences (Chinese)", () => {
  it("matches Chinese lessons against a Chinese task", () => {
    const zh = makeExperience({
      id: "zh",
      problemPattern: "CSV 文件使用分号分隔，智能体按逗号解析",
      lesson: "memory.md：说明 CSV 可能使用分号，先检查表头",
      applicableConditions: [],
      tags: [],
    })
    const other = makeExperience({
      id: "other",
      problemPattern: "合并冲突导致测试失败",
      lesson: "guardrails.md：先运行测试",
      applicableConditions: [],
      tags: [],
    })
    const [first] = retrieveExperiences([other, zh], {
      characterIds: ["agent-1"],
      domain: "office/reports",
      taskText: "把分号分隔的 CSV 文件汇总成报告",
      editable: ["memory", "guardrails"],
      runtimeFingerprint: "hrf1-a",
    })
    expect(first.experience.id).toBe("zh")
  })
})

describe("evictionCandidates", () => {
  it("evicts the weakest entries first and keeps verified ones longest", () => {
    const entries = [
      makeExperience({ id: "v", validationStatus: "verified", updatedAt: 1 }),
      makeExperience({ id: "p-old", updatedAt: 1 }),
      makeExperience({ id: "p-new", updatedAt: 5 }),
      makeExperience({ id: "r", validationStatus: "rejected", updatedAt: 9 }),
      makeExperience({ id: "d", disabled: true, updatedAt: 9 }),
    ]
    expect(evictionCandidates(entries, 2)).toEqual(["r", "d", "p-old"])
    expect(evictionCandidates(entries, 10)).toEqual([])
  })
})

it("uses fixtures that read as one domain", () => {
  expect(makeTask().domain).toBe(makeExperience().domain)
})
