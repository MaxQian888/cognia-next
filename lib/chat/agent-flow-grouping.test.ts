import {
  groupAgentParts,
  isGroupableToolType,
  isToolPartType,
  MIN_GROUP_SIZE,
} from "./agent-flow-grouping"

type P = { type?: string; id?: string }

describe("isToolPartType / isGroupableToolType", () => {
  it("recognizes tool- prefixed types", () => {
    expect(isToolPartType("tool-Read")).toBe(true)
    expect(isToolPartType("text")).toBe(false)
    expect(isToolPartType(undefined)).toBe(false)
  })

  it("excludes TodoWrite from grouping", () => {
    expect(isGroupableToolType("tool-Read")).toBe(true)
    expect(isGroupableToolType("tool-TodoWrite")).toBe(false)
    expect(isGroupableToolType("tool-mcp__cognia-tools__TodoWrite")).toBe(false)
    expect(isGroupableToolType("text")).toBe(false)
  })
})

describe("groupAgentParts", () => {
  it("keeps a lone tool call as a single", () => {
    const parts: P[] = [{ type: "tool-Read" }]
    const segs = groupAgentParts(parts)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({ kind: "single" })
  })

  it("groups a run of >= MIN_GROUP_SIZE consecutive tool calls", () => {
    const parts: P[] = [{ type: "tool-Read" }, { type: "tool-Grep" }, { type: "tool-Bash" }]
    const segs = groupAgentParts(parts)
    expect(MIN_GROUP_SIZE).toBe(2)
    expect(segs).toHaveLength(1)
    expect(segs[0].kind).toBe("group")
    if (segs[0].kind === "group") {
      expect(segs[0].entries.map((e) => e.index)).toEqual([0, 1, 2])
    }
  })

  it("breaks a run on a non-tool part", () => {
    const parts: P[] = [
      { type: "tool-Read" },
      { type: "tool-Grep" },
      { type: "text" },
      { type: "tool-Bash" },
    ]
    const segs = groupAgentParts(parts)
    // [group(Read,Grep), single(text), single(Bash)]
    expect(segs.map((s) => s.kind)).toEqual(["group", "single", "single"])
  })

  it("treats subagent parts as transparent (neither joins nor breaks runs)", () => {
    const parts: P[] = [{ type: "tool-Read" }, { type: "subagent" }, { type: "tool-Grep" }]
    const segs = groupAgentParts(parts)
    expect(segs).toHaveLength(1)
    expect(segs[0].kind).toBe("group")
    if (segs[0].kind === "group") {
      expect(segs[0].entries.map((e) => e.index)).toEqual([0, 2])
    }
  })

  it("does not group TodoWrite", () => {
    const parts: P[] = [{ type: "tool-TodoWrite" }, { type: "tool-Read" }]
    const segs = groupAgentParts(parts)
    expect(segs.map((s) => s.kind)).toEqual(["single", "single"])
  })

  it("preserves original indices on singles", () => {
    const parts: P[] = [{ type: "text" }, { type: "tool-Read" }]
    const segs = groupAgentParts(parts)
    expect(segs).toHaveLength(2)
    if (segs[1].kind === "single") expect(segs[1].entry.index).toBe(1)
  })

  it("returns an empty array for no parts", () => {
    expect(groupAgentParts([])).toEqual([])
  })
})
