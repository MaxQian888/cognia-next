/** @jest-environment jsdom */
/**
 * End-to-end coverage for `lib/wiki/orchestrator.ts` — the wiki rebuild
 * driver.
 *
 * Uses a fully in-memory `FileSystem` plus a deterministic mock `LlmClient`
 * so the entire pipeline (walk → merkle → chunk → agents → Dexie write)
 * runs without filesystem or network deps.
 */

import "fake-indexeddb/auto"
import { __TESTING__, ZERO_EMBEDDING, rebuildWiki, type FileSystem } from "./orchestrator"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import {
  countWikiArticlesByScope,
  getWikiArticleBySlug,
  listWikiArticlesByScope,
} from "@/lib/db/wiki-articles"
import { listWikiSectionsByArticle } from "@/lib/db/wiki-sections"
import { getWikiManifest } from "@/lib/db/wiki-manifest"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

class InMemoryFs implements FileSystem {
  private files = new Map<string, string>()

  set(path: string, content: string): this {
    this.files.set(path, content)
    return this
  }

  remove(path: string): this {
    this.files.delete(path)
    return this
  }

  async walk(): Promise<string[]> {
    return Array.from(this.files.keys())
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path)
    if (content === undefined) throw new Error(`InMemoryFs: missing ${path}`)
    return content
  }
}

const FAKE_ARTICLE_BODY = [
  "# Module Title",
  "",
  "Generated summary paragraph for tests.",
  "",
  "## What it does",
  "- bullet a",
  "- bullet b",
].join("\n")

const FAKE_INDEX_BODY = "# Cognia code wiki\n\nIndex page summary.\n"

function makeStubLlm(overrides?: { onPrompt?: (prompt: string) => string }): LlmClient {
  return {
    async complete(prompt) {
      if (overrides?.onPrompt) return overrides.onPrompt(prompt)
      // Index-page prompts mention "Cognia code wiki" — distinguish them so
      // the body shape matches the agent's parser expectations.
      if (prompt.includes("Output a Markdown page")) return FAKE_INDEX_BODY
      return FAKE_ARTICLE_BODY
    },
  }
}

describe("rebuildWiki — first build", () => {
  it("walks, filters, chunks, and writes one article per module", async () => {
    const fs = new InMemoryFs()
      .set("lib/foo/index.ts", "export const foo = 1\n".repeat(20))
      .set("lib/bar/index.ts", "export const bar = 2\n".repeat(20))
      .set("docs/skip.md", "should be filtered")
      .set("lib/foo/index.test.ts", "should be filtered")
    const llm = makeStubLlm()
    const result = await rebuildWiki(
      { fs, llm },
      { scope: "cognia-self", rootDir: ".", generatorVersion: "v1" }
    )
    expect(result.added).toBeGreaterThanOrEqual(2)
    expect(result.errors).toEqual([])
    expect(result.articles).toHaveLength(2)
    expect(result.indexPage?.contentMd).toContain("Cognia code wiki")
    expect(await countWikiArticlesByScope("cognia-self")).toBe(2)
  })

  it("persists sections separately and back-fills sectionIds on the article", async () => {
    const fs = new InMemoryFs().set("lib/foo/index.ts", "export const x = 1")
    await rebuildWiki(
      { fs, llm: makeStubLlm() },
      { scope: "cognia-self", rootDir: ".", generatorVersion: "v1" }
    )
    const article = await getWikiArticleBySlug("lib-foo")
    expect(article).toBeDefined()
    expect(article?.sectionIds.length).toBeGreaterThan(0)
    const sections = await listWikiSectionsByArticle(article!.id)
    expect(sections).toHaveLength(article!.sectionIds.length)
  })

  it("upserts the manifest with the file hashes from this build", async () => {
    const fs = new InMemoryFs().set("lib/foo/index.ts", "export const x = 1")
    await rebuildWiki(
      { fs, llm: makeStubLlm() },
      { scope: "cognia-self", rootDir: ".", generatorVersion: "v1" }
    )
    const manifest = await getWikiManifest("cognia-self")
    expect(manifest).toBeDefined()
    expect(manifest?.fileHashes["lib/foo/index.ts"]).toBeTruthy()
    expect(manifest?.generatorVersion).toBe("v1")
    expect(manifest?.lastBuildAt).toBeGreaterThan(0)
  })

  it("uses an embed function when provided", async () => {
    const fs = new InMemoryFs().set("lib/foo/index.ts", "export const x = 1")
    const embedCalls: string[] = []
    const embed = async (text: string) => {
      embedCalls.push(text)
      return [0.1, 0.2]
    }
    await rebuildWiki(
      { fs, llm: makeStubLlm(), embed },
      { scope: "cognia-self", rootDir: ".", generatorVersion: "v1" }
    )
    expect(embedCalls.length).toBeGreaterThan(0)
    const article = await getWikiArticleBySlug("lib-foo")
    expect(article?.embedding).toEqual([0.1, 0.2])
  })

  it("falls back to a stub embedding when none is provided", async () => {
    const fs = new InMemoryFs().set("lib/foo/index.ts", "export const x = 1")
    await rebuildWiki(
      { fs, llm: makeStubLlm() },
      { scope: "cognia-self", rootDir: ".", generatorVersion: "v1" }
    )
    const article = await getWikiArticleBySlug("lib-foo")
    expect(article?.embedding).toEqual(ZERO_EMBEDDING)
  })

  it("collects per-module LLM errors without aborting the run", async () => {
    const fs = new InMemoryFs().set("lib/foo/index.ts", "ok").set("lib/bar/index.ts", "kaboom")
    const llm: LlmClient = {
      async complete(prompt) {
        if (prompt.includes("`lib/bar`")) throw new Error("LLM down for bar")
        if (prompt.includes("Output a Markdown page")) return FAKE_INDEX_BODY
        return FAKE_ARTICLE_BODY
      },
    }
    const result = await rebuildWiki(
      { fs, llm },
      { scope: "cognia-self", rootDir: ".", generatorVersion: "v1" }
    )
    expect(result.articles).toHaveLength(1)
    expect(result.errors).toEqual([{ module: "lib/bar", message: "LLM down for bar" }])
  })
})

describe("rebuildWiki — incremental refresh", () => {
  it("skips unchanged files on a re-run", async () => {
    const fs = new InMemoryFs().set("lib/foo/index.ts", "export const x = 1")
    let llmCalls = 0
    const llm: LlmClient = {
      async complete(prompt) {
        llmCalls++
        if (prompt.includes("Output a Markdown page")) return FAKE_INDEX_BODY
        return FAKE_ARTICLE_BODY
      },
    }
    await rebuildWiki({ fs, llm }, { scope: "cognia-self", rootDir: ".", generatorVersion: "v1" })
    const callsAfterFirst = llmCalls

    const second = await rebuildWiki(
      { fs, llm },
      { scope: "cognia-self", rootDir: ".", generatorVersion: "v1" }
    )
    // Second run touches no module → no ModuleArticleAgent calls. The
    // IndexPageAgent only runs when there are drafts, so total should be
    // exactly the first-run count.
    expect(llmCalls).toBe(callsAfterFirst)
    expect(second.unchanged).toBeGreaterThan(0)
    expect(second.added).toBe(0)
    expect(second.changed).toBe(0)
    expect(second.articles).toHaveLength(0)
  })

  it("re-processes changed files and overwrites their article", async () => {
    const fs = new InMemoryFs().set("lib/foo/index.ts", "export const x = 1")
    await rebuildWiki(
      { fs, llm: makeStubLlm() },
      { scope: "cognia-self", rootDir: ".", generatorVersion: "v1" }
    )
    fs.set("lib/foo/index.ts", "export const x = 2 // changed")

    const result = await rebuildWiki(
      { fs, llm: makeStubLlm() },
      { scope: "cognia-self", rootDir: ".", generatorVersion: "v1" }
    )
    expect(result.changed).toBe(1)
    expect(result.articles).toHaveLength(1)
  })

  it("force=true re-processes everything regardless of manifest", async () => {
    const fs = new InMemoryFs().set("lib/foo/index.ts", "ok").set("lib/bar/index.ts", "ok")
    await rebuildWiki(
      { fs, llm: makeStubLlm() },
      { scope: "cognia-self", rootDir: ".", generatorVersion: "v1" }
    )
    expect(await countWikiArticlesByScope("cognia-self")).toBe(2)

    const result = await rebuildWiki(
      { fs, llm: makeStubLlm() },
      { scope: "cognia-self", rootDir: ".", generatorVersion: "v1", force: true }
    )
    expect(result.articles).toHaveLength(2)
    expect(await countWikiArticlesByScope("cognia-self")).toBe(2)
  })

  it("force=true on a generator-version bump invalidates the prior set", async () => {
    const fs = new InMemoryFs().set("lib/foo/index.ts", "ok")
    await rebuildWiki(
      { fs, llm: makeStubLlm() },
      { scope: "cognia-self", rootDir: ".", generatorVersion: "v1" }
    )
    const before = await listWikiArticlesByScope("cognia-self")
    expect(before).toHaveLength(1)
    expect(before[0].generatorVersion).toBe("v1")

    await rebuildWiki(
      { fs, llm: makeStubLlm() },
      { scope: "cognia-self", rootDir: ".", generatorVersion: "v2", force: true }
    )
    const after = await listWikiArticlesByScope("cognia-self")
    expect(after).toHaveLength(1)
    expect(after[0].generatorVersion).toBe("v2")
  })
})

describe("internal helpers", () => {
  it("parentDir returns the file's parent directory", () => {
    expect(__TESTING__.parentDir("lib/twin/ingest/chunk.ts")).toBe("lib/twin/ingest")
    expect(__TESTING__.parentDir("lib/utils.ts")).toBe("lib")
    expect(__TESTING__.parentDir("foo.ts")).toBe("")
    expect(__TESTING__.parentDir("lib\\twin\\chunk.ts")).toBe("lib/twin")
  })

  it("lineNumberAt counts newlines up to the offset", () => {
    const text = "line one\nline two\nline three"
    expect(__TESTING__.lineNumberAt(text, 0)).toBe(1)
    expect(__TESTING__.lineNumberAt(text, 9)).toBe(2)
    expect(__TESTING__.lineNumberAt(text, 100)).toBe(3)
    expect(__TESTING__.lineNumberAt("", 0)).toBe(1)
  })

  it("pickFileHashes restricts to the requested paths", () => {
    const all = { "a.ts": "h1", "b.ts": "h2", "c.ts": "h3" }
    expect(__TESTING__.pickFileHashes(["a.ts", "c.ts"], all)).toEqual({
      "a.ts": "h1",
      "c.ts": "h3",
    })
  })

  it("dedupeSourceRefs collapses identical file+range entries", () => {
    const refs = [
      { filePath: "a.ts", lineStart: 1, lineEnd: 5, sha: "h" },
      { filePath: "a.ts", lineStart: 1, lineEnd: 5, sha: "h" },
      { filePath: "b.ts", lineStart: 1, lineEnd: 5, sha: "h" },
    ]
    expect(__TESTING__.dedupeSourceRefs(refs)).toHaveLength(2)
  })

  it("sliceFileToChunks produces chunks tagged with module + lines + hash", () => {
    const chunks = __TESTING__.sliceFileToChunks("lib/foo/index.ts", "line1\nline2\nline3\n", "abc")
    expect(chunks.length).toBeGreaterThan(0)
    const first = chunks[0]
    expect(first.module).toBe("lib/foo")
    expect(first.fileHash).toBe("abc")
    expect(first.lineStart).toBeGreaterThanOrEqual(1)
    expect(first.lineEnd).toBeGreaterThanOrEqual(first.lineStart)
  })

  it("DEFAULT constants are sane", () => {
    expect(__TESTING__.DEFAULT_MODULE_TOKEN_BUDGET).toBeGreaterThan(1000)
    expect(__TESTING__.DEFAULT_FILE_TOKEN_BUDGET_PER_CHUNK).toBeGreaterThan(100)
  })
})
