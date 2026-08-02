/** @jest-environment jsdom */
/**
 * Coverage for the wiki Markdown exporter — round-trip articles to a
 * fake-fs and verify the rendered MDX shape + idempotency.
 */

import "fake-indexeddb/auto"
import {
  __TESTING__,
  exportWikiToMarkdown,
  renderArticleMdx,
  renderIndexMdx,
  type WriteFs,
} from "./exporter"
import { createWikiArticle } from "@/lib/db/wiki-articles"
import { SELF_CORPUS_ID } from "@/types/wiki"
import type { WikiArticleDraft } from "@/lib/db/wiki-articles"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { WikiArticle } from "@/types/wiki"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

class InMemoryWriteFs implements WriteFs {
  files = new Map<string, string>()
  dirs = new Set<string>()
  async mkdirp(path: string): Promise<void> {
    this.dirs.add(path)
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content)
  }
}

function articleDraft(overrides: Partial<WikiArticleDraft> = {}): WikiArticleDraft {
  return {
    slug: overrides.slug ?? "lib-foo",
    title: overrides.title ?? "lib/foo overview",
    module: overrides.module ?? "lib/foo",
    scope: overrides.scope ?? "cognia-self",
    corpusId: overrides.corpusId ?? SELF_CORPUS_ID,
    pageRank: overrides.pageRank ?? 0.5,
    summary: overrides.summary ?? "summary text",
    sectionIds: overrides.sectionIds ?? [],
    sourceRefs: overrides.sourceRefs ?? [
      { filePath: "lib/foo/index.ts", lineStart: 1, lineEnd: 10, sha: "h" },
    ],
    contentMd: overrides.contentMd ?? "# lib/foo\n\nbody",
    embedding: overrides.embedding ?? [],
    generatorVersion: overrides.generatorVersion ?? "v1",
    fileHashes: overrides.fileHashes ?? {},
  }
}

describe("exportWikiToMarkdown", () => {
  it("creates the scope dir + one .mdx per article + an index page", async () => {
    await createWikiArticle(articleDraft({ slug: "a" }))
    await createWikiArticle(articleDraft({ slug: "b" }))
    const fs = new InMemoryWriteFs()
    const result = await exportWikiToMarkdown(fs, {
      scope: "cognia-self",
      rootDir: "docs/content/docs/wiki",
    })
    expect(result.articlesWritten).toBe(2)
    expect(result.indexWritten).toBe(true)
    expect(fs.dirs.has("docs/content/docs/wiki/cognia-self")).toBe(true)
    expect(fs.files.has("docs/content/docs/wiki/cognia-self/a.mdx")).toBe(true)
    expect(fs.files.has("docs/content/docs/wiki/cognia-self/b.mdx")).toBe(true)
    expect(fs.files.has("docs/content/docs/wiki/cognia-self/index.mdx")).toBe(true)
  })

  it("does not write an index when no articles exist for the scope", async () => {
    const fs = new InMemoryWriteFs()
    const result = await exportWikiToMarkdown(fs, {
      scope: "user-repo",
      rootDir: "docs",
    })
    expect(result.articlesWritten).toBe(0)
    expect(result.indexWritten).toBe(false)
    expect(fs.files.size).toBe(0)
  })

  it("uses indexContentMd verbatim when supplied", async () => {
    await createWikiArticle(articleDraft({ slug: "a" }))
    const fs = new InMemoryWriteFs()
    await exportWikiToMarkdown(fs, {
      scope: "cognia-self",
      rootDir: "out",
      indexContentMd: "# Custom index page",
    })
    const indexBody = fs.files.get("out/cognia-self/index.mdx")!
    expect(indexBody).toContain("# Custom index page")
  })

  it("filters by scope (only the requested scope's articles export)", async () => {
    await createWikiArticle(articleDraft({ slug: "a", scope: "cognia-self" }))
    await createWikiArticle(articleDraft({ slug: "b", scope: "user-repo" }))
    const fs = new InMemoryWriteFs()
    await exportWikiToMarkdown(fs, { scope: "cognia-self", rootDir: "out" })
    expect(fs.files.has("out/cognia-self/a.mdx")).toBe(true)
    expect(fs.files.has("out/cognia-self/b.mdx")).toBe(false)
  })

  it("returns the touched filePaths in order", async () => {
    await createWikiArticle(articleDraft({ slug: "a" }))
    const fs = new InMemoryWriteFs()
    const result = await exportWikiToMarkdown(fs, {
      scope: "cognia-self",
      rootDir: "out",
    })
    expect(result.filePaths).toEqual(["out/cognia-self/a.mdx", "out/cognia-self/index.mdx"])
  })
})

describe("renderArticleMdx", () => {
  function art(overrides: Partial<WikiArticle> = {}): WikiArticle {
    return {
      id: "x",
      corpusId: overrides.corpusId ?? SELF_CORPUS_ID,
      slug: overrides.slug ?? "lib-foo",
      title: overrides.title ?? "lib/foo overview",
      module: overrides.module ?? "lib/foo",
      scope: overrides.scope ?? "cognia-self",
      pageRank: overrides.pageRank ?? 0.5,
      summary: overrides.summary ?? "summary",
      sectionIds: overrides.sectionIds ?? [],
      sourceRefs: overrides.sourceRefs ?? [
        { filePath: "lib/foo/index.ts", lineStart: 1, lineEnd: 5, sha: "h" },
      ],
      contentMd: overrides.contentMd ?? "# heading\n\nbody",
      embedding: overrides.embedding ?? [],
      generatedAt: overrides.generatedAt ?? 1700000000000,
      generatorVersion: overrides.generatorVersion ?? "v1",
      fileHashes: overrides.fileHashes ?? {},
    }
  }

  it("emits front-matter + body + Sources footer", () => {
    const out = renderArticleMdx(art())
    expect(out).toMatch(/^---\n/)
    expect(out).toContain("title: lib/foo overview")
    expect(out).toContain("slug: lib-foo")
    expect(out).toContain("# heading")
    expect(out).toContain("## Sources")
    expect(out).toContain("`lib/foo/index.ts:1-5`")
  })

  it("renders generatedAt as ISO-8601", () => {
    const out = renderArticleMdx(art({ generatedAt: 1700000000000 }))
    expect(out).toMatch(/generatedAt: 2023-11-14T22:13:20\.000Z/)
  })

  it("emits an empty quoted YAML scalar for empty title", () => {
    const out = renderArticleMdx(art({ title: "" }))
    expect(out).toContain('title: ""')
  })

  it("dedupes repeated sourceRefs in the Sources footer", () => {
    const out = renderArticleMdx(
      art({
        sourceRefs: [
          { filePath: "lib/foo/index.ts", lineStart: 1, lineEnd: 5, sha: "h" },
          { filePath: "lib/foo/index.ts", lineStart: 1, lineEnd: 5, sha: "h" },
          { filePath: "lib/foo/other.ts", lineStart: 1, lineEnd: 5, sha: "h" },
        ],
      })
    )
    const matches = out.match(/lib\/foo\/index\.ts:1-5/g)
    expect(matches).toHaveLength(1)
  })

  it("omits the Sources section when sourceRefs is empty", () => {
    const out = renderArticleMdx(art({ sourceRefs: [] }))
    expect(out).not.toContain("## Sources")
  })
})

describe("renderIndexMdx", () => {
  it("synthesizes a list of articles when no custom body is given", () => {
    const articles = [
      {
        id: "a",
        corpusId: SELF_CORPUS_ID,
        slug: "a",
        title: "A",
        module: "lib/a",
        scope: "cognia-self" as const,
        pageRank: 0.8,
        summary: "first",
        sectionIds: [],
        sourceRefs: [],
        contentMd: "",
        embedding: [],
        generatedAt: 0,
        generatorVersion: "v1",
        fileHashes: {},
      },
      {
        id: "b",
        corpusId: SELF_CORPUS_ID,
        slug: "b",
        title: "B",
        module: "lib/b",
        scope: "cognia-self" as const,
        pageRank: 0.2,
        summary: "second",
        sectionIds: [],
        sourceRefs: [],
        contentMd: "",
        embedding: [],
        generatedAt: 0,
        generatorVersion: "v1",
        fileHashes: {},
      },
    ]
    const out = renderIndexMdx("cognia-self", articles)
    // Higher pageRank renders first.
    const idxA = out.indexOf("[A]")
    const idxB = out.indexOf("[B]")
    expect(idxA).toBeLessThan(idxB)
    expect(out).toContain("[A](a.mdx)")
    expect(out).toContain("[B](b.mdx)")
  })
})

describe("internal helpers", () => {
  it("escapeYaml quotes special-character scalars", () => {
    expect(__TESTING__.escapeYaml("simple")).toBe("simple")
    expect(__TESTING__.escapeYaml("has: colon")).toBe('"has: colon"')
    expect(__TESTING__.escapeYaml("has [brackets]")).toBe('"has [brackets]"')
    expect(__TESTING__.escapeYaml("multi\nline")).toBe('"multi\\nline"')
    expect(__TESTING__.escapeYaml("")).toBe('""')
  })

  it("joinPath collapses trailing separators", () => {
    expect(__TESTING__.joinPath("a", "b", "c")).toBe("a/b/c")
    expect(__TESTING__.joinPath("a/", "/b/", "c")).toBe("a/b/c")
    expect(__TESTING__.joinPath("a", "")).toBe("a")
  })

  it("dedupeRefs collapses identical file+range entries", () => {
    const refs = [
      { filePath: "a.ts", lineStart: 1, lineEnd: 5, sha: "h" },
      { filePath: "a.ts", lineStart: 1, lineEnd: 5, sha: "h2" },
      { filePath: "a.ts", lineStart: 6, lineEnd: 10, sha: "h" },
    ]
    expect(__TESTING__.dedupeRefs(refs)).toHaveLength(2)
  })
})

describe("idempotency", () => {
  it("produces byte-identical files on consecutive runs", async () => {
    await createWikiArticle(articleDraft({ slug: "a", generatedAt: 1700000000000 }))
    const fs1 = new InMemoryWriteFs()
    await exportWikiToMarkdown(fs1, { scope: "cognia-self", rootDir: "out" })
    const fs2 = new InMemoryWriteFs()
    await exportWikiToMarkdown(fs2, { scope: "cognia-self", rootDir: "out" })
    expect(fs1.files.get("out/cognia-self/a.mdx")).toBe(fs2.files.get("out/cognia-self/a.mdx"))
  })
})
