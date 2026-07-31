import type { SubAgent, SubAgentStatus } from "@/types/agent/sub-agent"

import {
  buildRuntimeTree,
  flattenRuntimeTree,
  isRunning,
  isTerminal,
  terminalRunIds,
} from "./runtime-tree"

let clock = 1_000

const run = (
  id: string,
  over: Partial<SubAgent> & { parent?: string; status?: SubAgentStatus } = {}
): SubAgent => {
  const created = new Date((clock += 10))
  return {
    id,
    parentAgentId: "chat",
    name: id,
    description: "",
    task: "",
    initialTask: "",
    threadId: id,
    status: over.status ?? "running",
    config: {},
    messages: [],
    sources: [],
    logs: [],
    progress: 0,
    createdAt: created,
    lastActivityAt: created,
    retryCount: 0,
    order: 0,
    parentSubagentId: over.parent,
    ...over,
  } as SubAgent
}

beforeEach(() => {
  clock = 1_000
})

describe("isTerminal / isRunning", () => {
  it.each<[SubAgentStatus, boolean]>([
    ["completed", true],
    ["failed", true],
    ["cancelled", true],
    ["timeout", true],
    ["rejected", true],
    ["running", false],
    ["pending", false],
    ["queued", false],
    ["waiting", false],
  ])("treats %s as terminal=%s", (status, expected) => {
    expect(isTerminal(status)).toBe(expected)
  })

  it("only counts a started, unfinished run as running", () => {
    expect(isRunning(run("a", { startedAt: new Date() }))).toBe(true)
    expect(isRunning(run("b"))).toBe(false)
    expect(isRunning(run("c", { startedAt: new Date(), completedAt: new Date() }))).toBe(false)
    expect(isRunning(run("d", { status: "completed", startedAt: new Date() }))).toBe(false)
  })
})

describe("buildRuntimeTree", () => {
  it("nests children under their parent", () => {
    const tree = buildRuntimeTree([run("root"), run("child", { parent: "root" })])
    expect(tree).toHaveLength(1)
    expect(tree[0].run.id).toBe("root")
    expect(tree[0].children.map((c) => c.run.id)).toEqual(["child"])
    expect(tree[0].children[0].depth).toBe(1)
  })

  it("builds grandchildren at increasing depth", () => {
    const tree = buildRuntimeTree([run("a"), run("b", { parent: "a" }), run("c", { parent: "b" })])
    expect(flattenRuntimeTree(tree).map((n) => [n.run.id, n.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ])
  })

  it("surfaces an orphan at the root rather than dropping it", () => {
    // The registry is ephemeral — a parent may already have been cleared.
    const tree = buildRuntimeTree([run("orphan", { parent: "long-gone" })])
    expect(tree.map((n) => n.run.id)).toEqual(["orphan"])
  })

  it("orders roots by most recent activity", () => {
    const older = run("older", { lastActivityAt: new Date(1) })
    const newer = run("newer", { lastActivityAt: new Date(9_999) })
    expect(buildRuntimeTree([older, newer]).map((n) => n.run.id)).toEqual(["newer", "older"])
  })

  it("orders siblings by creation so the dispatch order reads top-down", () => {
    const parent = run("p")
    const first = run("first", { parent: "p" })
    const second = run("second", { parent: "p" })
    const tree = buildRuntimeTree([parent, second, first])
    expect(tree[0].children.map((c) => c.run.id)).toEqual(["first", "second"])
  })

  it("terminates on a parent cycle instead of recursing forever", () => {
    const a = run("a", { parent: "b" })
    const b = run("b", { parent: "a" })
    const flat = flattenRuntimeTree(buildRuntimeTree([a, b]))
    expect(flat.map((n) => n.run.id).sort()).toEqual(["a", "b"])
  })

  it("ignores a run that claims itself as its own parent", () => {
    const tree = buildRuntimeTree([run("self", { parent: "self" })])
    expect(tree).toHaveLength(1)
    expect(tree[0].children).toEqual([])
  })

  it("returns an empty forest for no runs", () => {
    expect(buildRuntimeTree([])).toEqual([])
  })
})

describe("terminalRunIds", () => {
  it("names only the settled runs", () => {
    const ids = terminalRunIds([
      run("done", { status: "completed" }),
      run("live", { status: "running" }),
      run("bad", { status: "failed" }),
    ])
    expect(ids).toEqual(["done", "bad"])
  })
})
