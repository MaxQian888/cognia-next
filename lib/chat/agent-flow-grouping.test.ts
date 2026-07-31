import {
  groupAgentParts,
  isGroupableToolType,
  isToolOnlyFlow,
  isToolPartType,
  isTransparentPart,
  MIN_GROUP_SIZE,
} from "./agent-flow-grouping"

type P = { type?: string; id?: string; text?: string }

describe("isToolPartType / isGroupableToolType", () => {
  it("recognizes tool- prefixed types", () => {
    expect(isToolPartType("tool-Read")).toBe(true)
    expect(isToolPartType("text")).toBe(false)
    expect(isToolPartType(undefined)).toBe(false)
  })

  it("recognizes the AI SDK dynamic-tool shape", () => {
    // Imported transcripts / CLI handoff carry `dynamic-tool` parts; they are
    // tool calls everywhere else in the app, so grouping must agree.
    expect(isToolPartType("dynamic-tool")).toBe(true)
    expect(isGroupableToolType("dynamic-tool")).toBe(true)
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
      { type: "text", text: "Now let me run it." },
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
    const parts: P[] = [{ type: "text", text: "hi" }, { type: "tool-Read" }]
    const segs = groupAgentParts(parts)
    expect(segs).toHaveLength(2)
    if (segs[1].kind === "single") expect(segs[1].entry.index).toBe(1)
  })

  // A model that emits no prose between two tool calls still produces a
  // zero-length text part. It renders nothing, so it must not split the run.
  it.each([
    ["empty", ""],
    ["whitespace-only", "  \n "],
    ["absent", undefined],
  ])("keeps a run intact across a %s text part", (_label, text) => {
    const parts: P[] = [{ type: "tool-Read" }, { type: "text", text }, { type: "tool-Grep" }]
    const segs = groupAgentParts(parts)
    expect(segs).toHaveLength(1)
    expect(segs[0].kind).toBe("group")
    if (segs[0].kind === "group") {
      expect(segs[0].entries.map((e) => e.index)).toEqual([0, 2])
    }
  })

  it("keeps a run intact across step-start / step-finish control parts", () => {
    const parts: P[] = [
      { type: "tool-Read" },
      { type: "step-finish" },
      { type: "step-start" },
      { type: "tool-Grep" },
    ]
    const segs = groupAgentParts(parts)
    expect(segs).toHaveLength(1)
    expect(segs[0].kind).toBe("group")
  })

  it("emits no segment for a part that renders nothing", () => {
    expect(groupAgentParts([{ type: "step-start" }, { type: "text", text: "" }])).toEqual([])
  })

  it("returns an empty array for no parts", () => {
    expect(groupAgentParts([])).toEqual([])
  })
})

describe("groupAgentParts — simplified mode (TUI selective folding)", () => {
  it("folds a context-read burst but leaves an edit standing", () => {
    const parts: P[] = [
      { type: "tool-Read" },
      { type: "tool-Grep" },
      { type: "tool-Edit" },
      { type: "tool-Glob" },
      { type: "tool-Read" },
    ]
    const segs = groupAgentParts(parts, "simplified")
    // [group(Read,Grep), single(Edit), group(Glob,Read)]
    expect(segs.map((s) => s.kind)).toEqual(["group", "single", "group"])
    if (segs[0].kind === "group") expect(segs[0].entries.map((e) => e.index)).toEqual([0, 1])
    if (segs[2].kind === "group") expect(segs[2].entries.map((e) => e.index)).toEqual([3, 4])
  })

  it("keeps a lone context tool as a single (a burst needs ≥2)", () => {
    const segs = groupAgentParts([{ type: "tool-Read" }, { type: "tool-Bash" }], "simplified")
    expect(segs.map((s) => s.kind)).toEqual(["single", "single"])
  })

  it("does not fold consecutive action tools (edit/bash/write)", () => {
    const parts: P[] = [{ type: "tool-Edit" }, { type: "tool-Write" }, { type: "tool-Bash" }]
    const segs = groupAgentParts(parts, "simplified")
    expect(segs.map((s) => s.kind)).toEqual(["single", "single", "single"])
  })

  it("folds web fetches together with reads", () => {
    const parts: P[] = [{ type: "tool-WebFetch" }, { type: "tool-WebSearch" }]
    const segs = groupAgentParts(parts, "simplified")
    expect(segs).toHaveLength(1)
    expect(segs[0].kind).toBe("group")
  })

  it("standard mode still folds actions (mode defaults preserve old behaviour)", () => {
    const parts: P[] = [{ type: "tool-Edit" }, { type: "tool-Bash" }]
    expect(groupAgentParts(parts).map((s) => s.kind)).toEqual(["group"])
    expect(groupAgentParts(parts, "standard").map((s) => s.kind)).toEqual(["group"])
    expect(groupAgentParts(parts, "detailed").map((s) => s.kind)).toEqual(["group"])
  })
})

describe("isTransparentPart", () => {
  it("is transparent for parts that render nothing", () => {
    expect(isTransparentPart({ type: "subagent" })).toBe(true)
    expect(isTransparentPart({ type: "step-start" })).toBe(true)
    expect(isTransparentPart({ type: "step-finish" })).toBe(true)
    expect(isTransparentPart({ type: "text", text: "" })).toBe(true)
    expect(isTransparentPart({ type: "text", text: "   " })).toBe(true)
    expect(isTransparentPart({})).toBe(true)
  })

  it("is opaque for parts that render content", () => {
    expect(isTransparentPart({ type: "text", text: "hi" })).toBe(false)
    expect(isTransparentPart({ type: "tool-Read" })).toBe(false)
    expect(isTransparentPart({ type: "artifact" })).toBe(false)
  })
})

describe("isToolOnlyFlow", () => {
  it("is true for a turn of only tool calls", () => {
    expect(isToolOnlyFlow([{ type: "tool-Read" }, { type: "tool-Grep" }])).toBe(true)
  })

  it("ignores parts that render nothing", () => {
    expect(
      isToolOnlyFlow([{ type: "step-start" }, { type: "tool-Read" }, { type: "text", text: "" }])
    ).toBe(true)
  })

  it("counts a dynamic-tool part as a tool call", () => {
    expect(isToolOnlyFlow([{ type: "dynamic-tool" }, { type: "tool-Grep" }])).toBe(true)
  })

  it("is false once the turn carries prose", () => {
    expect(isToolOnlyFlow([{ type: "tool-Read" }, { type: "text", text: "Done." }])).toBe(false)
  })

  it("is false for non-tool content that is worth acting on", () => {
    expect(isToolOnlyFlow([{ type: "artifact" }])).toBe(false)
    expect(isToolOnlyFlow([{ type: "tool-Read" }, { type: "sources" }])).toBe(false)
  })

  it("is false when there is no tool call at all", () => {
    expect(isToolOnlyFlow([])).toBe(false)
    expect(isToolOnlyFlow([{ type: "step-start" }])).toBe(false)
    expect(isToolOnlyFlow([{ type: "subagent" }])).toBe(false)
  })
})
