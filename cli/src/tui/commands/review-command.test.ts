import { CLI_REVIEW_PROMPT } from "@/lib/agent/prompts/cli-prompts"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
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
  it("returns a review effect naming the trimmed base (the App builds the prompt)", () => {
    expect(reviewCommand.handler!(ctx("  dev  "))).toEqual({ kind: "review", base: "dev" })
    expect(reviewCommand.handler!(ctx(""))).toEqual({ kind: "review", base: "" })
  })

  it("is registered under the cognia category with a base-branch hint", () => {
    expect(reviewCommand.category).toBe("cognia")
    expect(reviewCommand.argumentHint).toBe("[base branch]")
  })
})

describe("review Prompt Center override", () => {
  afterEach(() => {
    __setPromptOverrideSnapshotForTests(null)
    __resetPromptVerdictsForTests()
  })

  it("renders a published workspace override for the workspace mounting the cwd", () => {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob-review",
          promptId: CLI_REVIEW_PROMPT.id,
          scope: "workspace",
          targetId: "ws-1",
          revisionId: "por-review-1",
          body: "Security-only review of {{scope}}{{gitLogStep}}.",
          contractVersion: CLI_REVIEW_PROMPT.contractVersion,
        },
      ])
    )
    expect(buildReviewPrompt("dev", { workspaceId: "ws-1" })).toBe(
      "Security-only review of the changes on this branch versus `dev` (use `git diff dev...HEAD`), git_log dev..HEAD."
    )
    expect(buildReviewPrompt("dev")).toContain("Perform a thorough code review")
  })
})
