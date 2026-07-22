import {
  getActiveContextResource,
  resetActiveContextForTesting,
  setActiveContextForHost,
} from "./active-context"

afterEach(resetActiveContextForTesting)

it("falls back to the newest remaining host and returns defensive copies", () => {
  const disposeCanvas = setActiveContextForHost("canvas", {
    kind: "canvas-document",
    documentId: "doc-1",
    revision: "1",
    selection: { kind: "canvas", blockIds: ["a"] },
    capabilities: ["comments"],
  })
  const disposeWorkflow = setActiveContextForHost("workflow", {
    kind: "workflow",
    workflowId: "wf-1",
    editorRevision: "2",
    selection: { kind: "workflow", nodeIds: ["n1"], edgeIds: [] },
    capabilities: ["inspect"],
  })

  expect(getActiveContextResource()?.kind).toBe("workflow")
  disposeWorkflow()
  const resource = getActiveContextResource()
  expect(resource?.kind).toBe("canvas-document")
  if (resource?.kind === "canvas-document" && resource.selection) {
    resource.selection.blockIds.push("mutated")
  }
  expect(getActiveContextResource()).toMatchObject({
    selection: { blockIds: ["a"] },
  })
  disposeCanvas()
})

it("returns defensive copies for session resources without inventing a selection", () => {
  const dispose = setActiveContextForHost("session", {
    kind: "session",
    sessionId: "session-1",
    capabilities: ["inspect"],
  })

  const resource = getActiveContextResource()
  expect(resource).toEqual({
    kind: "session",
    sessionId: "session-1",
    capabilities: ["inspect"],
  })
  resource?.capabilities.push("preview")
  expect(getActiveContextResource()?.capabilities).toEqual(["inspect"])
  expect(getActiveContextResource()).not.toHaveProperty("selection")
  dispose()
})
