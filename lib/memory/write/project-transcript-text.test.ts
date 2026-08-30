/** @jest-environment node */
import { MINING_TOOL_OUTPUT_MAX_CHARS, projectMiningMessageText } from "./project-transcript-text"

const TEXT = { type: "text", text: "Running the suite now." }

describe("projectMiningMessageText", () => {
  it("includes tool output that the search projection drops", async () => {
    // The whole point: an assistant claiming the suite passed is not an
    // outcome; the run that proves it is, and it lives in a tool part.
    const { extractPlainText } = await import("@/lib/inbox/extract-plain-text")
    const parts = [TEXT, { type: "tool-Bash", state: "output-available", output: "42 passed" }]
    expect(extractPlainText(parts)).not.toContain("42 passed")
    expect(projectMiningMessageText(parts)).toContain("42 passed")
  })

  it("labels each tool part with the index its evidence sourceId uses", () => {
    const parts = [
      TEXT,
      { type: "tool-Read", state: "output-available", output: "file body" },
      { type: "dynamic-tool", state: "output-available", output: "mcp body" },
    ]
    const text = projectMiningMessageText(parts)
    expect(text).toContain("[tool 1] file body")
    expect(text).toContain("[tool 2] mcp body")
  })

  it("announces truncation instead of eliding silently", () => {
    // A body clipped without a marker reads as complete, which is how a claim
    // gets mined from evidence that was never fully there.
    const parts = [{ type: "tool-Bash", state: "output-available", output: "x".repeat(5_000) }]
    const text = projectMiningMessageText(parts, { maxToolChars: 50 })
    expect(text).toContain("…[truncated]")
    expect(text.length).toBeLessThan(200)
  })

  it("keeps a failed call's error, which is itself a gotcha", () => {
    const parts = [
      { type: "tool-Bash", state: "output-error", errorText: "exit code 137: OOM killed" },
    ]
    expect(projectMiningMessageText(parts)).toContain("exit code 137")
  })

  it("returns the plain projection when there are no tool parts", () => {
    expect(projectMiningMessageText([TEXT])).toBe("Running the suite now.")
  })

  it("tolerates a non-array parts value", () => {
    expect(projectMiningMessageText(undefined)).toBe("")
  })

  it("caps a tool body well under the window token budget by default", () => {
    expect(MINING_TOOL_OUTPUT_MAX_CHARS).toBeLessThan(2_000)
  })
})
