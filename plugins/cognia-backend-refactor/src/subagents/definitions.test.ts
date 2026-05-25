import { REFACTOR_SUBAGENTS } from "./definitions"
import { subagentRuntimeId } from "../ids"

describe("REFACTOR_SUBAGENTS", () => {
  it("ships the analyzer and diff-reviewer", () => {
    expect(REFACTOR_SUBAGENTS.map((s) => s.id)).toEqual(["go-analyzer", "diff-reviewer"])
  })

  it("are read-only reasoning helpers (no Edit/Write tools)", () => {
    for (const sub of REFACTOR_SUBAGENTS) {
      expect(sub.tools).toEqual(expect.arrayContaining(["Read", "Grep"]))
      expect(sub.tools).not.toContain("Edit")
      expect(sub.tools).not.toContain("Write")
      expect(sub.prompt.length).toBeGreaterThan(40)
      expect(sub.model).toBe("sonnet")
    }
  })

  it("exposes runtime ids the team template can require", () => {
    expect(subagentRuntimeId("go-analyzer")).toBe("cognia-backend-refactor:go-analyzer")
    expect(subagentRuntimeId("diff-reviewer")).toBe("cognia-backend-refactor:diff-reviewer")
  })
})
