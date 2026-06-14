import { decomposeTasks, heuristicTasks, MAX_TASKS } from "./decompose-tasks"
import type { ProposedTeammate } from "./types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { TeamRoutingAssessment } from "@/types/agent/agent-team"

const assessment: TeamRoutingAssessment = {
  recommendedPattern: "manager_worker",
  confidence: 0.7,
  reason: "x",
  factors: {
    taskComplexity: "moderate",
    specializationNeeded: true,
    contextIsolationNeeded: false,
    delegationCandidate: false,
    budgetPressure: "low",
  },
  createdAt: new Date("2026-06-14T00:00:00Z"),
}

const roster: ProposedTeammate[] = [
  { name: "Lead", role: "lead", description: "lead" },
  { name: "A", role: "teammate", description: "a", specialization: "frontend" },
  { name: "B", role: "teammate", description: "b", specialization: "backend" },
]

const client = (text: string): LlmClient => ({ complete: async () => text })
const base = { assessment, roster, objective: "build a feature" }

describe("decomposeTasks (model path)", () => {
  it("normalizes valid tasks with backward dependencies", async () => {
    const tasks = await decomposeTasks({
      ...base,
      client: client(
        JSON.stringify({
          tasks: [
            { title: "Design", description: "d", assignedTo: 1, dependencies: [] },
            {
              title: "Build",
              description: "b",
              assignedTo: 2,
              dependencies: [0],
              expectedOutput: "code",
            },
          ],
        })
      ),
    })
    expect(tasks).toHaveLength(2)
    expect(tasks[1].dependencies).toEqual([0])
    expect(tasks[1].assignedTo).toBe(2)
    expect(tasks[1].expectedOutput).toBe("code")
  })

  it("drops forward / self dependency edges (keeps the DAG acyclic)", async () => {
    const tasks = await decomposeTasks({
      ...base,
      client: client(
        JSON.stringify({
          tasks: [
            { title: "T0", description: "d", assignedTo: 0, dependencies: [1, 0] }, // forward+self → dropped
            { title: "T1", description: "d", assignedTo: 1, dependencies: [0, 5, 1] }, // 5 oob, 1 self → only [0]
          ],
        })
      ),
    })
    expect(tasks[0].dependencies).toEqual([])
    expect(tasks[1].dependencies).toEqual([0])
  })

  it("clamps out-of-range assignedTo to the lead (0)", async () => {
    const tasks = await decomposeTasks({
      ...base,
      client: client(JSON.stringify({ tasks: [{ title: "T", description: "d", assignedTo: 99 }] })),
    })
    expect(tasks[0].assignedTo).toBe(0)
  })

  it("dedupes dependency indices", async () => {
    const tasks = await decomposeTasks({
      ...base,
      client: client(
        JSON.stringify({
          tasks: [
            { title: "A", description: "d", assignedTo: 1 },
            { title: "B", description: "d", assignedTo: 2, dependencies: [0, 0] },
          ],
        })
      ),
    })
    expect(tasks[1].dependencies).toEqual([0])
  })

  it("caps tasks at MAX_TASKS", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      title: `T${i}`,
      description: "d",
      assignedTo: 1,
    }))
    const tasks = await decomposeTasks({ ...base, client: client(JSON.stringify({ tasks: many })) })
    expect(tasks).toHaveLength(MAX_TASKS)
  })

  it("skips tasks with no title", async () => {
    const tasks = await decomposeTasks({
      ...base,
      client: client(
        JSON.stringify({
          tasks: [{ description: "no title" }, { title: "Real", description: "d" }],
        })
      ),
    })
    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toBe("Real")
  })
})

describe("decomposeTasks (fail-open)", () => {
  it("returns the heuristic chain when the model throws", async () => {
    const tasks = await decomposeTasks({
      ...base,
      client: {
        complete: async () => {
          throw new Error("boom")
        },
      },
    })
    expect(tasks).toHaveLength(2) // two non-lead members → two-task chain
    expect(tasks[1].dependencies).toEqual([0])
  })

  it("returns the heuristic chain on non-JSON", async () => {
    const tasks = await decomposeTasks({ ...base, client: client("nope") })
    expect(tasks.length).toBeGreaterThanOrEqual(1)
  })

  it("returns the heuristic chain on empty tasks array", async () => {
    const tasks = await decomposeTasks({ ...base, client: client('{"tasks":[]}') })
    expect(tasks).toHaveLength(2)
  })

  it("short-circuits to heuristic when already aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    const spy = jest.fn()
    const tasks = await decomposeTasks({ ...base, client: { complete: spy }, signal: ac.signal })
    expect(spy).not.toHaveBeenCalled()
    expect(tasks.length).toBeGreaterThanOrEqual(1)
  })

  it("falls back to heuristic when aborted mid-call", async () => {
    const ac = new AbortController()
    const tasks = await decomposeTasks({
      ...base,
      signal: ac.signal,
      client: {
        complete: async () => {
          ac.abort()
          return JSON.stringify({ tasks: [{ title: "T", description: "d", assignedTo: 0 }] })
        },
      },
    })
    expect(tasks).toHaveLength(2) // heuristic chain for the 2-worker roster
  })

  it("treats a non-integer assignedTo and non-array dependencies as defaults", async () => {
    const tasks = await decomposeTasks({
      ...base,
      client: client(
        JSON.stringify({
          tasks: [{ title: "T", description: "d", assignedTo: "two", dependencies: "nope" }],
        })
      ),
    })
    expect(tasks[0].assignedTo).toBe(0)
    expect(tasks[0].dependencies).toEqual([])
  })
})

describe("heuristicTasks", () => {
  it("makes one task per non-lead member, assigned to workers", () => {
    const tasks = heuristicTasks("obj", roster)
    expect(tasks).toHaveLength(2)
    expect(tasks.map((t) => t.assignedTo)).toEqual([1, 2])
  })

  it("falls back to a single lead-assigned task for a lead-only roster", () => {
    const tasks = heuristicTasks("solo objective", [{ name: "L", role: "lead", description: "l" }])
    expect(tasks).toHaveLength(1)
    expect(tasks[0].assignedTo).toBe(0)
    expect(tasks[0].dependencies).toEqual([])
  })
})
