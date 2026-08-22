import { ExternalAgentLifecycleError } from "@/types/agent/external-agent-lifecycle"
import type { ExternalAgentRuntimeReceipt } from "@/types/agent/external-agent-lifecycle"

import {
  buildReceipt,
  canRollback,
  healthyAt,
  receiptFromRollback,
  receiptId,
  receiptMatchesTree,
  rollbackSlotFrom,
  unhealthyAt,
} from "./receipts"

const AT = "2026-08-22T12:00:00.000Z"
const LATER = "2026-08-23T12:00:00.000Z"

function receipt(
  overrides: Partial<ExternalAgentRuntimeReceipt> = {}
): ExternalAgentRuntimeReceipt {
  return {
    receiptId: receiptId("deepseek-harness", "1.0.0", "npm", AT),
    runtimeId: "deepseek-harness",
    version: "1.0.0",
    provider: "npm",
    providerVersion: "10.9.0",
    source: "@example/agent@1.0.0",
    installRoot: "/managed/deepseek-harness/current",
    entrypoint: "/managed/deepseek-harness/current/node_modules/.bin/agent",
    treeDigest: "a".repeat(64),
    installedAt: AT,
    activatedAt: AT,
    health: healthyAt(AT),
    ...overrides,
  }
}

describe("receiptId", () => {
  it("is stable for the same install and distinct across versions", () => {
    expect(receiptId("r", "1.0.0", "npm", AT)).toBe(receiptId("r", "1.0.0", "npm", AT))
    expect(receiptId("r", "1.0.0", "npm", AT)).not.toBe(receiptId("r", "1.0.1", "npm", AT))
    expect(receiptId("r", "1.0.0", "npm", AT)).not.toBe(receiptId("r", "1.0.0", "pnpm", AT))
  })
})

describe("health helpers", () => {
  it("builds a clean pass and a single-finding failure", () => {
    expect(healthyAt(AT)).toEqual({ healthy: true, checkedAt: AT, findings: [] })
    expect(unhealthyAt(AT, "entrypoint-failed", "exited 1")).toEqual({
      healthy: false,
      checkedAt: AT,
      findings: [{ code: "entrypoint-failed", severity: "error", detail: "exited 1" }],
    })
  })
})

describe("buildReceipt", () => {
  it("records everything needed to re-verify the install later", () => {
    const built = buildReceipt({
      runtimeId: "deepseek-harness",
      version: "2.0.0",
      provider: "pnpm",
      providerVersion: "9.0.0",
      source: "@example/agent@2.0.0",
      installRoot: "/managed/current",
      entrypoint: "/managed/current/bin/agent",
      treeDigest: "b".repeat(64),
      lockDigest: "c".repeat(64),
      health: healthyAt(LATER),
      installedAt: LATER,
      activatedAt: LATER,
    })

    expect(built).toMatchObject({
      runtimeId: "deepseek-harness",
      version: "2.0.0",
      provider: "pnpm",
      providerVersion: "9.0.0",
      treeDigest: "b".repeat(64),
      lockDigest: "c".repeat(64),
    })
    expect(built.previous).toBeUndefined()
  })

  it("keeps the outgoing healthy install as the single rollback slot", () => {
    const previous = receipt()
    const built = buildReceipt({
      runtimeId: "deepseek-harness",
      version: "2.0.0",
      provider: "npm",
      providerVersion: "10.9.0",
      source: "s",
      installRoot: "/managed/current",
      entrypoint: "/managed/current/bin/agent",
      treeDigest: "b".repeat(64),
      health: healthyAt(LATER),
      installedAt: LATER,
      replacing: previous,
    })

    expect(built.previous).toEqual({
      receiptId: previous.receiptId,
      version: "1.0.0",
      installRoot: previous.installRoot,
      entrypoint: previous.entrypoint,
      treeDigest: previous.treeDigest,
      activatedAt: AT,
    })
  })

  it("refuses to retain an unhealthy predecessor", () => {
    // Offering a rollback to something already known not to work is worse than
    // offering no rollback at all.
    const built = buildReceipt({
      runtimeId: "deepseek-harness",
      version: "2.0.0",
      provider: "npm",
      providerVersion: "10.9.0",
      source: "s",
      installRoot: "/managed/current",
      entrypoint: "/e",
      treeDigest: "b".repeat(64),
      health: healthyAt(LATER),
      installedAt: LATER,
      replacing: receipt({ health: unhealthyAt(AT, "entrypoint-failed", "exited 1") }),
    })
    expect(built.previous).toBeUndefined()
  })

  it("keeps only one slot deep, never a chain", () => {
    const first = receipt()
    const second = buildReceipt({
      runtimeId: "deepseek-harness",
      version: "2.0.0",
      provider: "npm",
      providerVersion: "10.9.0",
      source: "s",
      installRoot: "/managed/current",
      entrypoint: "/e",
      treeDigest: "b".repeat(64),
      health: healthyAt(LATER),
      installedAt: LATER,
      replacing: first,
    })
    const third = buildReceipt({
      runtimeId: "deepseek-harness",
      version: "3.0.0",
      provider: "npm",
      providerVersion: "10.9.0",
      source: "s",
      installRoot: "/managed/current",
      entrypoint: "/e",
      treeDigest: "d".repeat(64),
      health: healthyAt(LATER),
      installedAt: LATER,
      replacing: second,
    })

    expect(third.previous?.version).toBe("2.0.0")
    // An unbounded chain is the directory nobody ever prunes.
    expect((third.previous as unknown as { previous?: unknown }).previous).toBeUndefined()
  })
})

describe("rollbackSlotFrom", () => {
  it("returns nothing for a missing or unhealthy receipt", () => {
    expect(rollbackSlotFrom(null)).toBeUndefined()
    expect(rollbackSlotFrom(undefined)).toBeUndefined()
    expect(rollbackSlotFrom(receipt({ health: unhealthyAt(AT, "x", "y") }))).toBeUndefined()
  })
})

describe("canRollback", () => {
  it("is true only when a slot is retained", () => {
    expect(canRollback(receipt())).toBe(false)
    expect(canRollback(receipt({ previous: rollbackSlotFrom(receipt()) }))).toBe(true)
    expect(canRollback(null)).toBe(false)
  })
})

describe("receiptFromRollback", () => {
  it("restores the predecessor's paths and version", () => {
    const previous = receipt({ version: "1.0.0" })
    const current = buildReceipt({
      runtimeId: "deepseek-harness",
      version: "2.0.0",
      provider: "npm",
      providerVersion: "10.9.0",
      source: "s",
      installRoot: "/managed/current",
      entrypoint: "/managed/current/bin/agent",
      treeDigest: "b".repeat(64),
      health: healthyAt(LATER),
      installedAt: LATER,
      replacing: previous,
    })

    const restored = receiptFromRollback(current, LATER)

    expect(restored.version).toBe("1.0.0")
    expect(restored.entrypoint).toBe(previous.entrypoint)
    expect(restored.treeDigest).toBe(previous.treeDigest)
    expect(restored.activatedAt).toBe(LATER)
    expect(restored.health.healthy).toBe(true)
  })

  it("leaves the restored receipt with no slot of its own", () => {
    const current = buildReceipt({
      runtimeId: "r",
      version: "2.0.0",
      provider: "npm",
      providerVersion: "1",
      source: "s",
      installRoot: "/c",
      entrypoint: "/e",
      treeDigest: "b".repeat(64),
      health: healthyAt(LATER),
      installedAt: LATER,
      replacing: receipt(),
    })

    // Rolling back to the thing you just undid would walk the user in a circle.
    expect(receiptFromRollback(current, LATER).previous).toBeUndefined()
  })

  it("refuses when nothing was retained", () => {
    expect(() => receiptFromRollback(receipt(), LATER)).toThrow(ExternalAgentLifecycleError)
    try {
      receiptFromRollback(receipt(), LATER)
    } catch (error) {
      expect((error as ExternalAgentLifecycleError).code).toBe("runtime_missing")
    }
  })
})

describe("receiptMatchesTree", () => {
  it("detects drift in a root Cognia owns", () => {
    expect(receiptMatchesTree(receipt(), "a".repeat(64))).toBe(true)
    expect(receiptMatchesTree(receipt(), "z".repeat(64))).toBe(false)
  })
})
