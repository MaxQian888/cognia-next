import { goalEventToEmit, wireGoalSource, type RowObserver } from "./goal-source"
import type { GoalEvent } from "@/types/goal"
import type { PetEvent } from "@/types/pet"

function ev(id: string, kind: string): GoalEvent {
  return { id, goalId: "g1", kind, ts: 1 } as GoalEvent
}

describe("goalEventToEmit", () => {
  it("maps exit and turn-completed; ignores the rest", () => {
    expect(goalEventToEmit("exit_triggered")).toEqual({ kind: "goalComplete", xp: 25 })
    expect(goalEventToEmit("turn_completed")).toEqual({ kind: "goalProgress", xp: 5 })
    expect(goalEventToEmit("goal_created")).toBeNull()
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
    push([ev("3", "exit_triggered")]) // → goalComplete
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
})
