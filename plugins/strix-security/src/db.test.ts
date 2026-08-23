/**
 * @jest-environment jsdom
 */
import {
  addSuppressionRule,
  listFindingStates,
  listSuppressionRules,
  removeSuppressionRule,
  setFindingState,
  suppressionRuleId,
} from "./db"
import type { PluginDexieAPI } from "@/lib/plugin/api/dexie-api"

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
      delete: async (key: string) => {
        rows(name).delete(key)
      },
      where: (field: string) => ({
        equals: (value: unknown) => ({
          toArray: async () => [...rows(name).values()].filter((row) => row[field] === value),
        }),
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
