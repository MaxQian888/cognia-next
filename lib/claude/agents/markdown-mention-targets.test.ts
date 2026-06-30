const loadInstructionsMock = jest.fn()
jest.mock("@/lib/claude/instructions/load", () => ({
  loadProjectInstructions: (...a: unknown[]) => loadInstructionsMock(...a),
}))

import { markdownAgentTargets, discoverMarkdownAgentTargets } from "./markdown-mention-targets"
import { resolveTargetAgentId } from "./chat-mention-targets"
import type { MarkdownAgentFile } from "@/lib/claude/agents/markdown-agents"

beforeEach(() => loadInstructionsMock.mockReset())

const file = (id: string, body: string): MarkdownAgentFile => ({ id, content: body })

describe("markdownAgentTargets", () => {
  it("projects parsed markdown agents into mention targets (handle === id)", () => {
    const targets = markdownAgentTargets([
      file("code-reviewer", "---\ndescription: Reviews code\nmodel: opus\n---\nYou review code."),
    ])
    expect(targets).toEqual([
      {
        id: "code-reviewer",
        name: "Code Reviewer",
        description: "Reviews code",
        model: "opus",
        handle: "code-reviewer",
      },
    ])
  })

  it("falls back to the raw id when it humanizes to empty", () => {
    const targets = markdownAgentTargets([file("_", "---\ndescription: Edge\n---\nbody")])
    expect(targets[0]).toMatchObject({ id: "_", name: "_", handle: "_" })
  })

  it("skips malformed files (missing description / empty body)", () => {
    const targets = markdownAgentTargets([
      file("bad", "---\n---\n"),
      file("good", "---\ndescription: Ok\n---\nbody"),
    ])
    expect(targets.map((t) => t.id)).toEqual(["good"])
  })

  it("round-trips: a picked markdown handle resolves back to its agent id", () => {
    const targets = markdownAgentTargets([
      file("doc-writer", "---\ndescription: Writes docs\n---\nWrite docs."),
    ])
    expect(resolveTargetAgentId("please @doc-writer help", targets)).toBe("doc-writer")
  })
})

describe("discoverMarkdownAgentTargets", () => {
  it("discovers + projects markdown agent files for the given roots", async () => {
    loadInstructionsMock.mockResolvedValue({
      markdownAgentFiles: [file("triage", "---\ndescription: Triages issues\n---\nTriage.")],
    })
    const targets = await discoverMarkdownAgentTargets({ cwd: "/repo", roots: ["/repo"] })
    expect(targets.map((t) => t.id)).toEqual(["triage"])
    expect(loadInstructionsMock).toHaveBeenCalledWith({ cwd: "/repo", roots: ["/repo"] })
  })

  it("returns [] when discovery throws (best-effort, never blocks)", async () => {
    loadInstructionsMock.mockRejectedValue(new Error("no fs"))
    expect(await discoverMarkdownAgentTargets({ roots: [] })).toEqual([])
  })
})
