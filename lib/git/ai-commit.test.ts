import {
  buildCommitSystemPrompt,
  buildCommitUserPrompt,
  clampDiff,
  DEFAULT_DIFF_CHAR_BUDGET,
  generateCommitMessage,
  stripFences,
} from "./ai-commit"
import type { GitFileChange } from "@/types/git"

const files: Pick<GitFileChange, "path" | "status">[] = [
  { path: "src/a.ts", status: "modified" },
  { path: "src/b.ts", status: "added" },
  { path: "old.ts", status: "deleted" },
]

describe("buildCommitSystemPrompt", () => {
  it("includes the Conventional Commits clause when enabled", () => {
    const p = buildCommitSystemPrompt({ conventionalCommits: true })
    expect(p).toContain("Conventional Commits")
    expect(p).toContain("feat|fix|docs")
  })

  it("uses the free-form clause when disabled", () => {
    const p = buildCommitSystemPrompt({ conventionalCommits: false })
    expect(p).not.toContain("Conventional Commits")
    expect(p).toContain("imperative mood")
  })

  it("appends custom instructions when present", () => {
    const p = buildCommitSystemPrompt({
      conventionalCommits: true,
      customInstructions: "Write in past tense",
    })
    expect(p).toContain("Additional instructions: Write in past tense")
  })

  it("omits the custom-instructions line when blank", () => {
    const p = buildCommitSystemPrompt({ conventionalCommits: true, customInstructions: "   " })
    expect(p).not.toContain("Additional instructions")
  })
})

describe("clampDiff", () => {
  it("returns short diffs unchanged", () => {
    expect(clampDiff("small", 100)).toBe("small")
  })

  it("truncates and flags long diffs", () => {
    const long = "x".repeat(DEFAULT_DIFF_CHAR_BUDGET + 50)
    const out = clampDiff(long)
    expect(out.length).toBeLessThan(long.length)
    expect(out).toContain("[diff truncated for length]")
  })
})

describe("buildCommitUserPrompt", () => {
  it("lists files with status letters and fences the diff", () => {
    const prompt = buildCommitUserPrompt({
      diffText: "diff --git a/a.ts b/a.ts",
      files,
      config: { conventionalCommits: true },
    })
    expect(prompt).toContain("M src/a.ts")
    expect(prompt).toContain("A src/b.ts")
    expect(prompt).toContain("D old.ts")
    expect(prompt).toContain("```diff")
    expect(prompt).toContain("diff --git")
  })

  it("notes when no file metadata is available", () => {
    const prompt = buildCommitUserPrompt({
      diffText: "x",
      files: [],
      config: { conventionalCommits: false },
    })
    expect(prompt).toContain("(no staged file metadata)")
  })
})

describe("stripFences", () => {
  it("removes a fenced block", () => {
    expect(stripFences("```\nfeat: x\n```")).toBe("feat: x")
    expect(stripFences("```text\nfix: y\n```")).toBe("fix: y")
  })

  it("trims plain text", () => {
    expect(stripFences("  chore: z  ")).toBe("chore: z")
  })
})

describe("generateCommitMessage", () => {
  it("assembles prompts, calls the client, and strips fences", async () => {
    const complete = jest.fn().mockResolvedValue("```\nfeat(a): do thing\n```")
    const out = await generateCommitMessage(
      { diffText: "diff", files, config: { conventionalCommits: true } },
      { complete }
    )
    expect(out).toBe("feat(a): do thing")
    const [prompt, options] = complete.mock.calls[0]
    expect(options.system).toContain("Conventional Commits")
    expect(prompt).toContain("```diff")
  })
})
