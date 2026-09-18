/**
 * @jest-environment jsdom
 */
import {
  addSuppressionRule,
  clearAllRuns,
  deleteRun,
  getPref,
  listFindingStates,
  listFindings,
  listRuns,
  listSuppressionRules,
  markInterruptedRuns,
  removeSuppressionRule,
  setFindingState,
  setPref,
  suppressionRuleId,
} from "./db"
import type { StrixRun } from "./types"
import type { PluginDexieAPI } from "@cognia/plugin-sdk"
/**
 * Map-backed stand-in for one namespaced plugin table.
 *
 * Only the four operations these helpers use. The logic under test is key
 * DERIVATION and the delete-on-open rule, neither of which needs a real
 * IndexedDB to exercise.
 */
function fakeDexie() {
  const tables = new Map<string, Map<string, Record<string, unknown>>>()
  const rows = (name: string) => {
    const existing = tables.get(name)
    if (existing) return existing
    const created = new Map<string, Record<string, unknown>>()
    tables.set(name, created)
    return created
  }
  const api = {
    table: (name: string) => ({
      put: async (row: Record<string, unknown>) => {
        rows(name).set(String(row.key ?? row.id), row)
      },
      get: async (key: string) => rows(name).get(key),
      delete: async (key: string) => {
        rows(name).delete(key)
      },
      clear: async () => {
        rows(name).clear()
      },
      bulkPut: async (list: Record<string, unknown>[]) => {
        for (const row of list) rows(name).set(String(row.key ?? row.id ?? row.runId), row)
      },
      orderBy: (field: string) => ({
        reverse: () => ({
          toArray: async () =>
            [...rows(name).values()].sort((a, b) => Number(b[field]) - Number(a[field])),
        }),
      }),
      where: (field: string) => ({
        equals: (value: unknown) => {
          const matched = () => [...rows(name).entries()].filter(([, row]) => row[field] === value)
          return {
            toArray: async () => matched().map(([, row]) => row),
            delete: async () => {
              for (const [key] of matched()) rows(name).delete(key)
            },
            filter: (fn: (row: Record<string, unknown>) => boolean) => ({
              toArray: async () =>
                matched()
                  .map(([, row]) => row)
                  .filter(fn),
            }),
          }
        },
      }),
    }),
  } as unknown as PluginDexieAPI
  return { api, rows }
}

describe("finding states", () => {
  it("keys a verdict by normalized target and fingerprint", async () => {
    const { api, rows } = fakeDexie()
    await setFindingState(api, {
      // Raw, with scheme, case and a trailing slash — all incidental.
      target: "https://Example.COM/app/",
      fingerprint: "fp1",
      state: "accepted",
      now: 5,
    })
    const stored = [...rows("findingStates").values()]
    expect(stored).toEqual([
      {
        key: "example.com/app fp1",
        target: "example.com/app",
        fingerprint: "fp1",
        state: "accepted",
        updatedAt: 5,
      },
    ])
  })

  it("finds a verdict recorded under a differently-spelled form of the target", async () => {
    // The point of normalizing: a rescan typed as `http://example.com` must
    // still see the verdict recorded against `https://Example.COM/`.
    const { api } = fakeDexie()
    await setFindingState(api, {
      target: "https://Example.COM/",
      fingerprint: "fp1",
      state: "accepted",
      now: 5,
    })
    expect(await listFindingStates(api, "http://example.com")).toHaveLength(1)
  })

  it("stores an optional note and omits it when absent", async () => {
    const { api, rows } = fakeDexie()
    await setFindingState(api, {
      target: "t",
      fingerprint: "a",
      state: "fixed",
      note: "PR #4",
      now: 1,
    })
    await setFindingState(api, { target: "t", fingerprint: "b", state: "fixed", now: 1 })
    const stored = [...rows("findingStates").values()]
    expect(stored[0].note).toBe("PR #4")
    expect(stored[1]).not.toHaveProperty("note")
  })

  it("deletes the row when a verdict returns to open", async () => {
    // Open is the ABSENCE of a decision. Persisting it would make "never
    // triaged" and "looked at and left open" indistinguishable in every count.
    const { api, rows } = fakeDexie()
    await setFindingState(api, { target: "t", fingerprint: "fp1", state: "accepted", now: 1 })
    expect(rows("findingStates").size).toBe(1)
    await setFindingState(api, { target: "t", fingerprint: "fp1", state: "open", now: 2 })
    expect(rows("findingStates").size).toBe(0)
  })

  it("overwrites rather than duplicating a re-decided finding", async () => {
    const { api, rows } = fakeDexie()
    await setFindingState(api, { target: "t", fingerprint: "fp1", state: "accepted", now: 1 })
    await setFindingState(api, { target: "t", fingerprint: "fp1", state: "false-positive", now: 9 })
    const stored = [...rows("findingStates").values()]
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ state: "false-positive", updatedAt: 9 })
  })

  it("keeps verdicts for different targets apart", async () => {
    const { api } = fakeDexie()
    await setFindingState(api, {
      target: "https://a.com",
      fingerprint: "fp1",
      state: "accepted",
      now: 1,
    })
    await setFindingState(api, {
      target: "https://b.com",
      fingerprint: "fp1",
      state: "fixed",
      now: 1,
    })
    expect(await listFindingStates(api, "https://a.com")).toHaveLength(1)
    expect((await listFindingStates(api, "https://b.com"))[0]).toMatchObject({ state: "fixed" })
  })
})

describe("suppression rules", () => {
  it("derives a stable id from the normalized target and rule", () => {
    expect(suppressionRuleId("https://Example.COM/", "sqli")).toBe("example.com::sqli")
  })

  it("stores and lists a rule for its target", async () => {
    const { api } = fakeDexie()
    await addSuppressionRule(api, {
      target: "https://example.com",
      ruleId: "sqli",
      reason: "wontfix",
      now: 3,
    })
    const rules = await listSuppressionRules(api, "https://example.com/")
    expect(rules).toEqual([
      {
        id: "example.com::sqli",
        target: "example.com",
        ruleId: "sqli",
        reason: "wontfix",
        createdAt: 3,
      },
    ])
  })

  it("is idempotent — muting the same rule twice leaves one row", async () => {
    const { api, rows } = fakeDexie()
    await addSuppressionRule(api, { target: "t", ruleId: "sqli", now: 1 })
    await addSuppressionRule(api, { target: "t", ruleId: "sqli", now: 2 })
    expect(rows("suppressionRules").size).toBe(1)
  })

  it("removes a rule by id", async () => {
    const { api, rows } = fakeDexie()
    await addSuppressionRule(api, { target: "t", ruleId: "sqli", now: 1 })
    await removeSuppressionRule(api, suppressionRuleId("t", "sqli"))
    expect(rows("suppressionRules").size).toBe(0)
  })

  it("keeps rules for different targets apart", async () => {
    const { api } = fakeDexie()
    await addSuppressionRule(api, { target: "https://a.com", ruleId: "sqli", now: 1 })
    await addSuppressionRule(api, { target: "https://b.com", ruleId: "xss", now: 1 })
    expect(await listSuppressionRules(api, "https://a.com")).toHaveLength(1)
    expect((await listSuppressionRules(api, "https://b.com"))[0].ruleId).toBe("xss")
  })
})

describe("markInterruptedRuns", () => {
  const runRow = (over: Partial<StrixRun>): StrixRun & Record<string, unknown> => ({
    runId: "r",
    target: "t",
    startedAt: 0,
    status: "running",
    findingsCount: 0,
    authorizedAt: 0,
    ...over,
  })

  it("cancels runs started before activation and returns them", async () => {
    const { api, rows } = fakeDexie()
    rows("runs").set("old", runRow({ runId: "old", startedAt: 100 }))
    rows("runs").set("done", runRow({ runId: "done", startedAt: 50, status: "done" }))

    const reconciled = await markInterruptedRuns(api, { cutoff: 500, error: "interrupted" })
    expect(reconciled).toHaveLength(1)
    expect(reconciled[0]).toMatchObject({
      runId: "old",
      status: "cancelled",
      endedAt: 500,
      error: "interrupted",
    })
    expect(rows("runs").get("old")?.status).toBe("cancelled")
    // A genuinely finished run is untouched.
    expect(rows("runs").get("done")?.status).toBe("done")
  })

  it("leaves a scan started by this generation alone — another panel may own it", async () => {
    const { api, rows } = fakeDexie()
    rows("runs").set("live", runRow({ runId: "live", startedAt: 600 }))

    const reconciled = await markInterruptedRuns(api, { cutoff: 500, error: "interrupted" })
    expect(reconciled).toHaveLength(0)
    expect(rows("runs").get("live")?.status).toBe("running")
  })
})

describe("runs + findings tables", () => {
  const runRow = (over: Partial<StrixRun>): StrixRun & Record<string, unknown> => ({
    runId: "r",
    target: "t",
    startedAt: 0,
    status: "done",
    findingsCount: 0,
    authorizedAt: 0,
    ...over,
  })

  it("lists runs newest-first", async () => {
    const { api, rows } = fakeDexie()
    rows("runs").set("a", runRow({ runId: "a", startedAt: 10 }))
    rows("runs").set("b", runRow({ runId: "b", startedAt: 30 }))
    rows("runs").set("c", runRow({ runId: "c", startedAt: 20 }))

    expect((await listRuns(api)).map((r) => r.runId)).toEqual(["b", "c", "a"])
  })

  it("lists only the findings belonging to a run", async () => {
    const { api, rows } = fakeDexie()
    rows("findings").set("f1", { id: 1, runId: "r1", severity: "high" })
    rows("findings").set("f2", { id: 2, runId: "r2", severity: "low" })

    const findings = await listFindings(api, "r1")
    expect(findings).toHaveLength(1)
    expect(findings[0].runId).toBe("r1")
  })

  it("deletes a run's findings with the run but leaves other runs alone", async () => {
    const { api, rows } = fakeDexie()
    rows("runs").set("r1", runRow({ runId: "r1" }))
    rows("runs").set("r2", runRow({ runId: "r2" }))
    rows("findings").set("f1", { id: 1, runId: "r1" })
    rows("findings").set("f2", { id: 2, runId: "r2" })

    await deleteRun(api, "r1")
    expect(rows("runs").has("r1")).toBe(false)
    expect(rows("runs").has("r2")).toBe(true)
    expect(rows("findings").has("f1")).toBe(false)
    expect(rows("findings").has("f2")).toBe(true)
  })

  it("clear-all wipes runs, findings, and target-scoped triage too", async () => {
    const { api, rows } = fakeDexie()
    rows("runs").set("r1", runRow({ runId: "r1" }))
    rows("findings").set("f1", { id: 1, runId: "r1" })
    rows("findingStates").set("s1", { key: "s1" })
    rows("suppressionRules").set("x1", { id: "x1" })

    await clearAllRuns(api)
    for (const name of ["runs", "findings", "findingStates", "suppressionRules"]) {
      expect(rows(name).size).toBe(0)
    }
  })
})

describe("prefs", () => {
  it("round-trips a preference and reports misses as undefined", async () => {
    const { api } = fakeDexie()
    expect(await getPref(api, "lastTarget")).toBeUndefined()
    await setPref(api, "lastTarget", "https://saved")
    expect(await getPref(api, "lastTarget")).toBe("https://saved")
    await setPref(api, "lastTarget", "https://newer")
    expect(await getPref(api, "lastTarget")).toBe("https://newer")
  })
})
