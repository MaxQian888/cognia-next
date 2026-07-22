import { docsSourceCandidates } from "./last-modified"

describe("docsSourceCandidates", () => {
  it("prefers MDX pages and retains a Markdown fallback", () => {
    expect(docsSourceCandidates("en", ["getting-started"])).toEqual([
      "docs/content/docs/en/getting-started.mdx",
      "docs/content/docs/en/getting-started.md",
    ])
  })

  it("builds candidates for nested Markdown pages", () => {
    expect(docsSourceCandidates("en", ["adr", "0001-backup-schema-v3"])).toContain(
      "docs/content/docs/en/adr/0001-backup-schema-v3.md"
    )
  })

  it("uses the locale index when the slug is empty", () => {
    expect(docsSourceCandidates("zh", undefined)[0]).toBe("docs/content/docs/zh/index.mdx")
  })
})
