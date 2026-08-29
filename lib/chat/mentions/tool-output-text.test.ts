import { TOOL_OUTPUT_MAX_CHARS, isToolPart, projectToolOutputText } from "./tool-output-text"

describe("isToolPart", () => {
  // Two dialects, both live: `tool-<name>` from SDK-declared tools and
  // `dynamic-tool` from imported transcripts, CLI sessions and MCP.
  it.each([["tool-Read"], ["tool-bash"], ["dynamic-tool"]])("accepts %s", (type) => {
    expect(isToolPart({ type })).toBe(true)
  })

  it.each([["text"], ["reasoning"], ["file"], ["sources"], [undefined]])("rejects %s", (type) => {
    expect(isToolPart({ type })).toBe(false)
  })
})

describe("projectToolOutputText", () => {
  it("is empty for a call that has not returned", () => {
    expect(projectToolOutputText({ type: "tool-Read", state: "input-available" })).toBe("")
    expect(projectToolOutputText({ type: "tool-Read", output: null })).toBe("")
  })

  it("returns a plain string output as-is", () => {
    expect(projectToolOutputText({ output: "line one\nline two" })).toBe("line one\nline two")
  })

  it("reads MCP content blocks", () => {
    expect(
      projectToolOutputText({
        output: {
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      })
    ).toBe("first\nsecond")
  })

  // Dropping a screenshot without a word reads to the model as a tool that
  // returned nothing, which is a different (and wrong) claim.
  it("announces a non-text block rather than dropping it", () => {
    expect(
      projectToolOutputText({
        output: {
          content: [
            { type: "image", data: "…" },
            { type: "text", text: "after" },
          ],
        },
      })
    ).toBe("[image]\nafter")
  })

  it("walks a structured output for its strings", () => {
    expect(
      projectToolOutputText({ output: { stdout: "ok", exitCode: 0, nested: { note: "done" } } })
    ).toBe("ok\n0\ndone")
  })

  it("treats an array as siblings, not as a nesting level", () => {
    expect(projectToolOutputText({ output: { rows: [{ a: "x" }, { a: "y" }] } })).toBe("x\ny")
  })

  // An output arrives as JSON but is handed over as a live object callers may
  // have decorated, so the cycle is guarded rather than assumed away.
  it("survives a cyclic output", () => {
    const output: Record<string, unknown> = { note: "hi" }
    output.self = output
    expect(projectToolOutputText({ output })).toBe("hi")
  })

  it("keeps a failed call's error — a referenced failure is still a result", () => {
    expect(
      projectToolOutputText({ state: "output-error", errorText: "ENOENT: no such file" })
    ).toBe("Error: ENOENT: no such file")
  })

  it("is empty for an error with nothing in it", () => {
    expect(projectToolOutputText({ state: "output-error" })).toBe("")
  })

  it("marks the cut visibly rather than truncating silently", () => {
    const out = projectToolOutputText({ output: "x".repeat(TOOL_OUTPUT_MAX_CHARS + 500) })
    expect(out).toContain("[tool output truncated]")
    expect(out.length).toBeLessThan(TOOL_OUTPUT_MAX_CHARS + 60)
  })

  it("leaves an output at the cap untouched", () => {
    const out = projectToolOutputText({ output: "x".repeat(TOOL_OUTPUT_MAX_CHARS) })
    expect(out).not.toContain("truncated")
  })
})
