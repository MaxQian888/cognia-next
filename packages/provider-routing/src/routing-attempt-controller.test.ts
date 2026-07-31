import type { RoutingPlan } from "@cognia/provider-types/auto-router"
import { RoutingAttemptController } from "./routing-attempt-controller"

function plan(): RoutingPlan {
  const orderedCandidates = ["one", "two", "three"].map((modelId) => ({
    providerId: "provider",
    modelId,
    deploymentId: `provider::${modelId}`,
    reasonCodes: [],
  }))
  return {
    decisionId: "decision",
    surface: "workflow",
    requested: { kind: "alias", alias: "test" },
    strategy: "reliability",
    selected: orderedCandidates[0],
    orderedCandidates,
    reasonCodes: [],
    rejected: [],
    replayPolicy: "pre-commit-only",
    createdAt: 1,
  }
}

describe("RoutingAttemptController", () => {
  it("advances through the ordered plan before commitment", () => {
    const controller = new RoutingAttemptController(plan(), 2, () => 10)

    expect(controller.begin()?.modelId).toBe("one")
    expect(controller.failAndAdvance()?.modelId).toBe("two")
    expect(controller.failAndAdvance()?.modelId).toBe("three")
    expect(controller.failAndAdvance()).toBeNull()
  })

  it("never advances after visible output or a tool dispatch commits the attempt", () => {
    const controller = new RoutingAttemptController(plan(), 2, () => 10)
    controller.begin()
    controller.commit()

    expect(controller.state.phase).toBe("committed")
    expect(controller.failAndAdvance()).toBeNull()
    expect(controller.state.phase).toBe("failed")
  })

  it("rehydrates an in-flight chat attempt and advances through the same state machine", () => {
    const controller = new RoutingAttemptController(plan(), 2, () => 10, {
      phase: "inFlight",
      candidateIndex: 0,
    })
    expect(controller.failAndAdvance()?.modelId).toBe("two")
    expect(controller.state.candidateIndex).toBe(1)
  })

  it("rehydrates a committed attempt without allowing replay", () => {
    const controller = new RoutingAttemptController(plan(), 2, () => 10, {
      phase: "committed",
      candidateIndex: 0,
      committedAt: 5,
    })
    expect(controller.failAndAdvance()).toBeNull()
  })

  it("caps the total attempts at primary plus max fallback attempts", () => {
    const controller = new RoutingAttemptController(plan(), 1, () => 10)
    controller.begin()

    expect(controller.failAndAdvance()?.modelId).toBe("two")
    expect(controller.failAndAdvance()).toBeNull()
  })

  it("marks successful and cancelled attempts terminal", () => {
    const completed = new RoutingAttemptController(plan(), 2)
    completed.begin()
    completed.complete()
    expect(completed.state.phase).toBe("completed")

    const cancelled = new RoutingAttemptController(plan(), 2)
    cancelled.begin()
    cancelled.cancel()
    expect(cancelled.state.phase).toBe("cancelled")
    expect(cancelled.failAndAdvance()).toBeNull()
    expect(cancelled.state.phase).toBe("failed")
  })

  it("handles an empty plan and ignores commit before an attempt starts", () => {
    const emptyPlan = plan()
    emptyPlan.orderedCandidates = []
    const controller = new RoutingAttemptController(emptyPlan, 2)

    controller.commit()
    expect(controller.state.phase).toBe("planned")
    expect(controller.begin()).toBeNull()
    expect(controller.current()).toBeNull()
    expect(controller.state.phase).toBe("failed")
  })
})
