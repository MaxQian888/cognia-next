import { emitPlanEvent, onPlanEvent } from "./plan-event-bus"
import type { PlanEvent } from "@/types/agent/plan"

function event(over: Partial<PlanEvent> = {}): PlanEvent {
  return {
    id: "e1",
    planId: "p1",
    kind: "approved",
    ts: 1000,
    payload: { kind: "approved" },
    ...over,
  } as PlanEvent
}

describe("plan event bus", () => {
  it("delivers to every subscriber and stops on dispose", () => {
    const seen: string[] = []
    const off = onPlanEvent((e) => seen.push(e.kind))
    emitPlanEvent(event())
    off()
    emitPlanEvent(event({ kind: "cancelled" }))
    expect(seen).toEqual(["approved"])
  })

  it("filters by kind and by plan", () => {
    const byKind: string[] = []
    const byPlan: string[] = []
    const offKind = onPlanEvent((e) => byKind.push(e.kind), { kinds: ["step_failed"] })
    const offPlan = onPlanEvent((e) => byPlan.push(e.planId), { planId: "p2" })

    emitPlanEvent(event({ kind: "approved", planId: "p1" }))
    emitPlanEvent(event({ kind: "step_failed", planId: "p2" }))

    expect(byKind).toEqual(["step_failed"])
    expect(byPlan).toEqual(["p2"])
    offKind()
    offPlan()
  })

  it("keeps a throwing handler from taking the write path or its siblings down", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined)
    const seen: string[] = []
    const offBad = onPlanEvent(() => {
      throw new Error("subscriber is broken")
    })
    const offGood = onPlanEvent((e) => seen.push(e.kind))

    expect(() => emitPlanEvent(event())).not.toThrow()
    expect(seen).toEqual(["approved"])
    expect(spy).toHaveBeenCalled()

    offBad()
    offGood()
    spy.mockRestore()
  })
})
