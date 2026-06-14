/**
 * Tests for lib/connectors/hitl/approval-registry.ts.
 */

import {
  awaitApproval,
  resolveApproval,
  hasSessionBypass,
  grantSessionBypass,
  clearSessionBypass,
  pendingApprovalCount,
  __resetApprovalRegistryForTesting,
  DEFAULT_APPROVAL_TTL_MS,
} from "./approval-registry"

beforeEach(() => {
  __resetApprovalRegistryForTesting()
})

describe("approval-registry", () => {
  it("resolveApproval settles the awaited promise with the decision", async () => {
    const p = awaitApproval("s1", "r1", { ttlMs: 0 })
    expect(pendingApprovalCount()).toBe(1)
    const found = resolveApproval("s1", "r1", { decision: "allow" })
    expect(found).toBe(true)
    await expect(p).resolves.toEqual({ decision: "allow" })
    expect(pendingApprovalCount()).toBe(0)
  })

  it("resolveApproval returns false for an unknown request", () => {
    expect(resolveApproval("s1", "missing", { decision: "deny" })).toBe(false)
  })

  it("auto-denies after the TTL elapses", async () => {
    jest.useFakeTimers()
    try {
      const onExpire = jest.fn()
      const p = awaitApproval("s1", "r1", { ttlMs: 1000, onExpire })
      jest.advanceTimersByTime(1000)
      await expect(p).resolves.toEqual({ decision: "deny", message: "approval timed out" })
      expect(onExpire).toHaveBeenCalledTimes(1)
      expect(pendingApprovalCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it("a superseding request denies the prior pending entry", async () => {
    const first = awaitApproval("s1", "r1", { ttlMs: 0 })
    const second = awaitApproval("s1", "r1", { ttlMs: 0 })
    await expect(first).resolves.toEqual({
      decision: "deny",
      message: "superseded by a newer request",
    })
    resolveApproval("s1", "r1", { decision: "allow" })
    await expect(second).resolves.toEqual({ decision: "allow" })
  })

  it("tracks per-session tool bypass", () => {
    expect(hasSessionBypass("s1", "Bash")).toBe(false)
    grantSessionBypass("s1", "Bash")
    expect(hasSessionBypass("s1", "Bash")).toBe(true)
    expect(hasSessionBypass("s1", "Edit")).toBe(false)
    expect(hasSessionBypass("s2", "Bash")).toBe(false)
    clearSessionBypass("s1")
    expect(hasSessionBypass("s1", "Bash")).toBe(false)
  })

  it("exposes a sane default TTL", () => {
    expect(DEFAULT_APPROVAL_TTL_MS).toBeGreaterThan(0)
  })
})
