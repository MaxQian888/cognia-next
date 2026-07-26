import { docsSourcePath } from "./last-modified"

describe("docsSourcePath", () => {
  it("anchors a localized page under the content root", () => {
    expect(docsSourcePath("en/getting-started.mdx")).toBe(
      "docs/content/docs/en/getting-started.mdx"
    )
  })

  it("keeps the extension fumadocs reported instead of assuming .mdx", () => {
    expect(docsSourcePath("en/adr/0001-backup-schema-v3.md")).toBe(
      "docs/content/docs/en/adr/0001-backup-schema-v3.md"
    )
  })

  it("resolves locale-shared pages, which have no language segment", () => {
    // `content/docs/plugin-dev/` is shared across locales; rebuilding this
    // path from `lang + slug` used to point at a file that doesn't exist.
    expect(docsSourcePath("plugin-dev/api-overview.mdx")).toBe(
      "docs/content/docs/plugin-dev/api-overview.mdx"
    )
  })

  it("resolves the root index page", () => {
    expect(docsSourcePath("index.mdx")).toBe("docs/content/docs/index.mdx")
  })
})
