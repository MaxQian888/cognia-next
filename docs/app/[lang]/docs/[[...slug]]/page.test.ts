import { readFileSync } from "node:fs"
import { join } from "node:path"

const source = readFileSync(join(__dirname, "page.tsx"), "utf8")

describe("docs page chrome", () => {
  it("mounts the page footer with build-time git metadata", () => {
    expect(source).toContain("getDocsLastModified(page.path)")
    expect(source).toContain(
      "<PageFooter slug={footerSlug} sourcePath={sourcePath} lastModified={lastModified} />"
    )
  })

  it("resolves the source path from fumadocs rather than lang + slug", () => {
    // Locale-shared pages (content/docs/plugin-dev/**) have no language
    // segment, so a reconstructed path points at a file that doesn't exist.
    expect(source).toContain("docsSourcePath(page.path)")
  })
})

describe("docs page metadata", () => {
  it("emits a canonical URL and cross-locale alternates", () => {
    expect(source).toContain("alternates: metadataAlternates(canonical, slug)")
  })

  it("emits OpenGraph and Twitter cards", () => {
    expect(source).toContain("openGraph:")
    expect(source).toContain("twitter:")
  })
})
