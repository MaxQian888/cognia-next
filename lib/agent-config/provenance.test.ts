/** @jest-environment node */

import { instructionFileKey } from "@/lib/prompts/adapters/instruction-files"
import { readAgentConfigProvenance, surfaceFilePath } from "./provenance"
import { agentFileKey } from "./surfaces"

const line = (lineNumber: number, commitHash: string) => ({
  lineNumber,
  commitHash,
  shortHash: commitHash.slice(0, 7),
  authorName: "Someone Private",
  authoredAtMs: 1_000 * lineNumber,
  summary: "fix: contact me@example.com",
  content: "x",
})

describe("readAgentConfigProvenance", () => {
  it("returns commit and time only, run from the file's directory", async () => {
    const blame = jest.fn(async () => [line(1, "a".repeat(40)), line(2, "0".repeat(40))])
    const key = instructionFileKey({ root: "/repo/sub", name: "CLAUDE.md" })
    const result = await readAgentConfigProvenance(key, blame)
    expect(blame).toHaveBeenCalledWith("/repo/sub", "CLAUDE.md")
    expect(result).toEqual([
      { line: 1, commit: "a".repeat(40), authoredAtMs: 1000 },
      { line: 2, commit: "", authoredAtMs: 2000 },
    ])
    expect(JSON.stringify(result)).not.toMatch(/Someone|example\.com/)
  })

  it("answers only for file-backed surfaces", async () => {
    const blame = jest.fn()
    expect(await readAgentConfigProvenance("skill:s1", blame)).toBeNull()
    expect(blame).not.toHaveBeenCalled()
    expect(surfaceFilePath(agentFileKey({ dir: "/repo/.cognia/agents", name: "r.md" }))).toBe(
      "/repo/.cognia/agents/r.md"
    )
  })

  it("is null when the file is not in a repository", async () => {
    const key = instructionFileKey({ root: "/home/.cognia", name: "AGENTS.md" })
    expect(
      await readAgentConfigProvenance(
        key,
        jest.fn(async () => {
          throw new Error("not a repo")
        })
      )
    ).toBeNull()
    expect(
      await readAgentConfigProvenance(
        key,
        jest.fn(async () => [])
      )
    ).toBeNull()
  })
})
