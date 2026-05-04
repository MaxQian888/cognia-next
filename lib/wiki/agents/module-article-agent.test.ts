/**
 * Coverage for `ModuleArticleAgent` — both the high-level driver (with a
 * mock LLM) and the markdown-parsing internals exposed via `__TESTING__`.
 */

import { __TESTING__, assembleArticle, runModuleArticleAgent } from "./module-article-agent"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { CodeChunk, ModuleStat } from "../types"

function stat(overrides: Partial<ModuleStat> = {}): ModuleStat {
  return {
    module: overrides.module ?? "lib/foo",
    filePaths: overrides.filePaths ?? ["lib/foo/index.ts"],
    totalLines: overrides.totalLines ?? 10,
    totalTokens: overrides.totalTokens ?? 50,
    pageRank: overrides.pageRank ?? 1,
  }
}

function chunk(overrides: Partial<CodeChunk> = {}): CodeChunk {
  return {
    id: overrides.id ?? "c1",
    filePath: overrides.filePath ?? "lib/foo/index.ts",
    module: overrides.module ?? "lib/foo",
    lineStart: overrides.lineStart ?? 1,
    lineEnd: overrides.lineEnd ?? 10,
    tokenCount: overrides.tokenCount ?? 50,
    content: overrides.content ?? "export const x = 1",
    fileHash: overrides.fileHash ?? "h_abc",
  }
}

const SAMPLE_BODY = [
  "# lib/foo — utility module",
  "",
  "Exports the core `foo()` helper used across lib/.",
  "",
  "## What it does",
  "- Computes the foo metric.",
  "- Caches results in memory.",
  "",
  "## Public API",
  "- `foo(x: number): string` — the foo of x. (`lib/foo/index.ts:3`)",
].join("\n")

describe("runModuleArticleAgent", () => {
  it("calls the LLM with the wiki system voice and the rendered prompt", async () => {
    const calls: { prompt: string; system?: string; maxTokens?: number; temperature?: number }[] =
      []
    const llm: LlmClient = {
      async complete(prompt, options) {
        calls.push({
          prompt,
          system: options?.system,
          maxTokens: options?.maxTokens,
          temperature: options?.temperature,
        })
        return SAMPLE_BODY
      },
    }
    const draft = await runModuleArticleAgent(
      { llm },
      {
        stat: stat(),
        chunks: [chunk()],
        fileHashes: { "lib/foo/index.ts": "h_abc" },
      }
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].system).toMatch(/coding agents/i)
    expect(calls[0].temperature).toBe(0)
    expect(calls[0].maxTokens).toBe(__TESTING__.MAX_OUTPUT_TOKENS)
    expect(draft.module).toBe("lib/foo")
    expect(draft.slug).toBe("lib-foo")
    expect(draft.title).toContain("lib/foo")
    expect(draft.summary).toMatch(/foo\(\).{0,3}helper/)
    expect(draft.sections.length).toBeGreaterThanOrEqual(2)
  })
})

describe("assembleArticle", () => {
  it("populates sourceRefs from the chunk list", () => {
    const draft = assembleArticle(stat(), [chunk()], { "lib/foo/index.ts": "h_abc" }, SAMPLE_BODY)
    expect(draft.sourceRefs).toEqual([
      { filePath: "lib/foo/index.ts", lineStart: 1, lineEnd: 10, sha: "h_abc" },
    ])
  })

  it("propagates fileHashes onto the draft", () => {
    const draft = assembleArticle(stat(), [chunk()], { "lib/foo/index.ts": "h_xyz" }, SAMPLE_BODY)
    expect(draft.fileHashes).toEqual({ "lib/foo/index.ts": "h_xyz" })
  })

  it("strips an outer ```markdown fence if the model added one", () => {
    const wrapped = "```markdown\n" + SAMPLE_BODY + "\n```"
    const draft = assembleArticle(stat(), [chunk()], {}, wrapped)
    expect(draft.contentMd).not.toContain("```markdown")
    expect(draft.title).toContain("lib/foo")
  })

  it("falls back to a synthesized title when the response has no H1", () => {
    const draft = assembleArticle(
      stat({ module: "lib/bare" }),
      [chunk()],
      {},
      "## What it does\n\nthings"
    )
    expect(draft.title).toMatch(/lib\/bare/)
  })

  it("falls back to a placeholder summary when no paragraph follows the H1", () => {
    const draft = assembleArticle(stat(), [chunk()], {}, "# title")
    expect(draft.summary).toMatch(/unavailable/i)
  })

  it("renders contentMd in the canonical H1 + summary + sections shape", () => {
    const draft = assembleArticle(stat(), [chunk()], {}, SAMPLE_BODY)
    expect(draft.contentMd).toMatch(/^# lib\/foo/m)
    expect(draft.contentMd).toMatch(/## What it does/)
    expect(draft.contentMd).toMatch(/## Public API/)
  })
})

describe("internal parsers", () => {
  it("stripFencedBody returns the inner body for fenced input", () => {
    expect(__TESTING__.stripFencedBody("```md\nbody\n```")).toBe("body")
  })

  it("stripFencedBody passes through unfenced input", () => {
    expect(__TESTING__.stripFencedBody("plain")).toBe("plain")
  })

  it("extractTitle returns the H1 text when present", () => {
    expect(__TESTING__.extractTitle("# Hello\n\nbody", "fallback")).toBe("Hello")
  })

  it("extractTitle returns the fallback when no H1 is present", () => {
    expect(__TESTING__.extractTitle("body without heading", "lib/x")).toBe(
      "lib/x — module overview"
    )
  })

  it("extractSummary captures the first paragraph after H1", () => {
    expect(__TESTING__.extractSummary("# Title\n\nfirst paragraph\n\n## Section")).toBe(
      "first paragraph"
    )
  })

  it("extractSummary joins multi-line summary paragraphs", () => {
    expect(__TESTING__.extractSummary("# Title\n\nline one\nline two\n\n## next")).toBe(
      "line one line two"
    )
  })

  it("splitIntoSections returns one section per H2 heading", () => {
    const sections = __TESTING__.splitIntoSections(SAMPLE_BODY)
    expect(sections.map((s) => s.headingPath[0])).toEqual(["What it does", "Public API"])
  })

  it("splitIntoSections produces sequential indices", () => {
    const sections = __TESTING__.splitIntoSections(SAMPLE_BODY)
    expect(sections.map((s) => s.sectionIndex)).toEqual([0, 1])
  })

  it("renderArticleBody writes H1 + summary + per-section H2", () => {
    const body = __TESTING__.renderArticleBody("title", "summary line", [
      { sectionIndex: 0, headingPath: ["A"], bodyMd: "a body", sourceRefs: [] },
      { sectionIndex: 1, headingPath: ["B"], bodyMd: "", sourceRefs: [] },
    ])
    expect(body).toContain("# title")
    expect(body).toContain("summary line")
    expect(body).toContain("## A")
    expect(body).toContain("a body")
    expect(body).toContain("## B")
  })
})
