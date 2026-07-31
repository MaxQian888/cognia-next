import { groupChildIds, groupEntryChildIds, isGroupContainer } from "./group-utils"

const nodes = [
  { id: "g1", data: { kind: "annotation.group" } },
  { id: "a", parentId: "g1", data: { kind: "ai.prompt" } },
  { id: "b", parentId: "g1", data: { kind: "ai.prompt" } },
  { id: "c", parentId: "g1", data: { kind: "ai.prompt" } },
  { id: "outside", data: { kind: "ai.prompt" } },
]

describe("group-utils", () => {
  it("groupChildIds returns direct members only", () => {
    expect(groupChildIds(nodes, "g1").sort()).toEqual(["a", "b", "c"])
    expect(groupChildIds(nodes, "missing")).toEqual([])
  })

  it("isGroupContainer detects annotation.group", () => {
    expect(isGroupContainer(nodes[0])).toBe(true)
    expect(isGroupContainer(nodes[1])).toBe(false)
    expect(isGroupContainer(undefined)).toBe(false)
  })

  it("groupEntryChildIds returns members with no in-group inbound edge", () => {
    // a → b → c inside the group; an external edge into a is ignored.
    const edges = [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
      { source: "outside", target: "a" },
    ]
    expect(groupEntryChildIds(nodes, edges, "g1")).toEqual(["a"])
  })

  it("falls back to all children when there are no internal edges", () => {
    expect(groupEntryChildIds(nodes, [], "g1").sort()).toEqual(["a", "b", "c"])
  })

  it("returns [] for an empty / unknown group", () => {
    expect(groupEntryChildIds(nodes, [], "missing")).toEqual([])
  })
})
