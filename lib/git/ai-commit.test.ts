import {
  buildCommitAgentPrompt,
  buildCommitAgentSystemPrompt,
  buildCommitSystemPrompt,
  buildCommitUserPrompt,
  clampDiff,
  DEFAULT_DIFF_CHAR_BUDGET,
  COMMIT_AGENT_CLAUSE_PROMPT,
  COMMIT_CONVENTIONAL_FORMAT_PROMPT,
  COMMIT_FREEFORM_FORMAT_PROMPT,
  COMMIT_SYSTEM_PROMPT,
  extractCommitMessage,
  generateCommitMessage,
  resolveCommitPromptTexts,
  stripFences,
} from "./ai-commit"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
  type ActivePromptOverride,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"
import type { GitFileChange } from "@/types/git"

afterEach(() => {
  __setPromptOverrideSnapshotForTests(null)
  __resetPromptVerdictsForTests()
})

function publish(...rows: Omit<ActivePromptOverride, "bindingId" | "contractVersion">[]) {
  __setPromptOverrideSnapshotForTests(
    buildPromptOverrideSnapshot(
      "test-db",
      rows.map((row) => ({ ...row, bindingId: `pob-${row.revisionId}`, contractVersion: 1 }))
    )
  )
}

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

describe("generateCommitMessage streaming", () => {
  it("streams through onText when the client streams, and strips fences at the end", async () => {
    async function* stream() {
      yield "```\nfix: a"
      yield "\n```"
    }
    const complete = jest.fn()
    const seen: string[] = []
    const out = await generateCommitMessage(
      { diffText: "diff", files, config: { conventionalCommits: true } },
      { complete, stream },
      { onText: (text) => seen.push(text) }
    )
    expect(out).toBe("fix: a")
    expect(seen).toEqual(["```\nfix: a", "```\nfix: a\n```"])
    expect(complete).not.toHaveBeenCalled()
  })

  it("forwards the abort signal to the client", async () => {
    const controller = new AbortController()
    const complete = jest.fn().mockResolvedValue("chore: x")
    await generateCommitMessage(
      { diffText: "diff", files, config: { conventionalCommits: false } },
      { complete },
      { abortSignal: controller.signal }
    )
    expect(complete.mock.calls[0][1].abortSignal).toBe(controller.signal)
  })
})

describe("draft hint", () => {
  it("puts the user's draft ahead of the diff when present", () => {
    const prompt = buildCommitUserPrompt({
      diffText: "diff",
      files,
      config: { conventionalCommits: true },
      draftHint: "  fix the login race  ",
    })
    expect(prompt.indexOf("fix the login race")).toBeLessThan(prompt.indexOf("Staged files:"))
  })

  it("leaves the prompt unchanged for a blank draft", () => {
    const base = { diffText: "diff", files, config: { conventionalCommits: true } }
    expect(buildCommitUserPrompt({ ...base, draftHint: "   " })).toBe(buildCommitUserPrompt(base))
  })
})

describe("agent prompts", () => {
  it("asks the agent to stay read-only and to tag its answer", () => {
    const system = buildCommitAgentSystemPrompt({ conventionalCommits: true })
    expect(system).toContain("Conventional Commits")
    expect(system).toContain("do not modify anything")
    expect(system).toContain("<commit-message>")
  })

  it("carries the instructions inside the prompt as well", () => {
    const prompt = buildCommitAgentPrompt({
      diffText: "diff --git a b",
      files,
      config: { conventionalCommits: false },
    })
    expect(prompt).toContain("<commit-message>")
    expect(prompt).toContain("diff --git a b")
  })
})

describe("extractCommitMessage", () => {
  it("takes the last tagged block, ignoring narration", () => {
    const text =
      "I will wrap it in <commit-message>like this</commit-message>.\n" +
      "Reading files…\n<commit-message>\nfeat(git): add x\n\nBecause y.\n</commit-message>"
    expect(extractCommitMessage(text)).toBe("feat(git): add x\n\nBecause y.")
  })

  it("strips fences inside the tag", () => {
    expect(extractCommitMessage("<commit-message>```\nfix: z\n```</commit-message>")).toBe("fix: z")
  })

  it("falls back to the whole answer without a tag", () => {
    expect(extractCommitMessage("  docs: update readme \n")).toBe("docs: update readme")
  })

  it("returns an empty string for an empty answer", () => {
    expect(extractCommitMessage("<commit-message>  </commit-message>")).toBe("")
  })
})

describe("Prompt Center overrides", () => {
  it("resolves the shipped texts byte-identically when nothing is published", async () => {
    for (const conventionalCommits of [true, false]) {
      const texts = await resolveCommitPromptTexts({ conventionalCommits })
      expect(texts.system).toBe(buildCommitSystemPrompt({ conventionalCommits }))
      expect(texts.agentClause).toBe(COMMIT_AGENT_CLAUSE_PROMPT.defaultBody)
    }
  })

  it("renders the selected format override into the base instructions", async () => {
    publish(
      {
        promptId: COMMIT_FREEFORM_FORMAT_PROMPT.id,
        scope: "account",
        targetId: "",
        revisionId: "por-commit-freeform",
        body: "One short line, lowercase.",
      },
      {
        promptId: COMMIT_CONVENTIONAL_FORMAT_PROMPT.id,
        scope: "account",
        targetId: "",
        revisionId: "por-commit-conventional",
        body: "Gitmoji, please.",
      }
    )
    const complete = jest.fn().mockResolvedValue("chore: x")
    await generateCommitMessage(
      { diffText: "diff", files, config: { conventionalCommits: false } },
      { complete }
    )
    expect(complete.mock.calls[0][1].system).toBe(
      [
        "You write Git commit messages from a staged diff.",
        "Output ONLY the raw commit message — no markdown fences, no preamble, no quotes.",
        "One short line, lowercase.",
        "Never invent changes that are not present in the diff.",
      ].join("\n")
    )
  })

  it("applies a workspace override only to that workspace's repositories", async () => {
    publish({
      promptId: COMMIT_SYSTEM_PROMPT.id,
      scope: "workspace",
      targetId: "ws-1",
      revisionId: "por-commit-system-ws",
      body: "House style.\n{{formatRules}}",
    })
    const complete = jest.fn().mockResolvedValue("chore: x")
    const input = {
      diffText: "diff",
      files,
      config: { conventionalCommits: true, customInstructions: "Mention the ticket" },
    }
    await generateCommitMessage(input, { complete }, { promptContext: { workspaceId: "ws-1" } })
    expect(complete.mock.calls[0][1].system).toBe(
      `House style.\n${COMMIT_CONVENTIONAL_FORMAT_PROMPT.defaultBody}\nAdditional instructions: Mention the ticket`
    )
    await generateCommitMessage(input, { complete }, { promptContext: { workspaceId: "ws-2" } })
    expect(complete.mock.calls[1][1].system).toBe(buildCommitSystemPrompt(input.config))
  })

  it("puts a resolved agent clause into the agent prompts", async () => {
    publish({
      promptId: COMMIT_AGENT_CLAUSE_PROMPT.id,
      scope: "account",
      targetId: "",
      revisionId: "por-commit-agent-clause",
      body: "Stay read-only. Answer in <commit-message></commit-message>.",
    })
    const texts = await resolveCommitPromptTexts({ conventionalCommits: true })
    const system = buildCommitAgentSystemPrompt({ conventionalCommits: true }, texts)
    expect(system).toBe(
      `${buildCommitSystemPrompt({ conventionalCommits: true })}\nStay read-only. Answer in <commit-message></commit-message>.`
    )
    const prompt = buildCommitAgentPrompt(
      { diffText: "d", files, config: { conventionalCommits: true } },
      texts
    )
    expect(prompt.startsWith(`${system}\n\n`)).toBe(true)
  })

  it("stops before calling the model when aborted while resolving", async () => {
    const controller = new AbortController()
    controller.abort()
    const complete = jest.fn()
    await expect(
      generateCommitMessage(
        { diffText: "diff", files, config: { conventionalCommits: true } },
        { complete },
        { abortSignal: controller.signal }
      )
    ).rejects.toBeDefined()
    expect(complete).not.toHaveBeenCalled()
  })
})
