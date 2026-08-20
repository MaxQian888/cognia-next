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

describe("attended headless origins", () => {
  it("keeps every existing caller on today's policy by default", () => {
    // The option defaults to false precisely so adding `delegate` cannot
    // change the behaviour of a caller that never opted in.
    for (const origin of [
      "scheduler",
      "remote",
      "external",
      "plugin",
      "im",
      "delegation",
    ] as const) {
      expect(resolveGatePolicy(origin)).toEqual(resolveGatePolicy(origin, {}))
      expect(resolveGatePolicy(origin).planApproval).toBe("fail-fast")
    }
  })

  it("delegates plan approval when the caller proves it can reach a human", () => {
    const policy = resolveGatePolicy("im", { approvalChannel: true })
    expect(policy.planApproval).toBe("delegate")
  })

  it("leaves the gates that block indefinitely by design on fail-fast", () => {
    // Handing deadlock or budget to a card would park a run on a question no
    // answer can unblock.
    const policy = resolveGatePolicy("im", { approvalChannel: true })
    expect(policy.deadlock).toBe("fail-fast")
    expect(policy.budget).toBe("fail-fast")
    expect(policy.capabilityAudit).toBe("auto-approve")
    expect(policy.teammateFix).toBe("auto-reject")
    expect(policy.replan).toBe("auto-reject")
  })

  it("never attends an interactive origin — it already blocks on a real modal", () => {
    expect(resolveGatePolicy("interactive", { approvalChannel: true }).planApproval).toBe("block")
    expect(resolveGatePolicy(undefined, { approvalChannel: true }).planApproval).toBe("block")
  })
})

describe("applyGateBehavior — delegate", () => {
  it("asks through the supplied channel and returns its decision", async () => {
    const wait = jest.fn()
    const delegate = jest.fn(async () => ({ outcome: "reject" as const, feedback: "not yet" }))
    await expect(applyGateBehavior("delegate", wait, { delegate })).resolves.toEqual({
      outcome: "reject",
      feedback: "not yet",
    })
    expect(wait).not.toHaveBeenCalled()
  })

  it("fails closed when the caller declared a channel it cannot service", async () => {
    // Not "proceed", and not a hang either — both are worse than the loud
    // failure this replaced.
    const result = await applyGateBehavior("delegate", jest.fn())
    expect(result.outcome).toBe("reject")
  })

  it("fails closed when the channel throws", async () => {
    const delegate = jest.fn(async () => {
      throw new Error("card delivery failed")
    })
    const result = await applyGateBehavior("delegate", jest.fn(), { delegate })
    expect(result.outcome).toBe("reject")
  })
})
