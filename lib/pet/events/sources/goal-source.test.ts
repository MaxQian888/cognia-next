import { goalEventToEmit, wireGoalSource, type RowObserver } from "./goal-source"
import type { ExitReason, GoalEvent, GoalEventKind, GoalEventPayload } from "@/types/goal"
import type { PetEvent } from "@/types/pet"

function ev(id: string, kind: GoalEventKind, payload?: GoalEventPayload): GoalEvent {
  return { id, goalId: "g1", kind, ts: 1, payload: payload ?? ({ kind } as GoalEventPayload) }
}

function exitPayload(exit: ExitReason): GoalEventPayload {
  return { kind: "exit_triggered", exit, reason: "test" }
}

function exitEv(id: string, exit: ExitReason): GoalEvent {
  return ev(id, "exit_triggered", exitPayload(exit))
}

// Whether each exit pays "goalComplete": only judge_done, the one exit that
// means the objective was met. Typed as a full record so a new ExitReason fails
// typecheck here until someone decides whether it is rewarded.
const REWARDED_EXITS = {
  judge_done: true,
  user_stopped: false,
  preempted: false,
  turn_limited: false,
  budget_limited: false,
  cost_limited: false,
  timed_out: false,
  judge_failed_too_many: false,
  needs_approval: false,
} satisfies Record<ExitReason, boolean>

describe("goalEventToEmit", () => {
  it("rewards a judge_done exit as goalComplete", () => {
    expect(goalEventToEmit(exitPayload("judge_done"))).toEqual({ kind: "goalComplete", xp: 25 })
  })

  it("does not reward a needs_approval exit, which only pauses the goal", () => {
    expect(goalEventToEmit(exitPayload("needs_approval"))).toBeNull()
  })

  it("does not reward a judge_failed_too_many exit, which only pauses the goal", () => {
    expect(goalEventToEmit(exitPayload("judge_failed_too_many"))).toBeNull()
  })

  it("does not reward terminal exits that end the goal without meeting it", () => {
    expect(goalEventToEmit(exitPayload("user_stopped"))).toBeNull()
    expect(goalEventToEmit(exitPayload("preempted"))).toBeNull()
    expect(goalEventToEmit(exitPayload("timed_out"))).toBeNull()
  })

  it.each(Object.entries(REWARDED_EXITS) as [ExitReason, boolean][])(
    "exit %s rewarded as goalComplete: %s",
    (exit, rewarded) => {
      expect(goalEventToEmit(exitPayload(exit))).toEqual(
        rewarded ? { kind: "goalComplete", xp: 25 } : null
      )
    }
  )

  it("maps turn-completed to goalProgress; ignores the rest", () => {
    expect(goalEventToEmit({ kind: "turn_completed", turnNumber: 1, tokensDelta: 10 })).toEqual({
      kind: "goalProgress",
      xp: 5,
    })
    expect(goalEventToEmit({ kind: "user_paused" })).toBeNull()
    expect(goalEventToEmit({ kind: "user_resumed" })).toBeNull()
  })
})

describe("wireGoalSource", () => {
  it("skips the pre-existing newest row, then emits deltas", () => {
    let push: (rows: GoalEvent[]) => void = () => {}
    const observe: RowObserver<GoalEvent> = (onRows) => {
      push = onRows
      return () => {}
    }
    const events: PetEvent[] = []
    wireGoalSource((e) => events.push({ ...e, at: 0 }), observe)

    push([ev("1", "turn_completed")]) // pre-existing → ignored
    push([ev("2", "turn_completed")]) // → goalProgress
    push([ev("2", "turn_completed")]) // same id → ignored
    push([exitEv("3", "judge_done")]) // → goalComplete
    push([ev("4", "goal_created")]) // mapped to null → no emit

    expect(events.map((e) => e.kind)).toEqual(["goalProgress", "goalComplete"])
    expect(events[1]).toMatchObject({ source: "goal", meta: { goalId: "g1" } })
  })

  it("ignores empty result sets", () => {
    let push: (rows: GoalEvent[]) => void = () => {}
    const observe: RowObserver<GoalEvent> = (onRows) => {
      push = onRows
      return () => {}
    }
    const events: PetEvent[] = []
    wireGoalSource((e) => events.push({ ...e, at: 0 }), observe)
    push([])
    expect(events).toHaveLength(0)
  })

  it("takes an empty first result as the baseline, so the first real row emits", () => {
    let push: (rows: GoalEvent[]) => void = () => {}
    const observe: RowObserver<GoalEvent> = (onRows) => {
      push = onRows
      return () => {}
    }
    const events: PetEvent[] = []
    wireGoalSource((e) => events.push({ ...e, at: 0 }), observe)
    push([]) // fresh account, no goal events yet → baseline
    push([ev("1", "turn_completed")]) // the first ever → goalProgress
    expect(events.map((e) => e.kind)).toEqual(["goalProgress"])
  })

  it("rewards a goal once when it pauses for approval, resumes, then completes", () => {
    let push: (rows: GoalEvent[]) => void = () => {}
    const observe: RowObserver<GoalEvent> = (onRows) => {
      push = onRows
      return () => {}
    }
    const events: PetEvent[] = []
    wireGoalSource((e) => events.push({ ...e, at: 0 }), observe)

    push([]) // baseline
    push([ev("1", "turn_completed")]) // → goalProgress
    push([exitEv("2", "needs_approval")]) // paused → nothing
    push([ev("3", "user_resumed")]) // → nothing
    push([ev("4", "turn_completed")]) // → goalProgress
    push([exitEv("5", "judge_failed_too_many")]) // paused again → nothing
    push([ev("6", "user_resumed")]) // → nothing
    push([exitEv("7", "judge_done")]) // → goalComplete, once

    expect(events.map((e) => e.kind)).toEqual(["goalProgress", "goalProgress", "goalComplete"])
    expect(events.filter((e) => e.kind === "goalComplete")).toHaveLength(1)
    expect(events[2]).toMatchObject({ source: "goal", xp: 25, meta: { goalId: "g1" } })
  })

  it("does not celebrate a goal that is stopped or runs out of budget", () => {
    let push: (rows: GoalEvent[]) => void = () => {}
    const observe: RowObserver<GoalEvent> = (onRows) => {
      push = onRows
      return () => {}
    }
    const events: PetEvent[] = []
    wireGoalSource((e) => events.push({ ...e, at: 0 }), observe)

    push([]) // baseline
    push([ev("1", "turn_completed")]) // → goalProgress
    push([exitEv("2", "user_stopped")]) // stopped → nothing
    push([ev("3", "turn_completed")]) // another goal's turn → goalProgress
    push([exitEv("4", "budget_limited")]) // ran out → nothing

    expect(events.map((e) => e.kind)).toEqual(["goalProgress", "goalProgress"])
  })
})
