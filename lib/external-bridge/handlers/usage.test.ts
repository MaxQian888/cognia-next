/** @jest-environment jsdom */
// The read-only usage tools. Every test is about the boundary: what an
// external agent may learn, and what it may not.

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import type { CodeAdoptionTurnRow } from "@/lib/code-adoption/types"

import { optimizationFindings, pseudonymize, sessionHealth, usageQuery } from "./usage"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function row(over: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: "m1",
    sessionId: "customer-acme/secret-repo",
    at: Date.now(),
    model: "claude-opus-4",
    providerId: "anthropic",
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 2,
    durationMs: 0,
    costSource: "sdk",
    costKnown: true,
    ...over,
  }
}

function adoptionRow(over: Partial<CodeAdoptionTurnRow> = {}): CodeAdoptionTurnRow {
  return {
    id: "customer-acme/secret-repo:1",
    runId: 1,
    sessionId: "customer-acme/secret-repo",
    workspaceRoot: "/home/u/secret-repo",
    agentKind: "in-app",
    model: "claude-opus-4",
    ts: Date.now(),
    totalFiles: 1,
    totalAdded: 10,
    totalRemoved: 2,
    files: [{ path: "src/secret.ts", added: 10, removed: 2, isNew: false, hunks: [] }],
    truncated: false,
    measurement: "taskWorkspace",
    adoptionState: "accepted",
    acceptedFiles: 1,
    acceptedAdded: 10,
    acceptedRemoved: 2,
    ...over,
  }
}

describe("pseudonymize", () => {
  it("is stable, so an agent can correlate across calls", () => {
    expect(pseudonymize("a/b")).toBe(pseudonymize("a/b"))
  })

  it("does not leak the original id", () => {
    const out = pseudonymize("customer-acme/secret-repo")
    expect(out).not.toContain("acme")
    expect(out).not.toContain("secret")
  })

  it("separates different ids", () => {
    expect(pseudonymize("a")).not.toBe(pseudonymize("b"))
  })
})

describe("usageQuery", () => {
  it("refuses an unknown window rather than silently defaulting", () => {
    return expect(usageQuery({ period: "forever" })).resolves.toEqual({
      ok: false,
      reason: "invalidPeriod",
    })
  })

  it("returns totals with unpriced turns counted separately", async () => {
    await getDb().sessionUsage.bulkPut([
      row(),
      row({ messageId: "m2", costSource: "unknown", costKnown: false, costUsd: 0 }),
    ])
    const result = await usageQuery({ period: "7d" })
    expect(result).toMatchObject({ ok: true, knownCostUsd: 2, unpricedTurns: 1, turns: 2 })
  })

  it("keeps external spend out of the default scope", async () => {
    await getDb().sessionUsage.bulkPut([
      row(),
      row({ messageId: "x", sourceId: "codex", imported: true, costUsd: 99 }),
    ])
    const cognia = await usageQuery({ period: "7d" })
    const all = await usageQuery({ period: "7d", scope: "all-tools" })
    expect(cognia).toMatchObject({ knownCostUsd: 2 })
    expect(all).toMatchObject({ knownCostUsd: 101 })
  })

  it("returns provider and model ids, which are public vocabulary", async () => {
    await getDb().sessionUsage.put(row())
    const result = await usageQuery({ period: "7d" })
    expect(result).toMatchObject({ ok: true })
    if (!("topProviders" in result)) throw new Error("expected a result")
    expect(result.topProviders[0].id).toBe("anthropic")
    expect(result.topModels[0].id).toBe("claude-opus-4")
  })

  it("never returns a session id", async () => {
    await getDb().sessionUsage.put(row())
    const result = await usageQuery({ period: "7d" })
    expect(JSON.stringify(result)).not.toContain("secret-repo")
  })
})

describe("sessionHealth", () => {
  it("refuses an empty or unknown session", async () => {
    expect(await sessionHealth({ sessionId: "  " })).toEqual({
      ok: false,
      reason: "unknownSession",
    })
    expect(await sessionHealth({ sessionId: "nope" })).toEqual({
      ok: false,
      reason: "unknownSession",
    })
  })

  it("returns work-unit metrics for a known session", async () => {
    await getDb().sessionUsage.put(row())
    const result = await sessionHealth({ sessionId: "customer-acme/secret-repo" })
    expect(result).toMatchObject({ ok: true })
    if (!("metrics" in result)) throw new Error("expected a result")
    expect(result.metrics.turns).toBe(1)
  })

  it("pseudonymizes the session it was asked about", async () => {
    await getDb().sessionUsage.put(row())
    const result = await sessionHealth({ sessionId: "customer-acme/secret-repo" })
    if (!("sessionRef" in result)) throw new Error("expected a result")
    expect(result.sessionRef).not.toContain("acme")
    expect(JSON.stringify(result)).not.toContain("secret-repo")
  })

  it("never returns a file path from the adoption ledger", async () => {
    await getDb().sessionUsage.put(row())
    await getDb().codeAdoptionTurns.put(adoptionRow())
    const result = await sessionHealth({ sessionId: "customer-acme/secret-repo" })
    expect(JSON.stringify(result)).not.toContain("src/secret.ts")
    expect(JSON.stringify(result)).not.toContain("/home/u")
  })

  it("reports how far the outcome evidence can be trusted", async () => {
    await getDb().sessionUsage.put(row())
    await getDb().codeAdoptionTurns.put(adoptionRow())
    const result = await sessionHealth({ sessionId: "customer-acme/secret-repo" })
    if (!("attribution" in result)) throw new Error("expected a result")
    expect(result.attribution.confidence).toBe("measured")
    expect(result.attribution.acceptedFiles).toBe(1)
  })
})

describe("optimizationFindings", () => {
  it("refuses an unknown window", async () => {
    expect(await optimizationFindings({ period: "forever" })).toEqual({
      ok: false,
      reason: "invalidPeriod",
    })
  })

  it("returns findings for local spend", async () => {
    await getDb().sessionUsage.bulkPut(
      Array.from({ length: 40 }, (_, i) => row({ messageId: `m${i}` }))
    )
    const result = await optimizationFindings({ period: "30d" })
    if (!("findings" in result)) throw new Error("expected a result")
    expect(result.findings.length).toBeGreaterThan(0)
  })

  it("withholds the settings change behind a fix", async () => {
    // An external agent may read that a fix exists. Learning the key and the
    // value to write would let it reconfigure the user's app through a
    // read-only tool.
    await getDb().sessionUsage.bulkPut(
      Array.from({ length: 40 }, (_, i) => row({ messageId: `m${i}` }))
    )
    const result = await optimizationFindings({ period: "30d" })
    if (!("findings" in result)) throw new Error("expected a result")
    for (const finding of result.findings) {
      expect("action" in finding).toBe(false)
      expect(typeof finding.hasAction).toBe("boolean")
    }
  })

  it("ignores another tool's spend, which the user cannot act on here", async () => {
    await getDb().sessionUsage.bulkPut(
      Array.from({ length: 40 }, (_, i) =>
        row({ messageId: `m${i}`, sourceId: "codex", imported: true })
      )
    )
    const result = await optimizationFindings({ period: "30d" })
    if (!("findings" in result)) throw new Error("expected a result")
    expect(result.findings).toEqual([])
  })
})
