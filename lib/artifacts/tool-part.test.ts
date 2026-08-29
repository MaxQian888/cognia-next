import { artifactPartFromToolResult, bareToolName } from "./tool-part"

describe("bareToolName", () => {
  it("strips both provider namespaces", () => {
    // The Anthropic path sees the bare name and the AI-SDK path the namespaced
    // one; matching only one form would work on one provider only.
    expect(bareToolName("mcp__cognia-plugin-tools__artifact_create")).toBe("artifact_create")
    expect(bareToolName("mcp__cognia-tools__artifact_create")).toBe("artifact_create")
    expect(bareToolName("artifact_create")).toBe("artifact_create")
  })

  it("survives a missing name", () => {
    expect(bareToolName(undefined)).toBe("")
    expect(bareToolName(null)).toBe("")
  })
})

describe("artifactPartFromToolResult", () => {
  const ok = { ok: true, artifactId: "a1", title: "Demo", type: "chart" }

  it("builds an artifact part from a successful create", () => {
    expect(artifactPartFromToolResult("artifact_create", ok)).toEqual({
      type: "artifact",
      artifactId: "a1",
      title: "Demo",
      kind: "chart",
    })
  })

  it("carries the tool call id so a re-delivered result is recognisable", () => {
    // A tool_result can arrive twice (retry, reconnect, replay).
    expect(artifactPartFromToolResult("artifact_update", ok, { toolCallId: "t-9" })).toMatchObject({
      toolCallId: "t-9",
    })
  })

  it("unwraps a relay-wrapped result", () => {
    expect(artifactPartFromToolResult("artifact_create", { result: ok })).toMatchObject({
      artifactId: "a1",
    })
  })

  it("builds a canvas part for the canvas tools", () => {
    const doc = { ok: true, documentId: "d1", title: "Draft" }
    for (const name of ["canvas_create", "canvas_update", "canvas_open"]) {
      expect(artifactPartFromToolResult(name, doc)).toMatchObject({
        type: "canvas",
        canvasId: "d1",
        title: "Draft",
      })
    }
  })

  it("falls back to `code` for a kind the badge cannot render", () => {
    expect(artifactPartFromToolResult("artifact_create", { ...ok, type: "jupyter" })).toMatchObject(
      { kind: "code" }
    )
  })

  it("returns null for a failed call", () => {
    // The tool card already shows the error; an artifact card pointing at a row
    // that was never written is the failure this module exists to prevent.
    expect(
      artifactPartFromToolResult("artifact_create", { ok: false, code: "invalid_arguments" })
    ).toBeNull()
  })

  it("returns null when the result is missing the id or the title", () => {
    expect(artifactPartFromToolResult("artifact_create", { ok: true, title: "x" })).toBeNull()
    expect(artifactPartFromToolResult("artifact_create", { ok: true, artifactId: "x" })).toBeNull()
  })

  it("returns null for a non-artifact tool", () => {
    expect(artifactPartFromToolResult("Read", ok)).toBeNull()
  })

  it("returns null for a malformed result", () => {
    for (const result of [null, undefined, "text", 42, []]) {
      expect(artifactPartFromToolResult("artifact_create", result)).toBeNull()
    }
  })

  it("does not accept the old tool_use INPUT shape", () => {
    // Regression pin: the two functions this replaced read `input.id`, which is
    // the model's guess. `createArtifact` mints its own, so a part built from
    // it pointed at nothing and rendered the "cleared" placeholder.
    expect(
      artifactPartFromToolResult("artifact_create", { id: "model-guess", title: "Demo" })
    ).toBeNull()
  })
})
