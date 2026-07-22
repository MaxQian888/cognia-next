import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("docs page chrome", () => {
  it("mounts the page footer with build-time git metadata", () => {
    const source = readFileSync(join(__dirname, "page.tsx"), "utf8")
    expect(source).toContain("getDocsLastModified(lang, slug)")
    expect(source).toContain("<PageFooter slug={footerSlug} lastModified={lastModified} />")
  })
})
