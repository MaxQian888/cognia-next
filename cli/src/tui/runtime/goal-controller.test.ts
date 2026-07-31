/**
 * @jest-environment node
 */
import {
  formatGoalProgress,
  goalList,
  goalPause,
  goalStart,
  goalStatus,
  goalStop,
} from "./goal-controller"
import { DEFAULT_RESOLVED_CONFIG } from "../../config/schema"
import type { Goal } from "@/types/goal"
import type { TuiAction } from "../state/types"

function recorder() {
  const actions: TuiAction[] = []
  return { dispatch: (a: TuiAction) => actions.push(a), actions }
}

const config = { ...DEFAULT_RESOLVED_CONFIG, provider: "anthropic", model: "claude-x", cwd: "/w" }
const goal = (over: Partial<Goal> = {}): Goal =>
  ({
    id: "g1",
    safeObjective: "ship the release",
    status: "active",
    turnsUsed: 3,
    tokensUsed: 1200,
    config: { maxTurns: 20, maxTokens: 100000 },
    ...over,
  }) as unknown as Goal

function baseDeps(over = {}) {
  return {
    dispatch: () => {},
    sessionId: "s1",
    config,
    signal: new AbortController().signal,
    ensureDb: async () => {},
    ensureSession: async () => {},
    appSettings: null,
    ...over,
  }
}

describe("goalStart", () => {
  it("creates the goal, runs the loop, and reports success", async () => {
    const { dispatch, actions } = recorder()
    let created = ""
    await goalStart("ship it", {
      ...baseDeps(),
      dispatch,
      createGoal: async (input) => {
        created = input.rawObjective
        return goal()
      },
      runLoop: async () => ({ status: "completed", turns: 4 }),
    })
    expect(created).toBe("ship it")
    expect(actions[0]).toMatchObject({ type: "ACTIVITY_START", kind: "goal" })
    const end = actions.at(-1) as { type: string; status: string; summary: string }
    expect(end.status).toBe("done")
    expect(end.summary).toContain("4 turns")
  })

  it("surfaces the judge-unavailable error from the headless runner", async () => {
    const { dispatch, actions } = recorder()
    await goalStart("ship it", {
      ...baseDeps(),
      dispatch,
      createGoal: async () => goal(),
      runLoop: async () => ({ status: "paused", turns: 0, error: "judge unavailable" }),
    })
    const end = actions.at(-1) as { status: string; summary: string }
    expect(end.status).toBe("error")
    expect(end.summary).toContain("judge unavailable")
  })

  it("rejects an empty objective", async () => {
    const { dispatch, actions } = recorder()
    await goalStart("   ", { ...baseDeps(), dispatch })
    expect((actions[0] as { message: string }).message).toContain("Usage")
  })

  it("ends with an error when the loop throws", async () => {
    const { dispatch, actions } = recorder()
    await goalStart("go", {
      ...baseDeps(),
      dispatch,
      createGoal: async () => goal(),
      runLoop: async () => {
        throw new Error("boom")
      },
    })
    expect(actions.at(-1)).toMatchObject({ type: "ACTIVITY_END", status: "error" })
  })
})

describe("formatGoalProgress", () => {
  it("renders status with turn + token budget consumption", () => {
    expect(formatGoalProgress(goal())).toBe("active · 3/20 turns · 1.2k/100k tokens")
  })
  it("appends subgoal completion when the goal is decomposed", () => {
    const decomposed = goal({
      subgoals: [
        { id: "a", text: "x", done: true, order: 0 },
        { id: "b", text: "y", done: false, order: 1 },
      ],
    })
    expect(formatGoalProgress(decomposed)).toContain("subgoals 1/2")
  })
  it("shows tokens under 1000 as a plain integer", () => {
    expect(formatGoalProgress(goal({ tokensUsed: 800 }))).toContain("800/100k tokens")
  })
})

describe("goalStatus", () => {
  it("notices the active goal's status with progress", async () => {
    const { dispatch, actions } = recorder()
    await goalStatus({ ...baseDeps(), dispatch, getActive: async () => goal() })
    const message = (actions[0] as { message: string }).message
    expect(message).toContain("active")
    expect(message).toContain("3/20 turns")
  })
  it("notices when there's no active goal", async () => {
    const { dispatch, actions } = recorder()
    await goalStatus({ ...baseDeps(), dispatch, getActive: async () => undefined })
    expect((actions[0] as { message: string }).message).toContain("No active goal")
  })
  // Regression: `/goal status|list|pause|…` read the db directly, so they must
  // open the CLI-local db (which installs the `window` shim `getDb()` requires)
  // BEFORE the goal-table read — otherwise the first such call after launch
  // throws "getDb() called on the server".
  it("opens the db before reading the active goal", async () => {
    const order: string[] = []
    await goalStatus({
      ...baseDeps(),
      ensureDb: async () => {
        order.push("ensureDb")
      },
      getActive: async () => {
        order.push("getActive")
        return undefined
      },
    })
    expect(order).toEqual(["ensureDb", "getActive"])
  })
})

describe("goalPause / goalStop", () => {
  it("pauses the active goal via the runtime control", async () => {
    const { dispatch, actions } = recorder()
    let paused = ""
    await goalPause({
      ...baseDeps(),
      dispatch,
      getActive: async () => goal(),
      control: {
        pauseGoal: async (id) => {
          paused = id
        },
        resumeGoal: async () => {},
        stopGoal: async () => {},
      },
    })
    expect(paused).toBe("g1")
    expect((actions[0] as { message: string }).message).toContain("paused")
  })

  it("notices when there's nothing to stop", async () => {
    const { dispatch, actions } = recorder()
    await goalStop({ ...baseDeps(), dispatch, getActive: async () => undefined })
    expect((actions[0] as { message: string }).message).toContain("No active goal")
  })
})

describe("goalList", () => {
  it("notices the session's goals", async () => {
    const { dispatch, actions } = recorder()
    await goalList({
      ...baseDeps(),
      dispatch,
      listGoals: async () => [goal({ status: "completed" }), goal({ id: "g2", status: "active" })],
    })
    expect((actions[0] as { message: string }).message).toContain("completed")
  })
  it("notices an empty goal list", async () => {
    const { dispatch, actions } = recorder()
    await goalList({ ...baseDeps(), dispatch, listGoals: async () => [] })
    expect((actions[0] as { message: string }).message).toContain("No goals")
  })
})
