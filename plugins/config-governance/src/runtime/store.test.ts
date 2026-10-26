import type { AuditRun, Finding } from "../model"
import {
  compactRun,
  countGroups,
  GovernanceStore,
  MAX_EVIDENCE_CHARS,
  MAX_FINDINGS,
  MAX_HISTORY,
  RecordTooLargeError,
  workspaceKey,
  type StorageLike,
} from "./store"

function memory(): StorageLike & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    get: async <T>(key: string) => data.get(key) as T | undefined,
    set: async <T>(key: string, value: T) => {
      data.set(key, JSON.parse(JSON.stringify(value)))
    },
    remove: async (key: string) => {
      data.delete(key)
    },
  }
}

function finding(id: string, partial: Partial<Finding> = {}): Finding {
  return {
    id,
    group: "dated-text",
    pattern: "p",
    location: { surfaceKey: "k" },
    evidence: "e",
    reason: "",
    confidence: "high",
    action: "flag",
    sources: ["signal"],
    ...partial,
  }
}

function run(findings: Finding[], workspaceId: string | null = "w"): AuditRun {
  return {
    id: "r1",
    workspaceId,
    startedAt: 0,
    finishedAt: 10,
    targetModel: "m",
    surfaces: [],
    findings,
    hunks: findings.map((entry) => ({
      findingId: entry.id,
      surfaceKey: "k",
      startLine: 1,
      endLine: 1,
      before: ["x"],
      after: [],
      proposedOnly: false,
    })),
    failedSources: [],
    notes: [],
  }
}

describe("compactRun", () => {
  it("caps findings, clips evidence and drops hunks of dropped findings", () => {
    const many = Array.from({ length: MAX_FINDINGS + 2 }, (_, i) =>
      finding(`F${i}`, { evidence: "x".repeat(MAX_EVIDENCE_CHARS + 10) })
    )
    const compact = compactRun(run(many))
    expect(compact.findings).toHaveLength(MAX_FINDINGS)
    expect(compact.findings[0]!.evidence).toHaveLength(MAX_EVIDENCE_CHARS)
    expect(
      compact.hunks.every((hunk) => compact.findings.some((entry) => entry.id === hunk.findingId))
    ).toBe(true)
    expect(compact.notes).toContain(`findings-capped:${MAX_FINDINGS + 2}`)
  })
})

describe("GovernanceStore", () => {
  it("keys records per workspace", () => {
    expect(workspaceKey(null)).toBe("account")
    expect(workspaceKey("w")).toBe("ws:w")
  })

  it("saves the latest run and a bounded history of counts", async () => {
    const store = new GovernanceStore(memory())
    for (let i = 0; i < MAX_HISTORY + 2; i++)
      await store.saveRun({
        ...run([finding("a"), finding("b", { group: "hygiene", confidence: "low" })]),
        id: `r${i}`,
      })
    expect((await store.latestRun("w"))?.id).toBe(`r${MAX_HISTORY + 1}`)
    const history = await store.history("w")
    expect(history).toHaveLength(MAX_HISTORY)
    expect(history[0]).toMatchObject({ high: 1, counts: { "dated-text": 1, hygiene: 1 } })
    expect(await store.latestRun(null)).toBeUndefined()
  })

  it("keeps findings, labels, rules, changes and evals", async () => {
    const store = new GovernanceStore(memory())
    await store.setKept("w", "F1", true)
    await store.setKept("w", "F2", true)
    await store.setKept("w", "F1", false)
    expect([...(await store.keptFindings("w"))]).toEqual(["F2"])
    await store.setFalseMatch("C1|s|1", true)
    await store.setFalseMatch("C2|s|1", true)
    await store.clearFalseMatches("C1")
    expect([...(await store.falseMatches())]).toEqual(["C2|s|1"])
    await store.recordApplied({
      id: "a",
      at: 1,
      workspaceId: "w",
      surfaceKey: "k",
      resultKey: "k",
      surfaceName: "n",
      findingIds: [],
      hunks: 1,
    })
    expect(await store.appliedChanges()).toHaveLength(1)
    await store.recordEval({
      id: "e",
      at: 1,
      workspaceId: "w",
      role: "baseline",
      datasetId: "d",
      model: "m",
      runIds: [],
    })
    expect(await store.evalRecords()).toHaveLength(1)
    await store.saveRules([])
    expect(await store.rules()).toEqual([])
    await store.setLastWorkspace(null)
    expect(await store.lastWorkspace()).toBeNull()
    await store.markAudited("w")
    await store.markAudited(null)
    await store.markAudited("w")
    expect(await store.auditedWorkspaces()).toEqual(["w", null])
  })

  it("refuses records that would push the plugin over its quota", async () => {
    const store = new GovernanceStore(memory())
    const huge = {
      derivedAt: 0,
      checks: [],
      notCheckable: 0,
      rejected: 0,
      padding: "x".repeat(1_600_000),
    }
    await expect(store.saveChecks("w", huge)).rejects.toBeInstanceOf(RecordTooLargeError)
    await expect(
      store.saveRules(Array.from({ length: 101 }, () => ({}) as never))
    ).rejects.toBeInstanceOf(RecordTooLargeError)
  })

  it("counts groups", () => {
    expect(countGroups([finding("a"), finding("b", { group: "adherence" })])).toEqual({
      "brittle-config": 0,
      adherence: 1,
      "dated-text": 1,
      descriptions: 0,
      hygiene: 0,
    })
  })
})
