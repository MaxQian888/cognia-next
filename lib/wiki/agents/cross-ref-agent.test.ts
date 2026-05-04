/**
 * Coverage for `CrossRefAgent` — pure markdown rewrite + link validation.
 */

import { applyCrossRefs, buildSlugIndex, findDeadLinks } from "./cross-ref-agent"

const SLUGS = buildSlugIndex([
  { module: "lib/twin/ingest", slug: "lib-twin-ingest" },
  { module: "lib/twin/distill", slug: "lib-twin-distill" },
  { module: "lib/wiki", slug: "lib-wiki" },
])

describe("buildSlugIndex", () => {
  it("indexes by module path", () => {
    expect(SLUGS.bySlug.get("lib/twin/ingest")).toBe("lib-twin-ingest")
    expect(SLUGS.bySlug.get("lib/wiki")).toBe("lib-wiki")
    expect(SLUGS.bySlug.get("lib/missing")).toBeUndefined()
  })
})

describe("applyCrossRefs", () => {
  it("rewrites backtick-wrapped module mentions to [[slug]] links", () => {
    const body = "uses `lib/twin/ingest` for chunking."
    const result = applyCrossRefs(body, SLUGS)
    expect(result.body).toBe("uses [[lib-twin-ingest]] for chunking.")
    expect(result.linkedSlugs).toEqual(["lib-twin-ingest"])
  })

  it("strips file extensions before slug lookup", () => {
    const body = "see `lib/wiki/orchestrator.ts`"
    const result = applyCrossRefs(body, SLUGS)
    expect(result.body).toBe("see [[lib-wiki]]")
    expect(result.linkedSlugs).toEqual(["lib-wiki"])
  })

  it("walks up parent dirs to find a matching slug", () => {
    const body = "deep file: `lib/twin/distill/agents/wiki-agent.ts`"
    const result = applyCrossRefs(body, SLUGS)
    expect(result.body).toBe("deep file: [[lib-twin-distill]]")
  })

  it("leaves unrecognized mentions untouched", () => {
    const body = "see `lib/nonexistent/foo`"
    const result = applyCrossRefs(body, SLUGS)
    expect(result.body).toContain("`lib/nonexistent/foo`")
    expect(result.linkedSlugs).toEqual([])
  })

  it("does not rewrite inside ``` code fences", () => {
    const body = [
      "intro `lib/wiki`.",
      "```ts",
      'import x from "lib/wiki/orchestrator"',
      "```",
      "outro `lib/twin/ingest`.",
    ].join("\n")
    const result = applyCrossRefs(body, SLUGS)
    expect(result.body).toContain("intro [[lib-wiki]]")
    expect(result.body).toContain("outro [[lib-twin-ingest]]")
    expect(result.body).toContain('import x from "lib/wiki/orchestrator"')
  })

  it("dedupes linked slugs in the result", () => {
    const body = "`lib/wiki` and again `lib/wiki/orchestrator.ts`"
    const result = applyCrossRefs(body, SLUGS)
    expect(result.linkedSlugs).toEqual(["lib-wiki"])
  })

  it("ignores non-included roots like docs/", () => {
    const body = "see `docs/foo` and `lib/wiki`"
    const result = applyCrossRefs(body, SLUGS)
    expect(result.body).toContain("`docs/foo`")
    expect(result.body).toContain("[[lib-wiki]]")
  })
})

describe("findDeadLinks", () => {
  it("returns empty when every slug resolves", () => {
    expect(
      findDeadLinks("see [[lib-wiki]] and [[lib-twin-ingest]]", ["lib-wiki", "lib-twin-ingest"])
    ).toEqual([])
  })

  it("flags unresolved slugs", () => {
    expect(findDeadLinks("[[lib-wiki]] [[ghost]]", ["lib-wiki"])).toEqual(["ghost"])
  })

  it("dedupes repeated dead links", () => {
    expect(findDeadLinks("[[ghost]] then [[ghost]] again", [])).toEqual(["ghost"])
  })

  it("returns sorted output", () => {
    expect(findDeadLinks("[[zebra]] [[apple]]", [])).toEqual(["apple", "zebra"])
  })
})
