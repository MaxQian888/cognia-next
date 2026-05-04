/**
 * Coverage for the wiki prompt builders. We don't assert on the exact
 * string shape (LLM-friendly prose evolves) — instead we verify the
 * load-bearing fragments survive: every chunk is included in the module
 * prompt, every article shows up in the index prompt, and the system
 * voice contains the no-go list.
 */

import { indexPagePrompt, moduleArticlePrompt, WIKI_SYSTEM_VOICE } from "./prompts"
import type { CodeChunk, ModuleStat } from "./types"

describe("WIKI_SYSTEM_VOICE", () => {
  it("identifies the audience as downstream LLM coding agents", () => {
    expect(WIKI_SYSTEM_VOICE).toMatch(/coding agents/i)
  })

  it("forbids meta-commentary and invented APIs", () => {
    expect(WIKI_SYSTEM_VOICE).toMatch(/no apologies/i)
    expect(WIKI_SYSTEM_VOICE).toMatch(/do not invent/i)
  })
})

function makeChunk(overrides: Partial<CodeChunk> = {}): CodeChunk {
  return {
    id: overrides.id ?? "c1",
    filePath: overrides.filePath ?? "lib/foo/index.ts",
    module: overrides.module ?? "lib/foo",
    lineStart: overrides.lineStart ?? 1,
    lineEnd: overrides.lineEnd ?? 10,
    tokenCount: overrides.tokenCount ?? 50,
    content: overrides.content ?? "export function foo() {}",
    fileHash: overrides.fileHash ?? "h_abc",
  }
}

function makeStat(overrides: Partial<ModuleStat> = {}): ModuleStat {
  return {
    module: overrides.module ?? "lib/foo",
    filePaths: overrides.filePaths ?? ["lib/foo/index.ts"],
    totalLines: overrides.totalLines ?? 10,
    totalTokens: overrides.totalTokens ?? 50,
    pageRank: overrides.pageRank ?? 0.5,
  }
}

describe("moduleArticlePrompt", () => {
  it("includes the module identifier", () => {
    const out = moduleArticlePrompt({ module: "lib/foo", stat: makeStat(), chunks: [] })
    expect(out).toContain("`lib/foo`")
  })

  it("lists every file from the stat", () => {
    const out = moduleArticlePrompt({
      module: "lib/foo",
      stat: makeStat({ filePaths: ["lib/foo/a.ts", "lib/foo/b.ts"] }),
      chunks: [],
    })
    expect(out).toContain("lib/foo/a.ts")
    expect(out).toContain("lib/foo/b.ts")
  })

  it("includes every chunk's content with file/line citation", () => {
    const out = moduleArticlePrompt({
      module: "lib/foo",
      stat: makeStat(),
      chunks: [
        makeChunk({ filePath: "lib/foo/a.ts", lineStart: 1, lineEnd: 5, content: "code A" }),
        makeChunk({ filePath: "lib/foo/b.ts", lineStart: 10, lineEnd: 20, content: "code B" }),
      ],
    })
    expect(out).toContain("lib/foo/a.ts:1-5")
    expect(out).toContain("code A")
    expect(out).toContain("lib/foo/b.ts:10-20")
    expect(out).toContain("code B")
  })

  it("ships the article skeleton with H1 + standard sections", () => {
    const out = moduleArticlePrompt({ module: "lib/foo", stat: makeStat(), chunks: [] })
    expect(out).toContain("## What it does")
    expect(out).toContain("## Public API")
    expect(out).toContain("## Internals")
    expect(out).toContain("## Related")
  })
})

describe("indexPagePrompt", () => {
  it("lists every article with slug + module + summary", () => {
    const out = indexPagePrompt({
      articles: [
        { slug: "lib-twin", module: "lib/twin", summary: "twin runtime", pageRank: 0.9 },
        { slug: "lib-wiki", module: "lib/wiki", summary: "wiki indexer", pageRank: 0.7 },
      ],
    })
    expect(out).toContain("[[lib-twin]]")
    expect(out).toContain("`lib/twin`")
    expect(out).toContain("twin runtime")
    expect(out).toContain("[[lib-wiki]]")
    expect(out).toContain("wiki indexer")
  })

  it("truncates very long summaries in the prompt to keep input bounded", () => {
    const long = "x".repeat(500)
    const out = indexPagePrompt({
      articles: [{ slug: "x", module: "x", summary: long, pageRank: 0.5 }],
    })
    // The 200-char cap kicks in.
    expect(out).not.toContain("x".repeat(500))
    expect(out).toContain("x".repeat(200))
  })

  it("includes the [[slug]] link skeleton", () => {
    const out = indexPagePrompt({ articles: [] })
    expect(out).toContain("[[slug]] link syntax")
  })
})
