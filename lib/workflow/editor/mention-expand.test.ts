import { expandWorkflowMentions, snapshotFromEditorState } from "./mention-expand"

const SNAPSHOT = {
  nodes: [
    { id: "n_trigger", kind: "trigger.manual", label: "Click run" },
    { id: "n_extract", kind: "ai.extract", label: "Parse issue" },
    { id: "n_open_pr", kind: "demo-delivery.action.openPr", label: "" },
  ],
  edges: [
    { id: "e_te", source: "n_trigger", target: "n_extract" },
    {
      id: "e_eo",
      source: "n_extract",
      target: "n_open_pr",
      sourceHandle: "then",
      label: "pass",
    },
  ],
}

describe("expandWorkflowMentions", () => {
  it("expands a node mention into its citation form", () => {
    const out = expandWorkflowMentions("Please check @node:n_extract for the params.", SNAPSHOT)
    expect(out).toBe('Please check `n_extract` (`ai.extract` · "Parse issue") for the params.')
  })

  it("omits the label segment when the node has no label", () => {
    const out = expandWorkflowMentions("Look at @node:n_open_pr.", SNAPSHOT)
    expect(out).toBe("Look at `n_open_pr` (`demo-delivery.action.openPr`).")
  })

  it("expands an edge mention with source → target and handle", () => {
    const out = expandWorkflowMentions("The edge @edge:e_eo carries the result.", SNAPSHOT)
    expect(out).toBe(
      'The edge `e_eo` (`n_extract`→`n_open_pr` via `then`) "pass" carries the result.'
    )
  })

  it("expands an edge mention without a handle", () => {
    const out = expandWorkflowMentions("Edge @edge:e_te is the entry.", SNAPSHOT)
    expect(out).toBe("Edge `e_te` (`n_trigger`→`n_extract`) is the entry.")
  })

  it("leaves an unknown node mention untouched (dangling reference)", () => {
    const out = expandWorkflowMentions("Look at @node:n_ghost please.", SNAPSHOT)
    expect(out).toBe("Look at @node:n_ghost please.")
  })

  it("leaves an unknown edge mention untouched", () => {
    const out = expandWorkflowMentions("@edge:e_ghost dangling.", SNAPSHOT)
    expect(out).toBe("@edge:e_ghost dangling.")
  })

  it("expands several mentions in one pass", () => {
    const out = expandWorkflowMentions(
      "Trace @node:n_trigger → @node:n_extract via @edge:e_te.",
      SNAPSHOT
    )
    expect(out).toContain('`n_trigger` (`trigger.manual` · "Click run")')
    expect(out).toContain('`n_extract` (`ai.extract` · "Parse issue")')
    expect(out).toContain("`e_te` (`n_trigger`→`n_extract`)")
  })

  it("does not match the @-prefix when followed by other letters", () => {
    // Make sure plain prose with `@username` (no `:`) is not mistakenly mangled.
    const out = expandWorkflowMentions("Hi @alice, please check the graph.", SNAPSHOT)
    expect(out).toBe("Hi @alice, please check the graph.")
  })

  it("ignores @ inside an email-like span (no node:/edge: prefix)", () => {
    const out = expandWorkflowMentions("Ping max@anthropic.com.", SNAPSHOT)
    expect(out).toBe("Ping max@anthropic.com.")
  })
})

describe("snapshotFromEditorState", () => {
  it("flattens the editor store's React-Flow shape into the mention snapshot", () => {
    const state = {
      nodes: [
        { id: "n_a", data: { kind: "trigger.manual", label: "Run" } },
        { id: "n_b", data: { kind: "ai.prompt", label: 42 } }, // non-string label
      ],
      edges: [
        {
          id: "e_ab",
          source: "n_a",
          target: "n_b",
          data: { label: "go" },
          sourceHandle: "out",
        },
      ],
    }
    const snapshot = snapshotFromEditorState(state)
    expect(snapshot.nodes).toEqual([
      { id: "n_a", kind: "trigger.manual", label: "Run" },
      { id: "n_b", kind: "ai.prompt", label: undefined },
    ])
    expect(snapshot.edges).toEqual([
      {
        id: "e_ab",
        source: "n_a",
        target: "n_b",
        sourceHandle: "out",
        targetHandle: undefined,
        label: "go",
      },
    ])
  })

  it("falls back to 'unknown' when data.kind is missing", () => {
    const snapshot = snapshotFromEditorState({
      nodes: [{ id: "n_x", data: { label: "x" } }],
      edges: [],
    })
    expect(snapshot.nodes[0].kind).toBe("unknown")
  })
})
