import {
  defaultTypeVersionFor,
  hasErrorHandle,
  outputHandlesFor,
  pickContainerTarget,
  supportsErrorHandling,
} from "./node-handles"

describe("outputHandlesFor", () => {
  it("returns null for plain single-output kinds", () => {
    expect(outputHandlesFor({ kind: "ai.prompt", typeVersion: 1, params: {} })).toBeNull()
    expect(outputHandlesFor({ kind: "flow.set", typeVersion: 1, params: {} })).toBeNull()
  })

  it("returns null for v1 branch/switch (legacy single handle + edge labels)", () => {
    expect(
      outputHandlesFor({ kind: "flow.branch", typeVersion: 1, params: { condition: "x" } })
    ).toBeNull()
    expect(outputHandlesFor({ kind: "flow.switch", typeVersion: 1, params: {} })).toBeNull()
  })

  it("branch v2 exposes true/false handles", () => {
    const handles = outputHandlesFor({ kind: "flow.branch", typeVersion: 2, params: {} })
    expect(handles).toEqual([
      { id: "true", kind: "true" },
      { id: "false", kind: "false" },
    ])
  })

  it("approval gate exposes approved/rejected handles from v1 (ADR 0061)", () => {
    const handles = outputHandlesFor({
      kind: "action.approval.request",
      typeVersion: 1,
      params: {},
    })
    expect(handles).toEqual([
      { id: "approved", kind: "approved" },
      { id: "rejected", kind: "rejected" },
    ])
  })

  it("switch v2 exposes one handle per case plus default", () => {
    const handles = outputHandlesFor({
      kind: "flow.switch",
      typeVersion: 2,
      params: {
        cases: [
          { id: "c_a", label: "Alpha", when: { combinator: "all", conditions: [] } },
          { label: "NoId", when: { combinator: "all", conditions: [] } },
        ],
      },
    })
    expect(handles).toEqual([
      { id: "c_a", kind: "case", label: "Alpha" },
      { id: "case-1", kind: "case", label: "NoId" },
      { id: "default", kind: "default" },
    ])
  })

  it("switch v2 with no cases still exposes the default handle", () => {
    const handles = outputHandlesFor({ kind: "flow.switch", typeVersion: 2, params: {} })
    expect(handles).toEqual([{ id: "default", kind: "default" }])
  })

  it("case handles fall back to the id when no label is set", () => {
    const handles = outputHandlesFor({
      kind: "flow.switch",
      typeVersion: 2,
      params: { cases: [{ id: "c_x", when: { combinator: "all", conditions: [] } }] },
    })
    expect(handles?.[0]).toEqual({ id: "c_x", kind: "case", label: undefined })
  })
})

describe("pickContainerTarget", () => {
  const all = [
    { id: "outer", parentId: undefined },
    { id: "inner", parentId: "outer" },
    { id: "child", parentId: "inner" },
    { id: "free", parentId: undefined },
  ]
  const outer = { id: "outer", width: 800, height: 600 }
  const inner = { id: "inner", width: 300, height: 200 }

  it("picks the smallest (innermost) intersecting container", () => {
    expect(pickContainerTarget("free", [outer, inner], all)).toBe("inner")
  })

  it("never picks the node itself or its own descendants", () => {
    // Dragging "outer" over its own nested container must not re-parent.
    expect(pickContainerTarget("outer", [inner], all)).toBeNull()
    expect(pickContainerTarget("outer", [outer], all)).toBeNull()
  })

  it("returns null when nothing intersects", () => {
    expect(pickContainerTarget("free", [], all)).toBeNull()
  })
})

describe("defaultTypeVersionFor", () => {
  it("new branch/switch/loop/ai.prompt nodes author at typeVersion 2", () => {
    expect(defaultTypeVersionFor("flow.branch")).toBe(2)
    expect(defaultTypeVersionFor("flow.switch")).toBe(2)
    expect(defaultTypeVersionFor("flow.loop")).toBe(2)
    expect(defaultTypeVersionFor("ai.prompt")).toBe(2)
  })

  it("everything else stays at 1", () => {
    expect(defaultTypeVersionFor("flow.set")).toBe(1)
  })
})

describe("supportsErrorHandling", () => {
  it("allows the fallible families", () => {
    for (const kind of [
      "action.agent.turn",
      "action.github.openPr",
      "ai.prompt",
      "data.transform",
      "io.http",
      "ocr.extract",
      "eval.run",
    ]) {
      expect(supportsErrorHandling(kind)).toBe(true)
    }
  })

  it("excludes triggers, flow control, and annotations", () => {
    for (const kind of [
      "trigger.manual",
      "trigger.cron",
      "flow.branch",
      "flow.join",
      "flow.loop",
      "annotation.note",
    ]) {
      expect(supportsErrorHandling(kind)).toBe(false)
    }
  })
})

describe("hasErrorHandle", () => {
  it("is true only for errorBranch on a supported kind", () => {
    expect(hasErrorHandle({ kind: "io.http", errorHandling: { onError: "errorBranch" } })).toBe(
      true
    )
    expect(hasErrorHandle({ kind: "io.http", errorHandling: { onError: "continue" } })).toBe(false)
    expect(hasErrorHandle({ kind: "io.http" })).toBe(false)
    // Unsupported kind never grows the handle, even if data says errorBranch.
    expect(hasErrorHandle({ kind: "flow.branch", errorHandling: { onError: "errorBranch" } })).toBe(
      false
    )
  })
})
