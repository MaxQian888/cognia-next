import type { Character } from "@cognia/agent-config-types"
import type { AgentSummary } from "./agent-activity"
import { sortAgents } from "./agent-list"

const agent = (id: string, name: string, updatedAt: number): Character => ({
  id,
  name,
  systemPrompt: "x",
  avatarColor: "#000",
  createdAt: 0,
  updatedAt,
})

const summary = (lastActiveAt?: number): AgentSummary => ({
  status: "idle",
  lastActiveAt,
  turns: 0,
  conversations: 0,
})

const agents = [agent("a", "beta", 10), agent("b", "Alpha", 30), agent("c", "gamma", 20)]

describe("sortAgents", () => {
  it("orders by name, case-insensitively", () => {
    expect(sortAgents(agents, "name", new Map()).map((a) => a.id)).toEqual(["b", "a", "c"])
  })

  it("orders by last edit", () => {
    expect(sortAgents(agents, "updated", new Map()).map((a) => a.id)).toEqual(["b", "c", "a"])
  })

  it("puts recently used agents first, then the rest by last edit", () => {
    const summaries = new Map([
      ["a", summary(500)],
      ["c", summary(900)],
      ["b", summary(undefined)],
    ])
    expect(sortAgents(agents, "recent", summaries).map((a) => a.id)).toEqual(["c", "a", "b"])
  })

  it("does not reorder the caller's array", () => {
    const input = [...agents]
    sortAgents(input, "name", new Map())
    expect(input.map((a) => a.id)).toEqual(["a", "b", "c"])
  })
})
