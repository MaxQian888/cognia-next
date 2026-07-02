import {
  applyGateBehavior,
  isHeadlessOrigin,
  resolveGatePolicy,
  type TeamRunOrigin,
} from "./gate-policy"
import type { ApprovalDecision } from "@/lib/runtime/approval-bus"

const HEADLESS: TeamRunOrigin[] = ["scheduler", "remote", "external", "plugin", "im", "delegation"]

describe("isHeadlessOrigin", () => {
  it("treats undefined and interactive as non-headless", () => {
    expect(isHeadlessOrigin(undefined)).toBe(false)
    expect(isHeadlessOrigin("interactive")).toBe(false)
  })

  it.each(HEADLESS)("treats %s as headless", (origin) => {
    expect(isHeadlessOrigin(origin)).toBe(true)
  })
})

describe("resolveGatePolicy", () => {
  it("blocks every gate for interactive (and undefined) origins", () => {
    for (const origin of [undefined, "interactive" as const]) {
      const policy = resolveGatePolicy(origin)
      expect(Object.values(policy).every((behavior) => behavior === "block")).toBe(true)
    }
  })

  it.each(HEADLESS)("resolves the full headless matrix for %s", (origin) => {
    expect(resolveGatePolicy(origin)).toEqual({
      capabilityAudit: "auto-approve",
      planApproval: "fail-fast",
      deadlock: "fail-fast",
      budget: "fail-fast",
      teammateFix: "auto-reject",
      replan: "auto-reject",
    })
  })
})

describe("applyGateBehavior", () => {
  const neverResolves = () => new Promise<ApprovalDecision>(() => {})

  it("auto-approve resolves approve without registering a waiter", async () => {
    const wait = jest.fn(neverResolves)
    const decision = await applyGateBehavior("auto-approve", wait)
    expect(decision).toEqual({ outcome: "approve" })
    expect(wait).not.toHaveBeenCalled()
  })

  it.each(["auto-reject", "fail-fast"] as const)(
    "%s resolves reject with policy feedback, no waiter",
    async (behavior) => {
      const wait = jest.fn(neverResolves)
      const decision = await applyGateBehavior(behavior, wait)
      expect(decision).toEqual({ outcome: "reject", feedback: `headless-policy:${behavior}` })
      expect(wait).not.toHaveBeenCalled()
    }
  )

  it("block awaits the waiter", async () => {
    const decision = await applyGateBehavior("block", async () => ({
      outcome: "approve",
      feedback: "human",
    }))
    expect(decision).toEqual({ outcome: "approve", feedback: "human" })
  })

  it("block with timeoutMs falls back on expiry (default fail-fast)", async () => {
    jest.useFakeTimers()
    try {
      const pending = applyGateBehavior("block", neverResolves, { timeoutMs: 5_000 })
      jest.advanceTimersByTime(5_000)
      await expect(pending).resolves.toEqual({
        outcome: "reject",
        feedback: "headless-policy:fail-fast",
      })
    } finally {
      jest.useRealTimers()
    }
  })

  it("block with timeoutMs honors a custom fallback", async () => {
    jest.useFakeTimers()
    try {
      const pending = applyGateBehavior("block", neverResolves, {
        timeoutMs: 1_000,
        fallback: "auto-approve",
      })
      jest.advanceTimersByTime(1_000)
      await expect(pending).resolves.toEqual({ outcome: "approve" })
    } finally {
      jest.useRealTimers()
    }
  })

  it("block with timeoutMs cleans up the timer when the waiter wins", async () => {
    jest.useFakeTimers()
    try {
      const decision = await applyGateBehavior(
        "block",
        async () => ({ outcome: "approve" }) as ApprovalDecision,
        { timeoutMs: 60_000 }
      )
      expect(decision).toEqual({ outcome: "approve" })
      // No stray timer left behind.
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })
})
