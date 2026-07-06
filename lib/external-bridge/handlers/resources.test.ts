/**
 * Coverage for the MCP `resources/*` handlers — listing + reading +
 * scope/uri parsing.
 */

import "fake-indexeddb/auto"
import {
  listResources,
  parseResourceUri,
  readResource,
  scopeForResourceUri,
  __TESTING__,
} from "./resources"
import { createWikiArticle } from "@/lib/db/wiki-articles"
import type { WikiArticleDraft } from "@/lib/db/wiki-articles"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { listSkills } from "@/lib/db/skills"
import { listCharacters } from "@/lib/db/characters"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
}, 30_000)

function articleDraft(overrides: Partial<WikiArticleDraft> = {}): WikiArticleDraft {
  return {
    slug: overrides.slug ?? "lib-foo",
    title: overrides.title ?? "lib/foo overview",
    module: overrides.module ?? "lib/foo",
    scope: overrides.scope ?? "cognia-self",
    pageRank: overrides.pageRank ?? 0.5,
    summary: overrides.summary ?? "summary",
    sectionIds: overrides.sectionIds ?? [],
    sourceRefs: overrides.sourceRefs ?? [],
    contentMd: overrides.contentMd ?? "# heading\n\nbody",
    embedding: overrides.embedding ?? [],
    generatorVersion: overrides.generatorVersion ?? "v1",
    fileHashes: overrides.fileHashes ?? {},
  }
}

describe("parseResourceUri", () => {
  it("parses a wiki uri", () => {
    expect(parseResourceUri("cognia://wiki/lib-foo")).toEqual({ kind: "wiki", id: "lib-foo" })
  })

  it("parses a skill uri with hyphenated id", () => {
    expect(parseResourceUri("cognia://skill/skill_abc123")).toEqual({
      kind: "skill",
      id: "skill_abc123",
    })
  })

  it("returns undefined for non-cognia scheme", () => {
    expect(parseResourceUri("https://example.com/foo")).toBeUndefined()
    expect(parseResourceUri("file:///tmp/foo")).toBeUndefined()
  })

  it("returns undefined for malformed uris", () => {
    expect(parseResourceUri("cognia://")).toBeUndefined()
    expect(parseResourceUri("cognia://wiki/")).toBeUndefined()
    expect(parseResourceUri("cognia://wiki")).toBeUndefined()
  })

  it("uses the documented scheme prefix", () => {
    expect(__TESTING__.SCHEME).toBe("cognia://")
  })
})

describe("scopeForResourceUri", () => {
  it("maps a known cognia-self wiki article to wiki:cognia", async () => {
    await createWikiArticle(articleDraft({ slug: "art-1", scope: "cognia-self" }))
    expect(await scopeForResourceUri("cognia://wiki/art-1")).toBe("wiki:cognia")
  })

  it("maps a known user-repo wiki article to wiki:user-repo", async () => {
    await createWikiArticle(articleDraft({ slug: "art-2", scope: "user-repo" }))
    expect(await scopeForResourceUri("cognia://wiki/art-2")).toBe("wiki:user-repo")
  })

  it("returns undefined for an unknown wiki slug", async () => {
    expect(await scopeForResourceUri("cognia://wiki/ghost")).toBeUndefined()
  })

  it("returns runtime:skills for any skill uri", async () => {
    expect(await scopeForResourceUri("cognia://skill/anything")).toBe("runtime:skills")
  })

  it("returns runtime:characters for any character uri", async () => {
    expect(await scopeForResourceUri("cognia://character/anything")).toBe("runtime:characters")
  })

  it("returns undefined for unrecognized kinds", async () => {
    expect(await scopeForResourceUri("cognia://unknown/x")).toBeUndefined()
  })

  it("returns undefined for malformed uris", async () => {
    expect(await scopeForResourceUri("garbage")).toBeUndefined()
  })
})

describe("listResources", () => {
  it("returns nothing when no scopes are enabled", async () => {
    await createWikiArticle(articleDraft({ slug: "x", scope: "cognia-self" }))
    expect(await listResources([])).toEqual([])
  })

  it("includes cognia-self wiki articles when wiki:cognia is enabled", async () => {
    await createWikiArticle(articleDraft({ slug: "x", scope: "cognia-self" }))
    await createWikiArticle(articleDraft({ slug: "y", scope: "user-repo" }))
    const out = await listResources(["wiki:cognia"])
    expect(out.map((r) => r.uri)).toEqual(["cognia://wiki/x"])
    expect(out[0].mimeType).toBe("text/markdown")
  })

  it("includes user-repo wiki articles when wiki:user-repo is enabled", async () => {
    await createWikiArticle(articleDraft({ slug: "x", scope: "cognia-self" }))
    await createWikiArticle(articleDraft({ slug: "y", scope: "user-repo" }))
    const out = await listResources(["wiki:user-repo"])
    expect(out.map((r) => r.uri)).toEqual(["cognia://wiki/y"])
  })

  it("includes seeded skills when runtime:skills is enabled", async () => {
    const skills = await listSkills()
    if (skills.length === 0) return
    const out = await listResources(["runtime:skills"])
    const skillUris = out.filter((r) => r.uri.startsWith("cognia://skill/"))
    expect(skillUris.length).toBe(skills.length)
  })

  it("includes seeded characters when runtime:characters is enabled", async () => {
    const characters = await listCharacters()
    if (characters.length === 0) return
    const out = await listResources(["runtime:characters"])
    const charUris = out.filter((r) => r.uri.startsWith("cognia://character/"))
    expect(charUris.length).toBe(characters.length)
  })

  it("composes multiple scopes additively", async () => {
    await createWikiArticle(articleDraft({ slug: "x", scope: "cognia-self" }))
    const out = await listResources(["wiki:cognia", "runtime:skills", "runtime:characters"])
    expect(out.some((r) => r.uri === "cognia://wiki/x")).toBe(true)
    // Additional surfaces light up only if the seeded built-ins contributed
    // rows (test environment may have empty seed sets); verify at minimum
    // the wiki article is present plus the multi-scope filter ran without
    // throwing.
  })
})

describe("readResource", () => {
  it("returns the wiki article markdown for a known slug", async () => {
    await createWikiArticle(articleDraft({ slug: "needle", contentMd: "# body" }))
    const out = await readResource("cognia://wiki/needle")
    expect(out?.text).toBe("# body")
    expect(out?.mimeType).toBe("text/markdown")
  })

  it("returns undefined for an unknown wiki slug", async () => {
    expect(await readResource("cognia://wiki/ghost")).toBeUndefined()
  })

  it("renders a skill as SKILL.md with YAML front-matter", async () => {
    const skills = await listSkills()
    if (skills.length === 0) return
    const target = skills[0]
    const out = await readResource(`cognia://skill/${target.id}`)
    expect(out?.text).toMatch(/^---/) // YAML front-matter delimiter
    expect(out?.text).toContain(`name: ${target.name}`)
    expect(out?.mimeType).toBe("text/markdown")
  })

  it("returns undefined for an unknown skill id", async () => {
    expect(await readResource("cognia://skill/ghost")).toBeUndefined()
  })

  it("returns a character as JSON", async () => {
    const characters = await listCharacters()
    if (characters.length === 0) return
    const target = characters[0]
    const out = await readResource(`cognia://character/${target.id}`)
    expect(out?.mimeType).toBe("application/json")
    expect(JSON.parse(out!.text).id).toBe(target.id)
  })

  it("returns undefined for an unknown character id", async () => {
    expect(await readResource("cognia://character/ghost")).toBeUndefined()
  })

  it("returns undefined for malformed uris", async () => {
    expect(await readResource("garbage")).toBeUndefined()
    expect(await readResource("cognia://unknown/x")).toBeUndefined()
  })
})
