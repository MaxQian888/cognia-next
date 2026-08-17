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
  pendingApprovalCountForSession,
  subscribePendingApprovals,
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

  it("clamps a non-positive ttl to the default so a card can never hang forever", async () => {
    jest.useFakeTimers()
    try {
      // ttlMs:0 previously disabled the watchdog entirely (timer === null) —
      // the tool would wait for a button press forever. It must fall back to
      // the default TTL and still auto-deny.
      const p = awaitApproval("s1", "r1", { ttlMs: 0 })
      jest.advanceTimersByTime(DEFAULT_APPROVAL_TTL_MS)
      await expect(p).resolves.toEqual({ decision: "deny", message: "approval timed out" })
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

  describe("per-session count + subscription", () => {
    it("counts pending approvals per session", () => {
      void awaitApproval("s1", "r1")
      void awaitApproval("s1", "r2")
      void awaitApproval("s2", "r1")
      expect(pendingApprovalCountForSession("s1")).toBe(2)
      expect(pendingApprovalCountForSession("s2")).toBe(1)
      expect(pendingApprovalCountForSession("s3")).toBe(0)
      resolveApproval("s1", "r1", { decision: "allow" })
      expect(pendingApprovalCountForSession("s1")).toBe(1)
    })

    it("notifies subscribers on register and resolve, and stops after unsubscribe", () => {
      const cb = jest.fn()
      const unsubscribe = subscribePendingApprovals(cb)
      void awaitApproval("s1", "r1")
      expect(cb).toHaveBeenCalledTimes(1)
      resolveApproval("s1", "r1", { decision: "allow" })
      expect(cb).toHaveBeenCalledTimes(2)
      // Unknown request → nothing changed → no notification.
      resolveApproval("s1", "missing", { decision: "deny" })
      expect(cb).toHaveBeenCalledTimes(2)
      unsubscribe()
      void awaitApproval("s1", "r2")
      expect(cb).toHaveBeenCalledTimes(2)
    })

    it("notifies subscribers when the TTL expires an approval", async () => {
      jest.useFakeTimers()
      try {
        const cb = jest.fn()
        subscribePendingApprovals(cb)
        const p = awaitApproval("s1", "r1", { ttlMs: 500 })
        expect(cb).toHaveBeenCalledTimes(1)
        jest.advanceTimersByTime(500)
        await expect(p).resolves.toEqual({ decision: "deny", message: "approval timed out" })
        expect(cb).toHaveBeenCalledTimes(2)
        expect(pendingApprovalCountForSession("s1")).toBe(0)
      } finally {
        jest.useRealTimers()
      }
    })

    it("notifies subscribers when a request is superseded", async () => {
      const cb = jest.fn()
      subscribePendingApprovals(cb)
      const first = awaitApproval("s1", "r1")
      void awaitApproval("s1", "r1")
      await expect(first).resolves.toMatchObject({ decision: "deny" })
      // register + supersede-register — the count stays at 1 either way.
      expect(cb).toHaveBeenCalledTimes(2)
      expect(pendingApprovalCountForSession("s1")).toBe(1)
    })

    it("a throwing listener does not break the approval flow or other listeners", () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      try {
        const bad = jest.fn(() => {
          throw new Error("boom")
        })
        const good = jest.fn()
        subscribePendingApprovals(bad)
        subscribePendingApprovals(good)
        const p = awaitApproval("s1", "r1")
        expect(good).toHaveBeenCalledTimes(1)
        expect(warn).toHaveBeenCalled()
        expect(resolveApproval("s1", "r1", { decision: "allow" })).toBe(true)
        return expect(p).resolves.toEqual({ decision: "allow" })
      } finally {
        warn.mockRestore()
      }
    })
  })
})
