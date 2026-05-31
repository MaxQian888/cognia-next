import { buildDependencyGraph, hasDependencyLinks } from "./dependency-graph"
import type { ScheduledTask } from "@/types/scheduler"

function task(id: string, dependsOn?: string[]): ScheduledTask {
  return {
    id,
    name: id.toUpperCase(),
    type: "chat",
    status: "active",
    trigger: { type: "cron", cronExpression: "0 9 * * *", dependsOn },
    config: {
      timeout: 1,
      maxRetries: 0,
      retryDelay: 0,
      runMissedOnStartup: false,
      allowConcurrent: false,
    },
    notification: { onStart: false, onComplete: false, onError: false },
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }
}

describe("buildDependencyGraph (full)", () => {
  it("lays out a simple chain A→B→D and A→...→E by longest path", () => {
    // A -> B -> D, B -> E, C -> E
    const tasks = [task("a"), task("b", ["a"]), task("d", ["b"]), task("e", ["b", "c"]), task("c")]
    const g = buildDependencyGraph(tasks)
    const level = (id: string) => g.nodes.find((n) => n.id === id)!.level
    expect(level("a")).toBe(0)
    expect(level("b")).toBe(1)
    expect(level("d")).toBe(2)
    expect(level("e")).toBe(2) // max(b+1, c+1) = max(2,1)
    expect(level("c")).toBe(0)
    expect(g.levelCount).toBe(3)
    expect(g.hasCycle).toBe(false)
    expect(g.edges).toHaveLength(4)
  })

  it("excludes tasks with no dependency links from the full graph", () => {
    const tasks = [task("a"), task("b", ["a"]), task("isolated")]
    const g = buildDependencyGraph(tasks)
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["a", "b"])
  })

  it("ignores dangling and self-referencing dependencies", () => {
    const tasks = [task("a", ["ghost"]), task("b", ["b"])]
    const g = buildDependencyGraph(tasks)
    // No valid edges → no nodes in a full graph.
    expect(g.nodes).toHaveLength(0)
    expect(g.edges).toHaveLength(0)
  })

  it("detects a cycle and flags its nodes and edges", () => {
    // a -> b -> c -> a (cycle)
    const tasks = [task("a", ["c"]), task("b", ["a"]), task("c", ["b"])]
    const g = buildDependencyGraph(tasks)
    expect(g.hasCycle).toBe(true)
    expect(g.cycleNodeIds.sort()).toEqual(["a", "b", "c"])
    expect(g.edges.every((e) => e.inCycle)).toBe(true)
    g.nodes.forEach((n) => expect(n.inCycle).toBe(true))
  })
})

describe("buildDependencyGraph (focus neighborhood)", () => {
  it("restricts to the focus task plus direct upstream and downstream", () => {
    // up -> focus -> down; far -> up (2 hops, excluded)
    const tasks = [
      task("up", ["far"]),
      task("focus", ["up"]),
      task("down", ["focus"]),
      task("far"),
      task("unrelated"),
    ]
    const g = buildDependencyGraph(tasks, { focusTaskId: "focus" })
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["down", "focus", "up"])
    // "far" (2-hop upstream) and "unrelated" excluded.
    expect(g.edges).toHaveLength(2)
  })

  it("returns just the focus node when it has no links", () => {
    const tasks = [task("solo"), task("other", ["x"])]
    const g = buildDependencyGraph(tasks, { focusTaskId: "solo" })
    expect(g.nodes.map((n) => n.id)).toEqual(["solo"])
    expect(g.edges).toHaveLength(0)
  })

  it("falls back to the full graph when focusTaskId is unknown", () => {
    const tasks = [task("a"), task("b", ["a"])]
    const g = buildDependencyGraph(tasks, { focusTaskId: "nope" })
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["a", "b"])
  })
})

describe("hasDependencyLinks", () => {
  const a = task("a")
  const b = task("b", ["a"])
  const solo = task("solo")
  const all = [a, b, solo]

  it("is true for a task that depends on another", () => {
    expect(hasDependencyLinks(b, all)).toBe(true)
  })

  it("is true for a task that others depend on", () => {
    expect(hasDependencyLinks(a, all)).toBe(true)
  })

  it("is false for an isolated task", () => {
    expect(hasDependencyLinks(solo, all)).toBe(false)
  })

  it("ignores dangling references", () => {
    const danglingOnly = task("x", ["ghost"])
    expect(hasDependencyLinks(danglingOnly, [danglingOnly])).toBe(false)
  })
})
