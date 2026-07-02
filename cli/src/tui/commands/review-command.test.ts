import { buildReviewPrompt, reviewCommand } from "./review-command"
import type { CommandContext } from "./types"

function ctx(args: string): CommandContext {
  return {
    state: {} as CommandContext["state"],
    config: {} as CommandContext["config"],
    version: "0",
    args,
  }
}

describe("buildReviewPrompt", () => {
  it("frames a working-tree review when no base is given", () => {
    const p = buildReviewPrompt("")
    expect(p).toContain("current working-tree changes")
    expect(p).toContain("git_status")
    expect(p).toContain("codegraph_impact")
    expect(p).toContain("Correctness")
    expect(p).toContain("Security")
    expect(p).not.toContain("versus")
  })

  it("frames a vs-base review when a base branch is given", () => {
    const p = buildReviewPrompt("master")
    expect(p).toContain("versus `master`")
    expect(p).toContain("git diff master...HEAD")
    expect(p).toContain("git_log master..HEAD")
  })
})

describe("reviewCommand", () => {
  it("returns a send effect carrying the framed prompt", () => {
    const effect = reviewCommand.handler!(ctx("  dev  "))
    expect(effect).toEqual({ kind: "send", prompt: buildReviewPrompt("dev") })
  })

  it("is registered under the cognia category with a base-branch hint", () => {
    expect(reviewCommand.category).toBe("cognia")
    expect(reviewCommand.argumentHint).toBe("[base branch]")
  })
})
