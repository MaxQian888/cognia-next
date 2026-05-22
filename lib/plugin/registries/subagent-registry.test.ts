import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"
import {
  __resetSubagentsForTesting,
  getSubagent,
  getSubagentEntry,
  listSubagentEntries,
  listSubagentIds,
  registerSubagent,
  unregisterSubagentById,
  unregisterSubagentsByPlugin,
} from "./subagent-registry"

function makeSubagent(id: string, overrides: Partial<PluginSubagentDef> = {}): PluginSubagentDef {
  return {
    id,
    name: `Subagent ${id}`,
    description: `Test subagent ${id}`,
    prompt: `You are subagent ${id}.`,
    ...overrides,
  }
}

describe("subagent-registry", () => {
  beforeEach(() => {
    __resetSubagentsForTesting()
  })

  it("registers a subagent and retrieves it via get / getEntry / list", () => {
    const sa = makeSubagent("code-reviewer")
    const previous = registerSubagent("code-reviewer", sa, { pluginId: "p1" })
    expect(previous).toBeUndefined()

    expect(getSubagent("code-reviewer")).toBe(sa)
    expect(getSubagentEntry("code-reviewer")).toEqual({ entry: sa, pluginId: "p1" })
    expect(listSubagentIds()).toEqual(["code-reviewer"])
    expect(listSubagentEntries()).toEqual([{ id: "code-reviewer", entry: sa, pluginId: "p1" }])
  })

  it("unregisterByPlugin drops every subagent from the given pluginId", () => {
    registerSubagent("a", makeSubagent("a"), { pluginId: "plug" })
    registerSubagent("b", makeSubagent("b"), { pluginId: "plug" })

    const removed = unregisterSubagentsByPlugin("plug")
    expect(removed).toBe(2)
    expect(getSubagent("a")).toBeUndefined()
    expect(getSubagent("b")).toBeUndefined()
    expect(listSubagentIds()).toEqual([])
  })

  it("unregisterByPlugin leaves entries from other plugins alone", () => {
    const a = makeSubagent("a")
    const b = makeSubagent("b")
    registerSubagent("a", a, { pluginId: "pluginA" })
    registerSubagent("b", b, { pluginId: "pluginB" })

    expect(unregisterSubagentsByPlugin("pluginA")).toBe(1)
    expect(getSubagent("a")).toBeUndefined()
    expect(getSubagent("b")).toBe(b)
  })

  it("unregisterById removes only the matching entry", () => {
    registerSubagent("a", makeSubagent("a"))
    registerSubagent("b", makeSubagent("b"))

    expect(unregisterSubagentById("a")).toBe(true)
    expect(getSubagent("a")).toBeUndefined()
    expect(getSubagent("b")).toBeDefined()
    expect(unregisterSubagentById("a")).toBe(false)
  })

  it("preserves optional tools/disallowedTools/model/maxTurns/effort", () => {
    const full = makeSubagent("full", {
      tools: ["Read", "Grep"],
      disallowedTools: ["Bash"],
      model: "opus",
      maxTurns: 10,
      effort: "max",
    })
    registerSubagent("full", full)
    const out = getSubagent("full")
    expect(out).toMatchObject({
      tools: ["Read", "Grep"],
      disallowedTools: ["Bash"],
      model: "opus",
      maxTurns: 10,
      effort: "max",
    })
  })

  it("__resetSubagentsForTesting clears everything", () => {
    registerSubagent("a", makeSubagent("a"), { pluginId: "p1" })
    registerSubagent("b", makeSubagent("b"))
    __resetSubagentsForTesting()
    expect(listSubagentIds()).toEqual([])
    expect(listSubagentEntries()).toEqual([])
  })
})
