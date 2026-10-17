import { readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * The landing page itself is covered by `components/home-page.test.tsx` and
 * `lib/home-sections.test.ts`; rendering this server route would pull
 * fumadocs' ESM-only layout into Jest. What is pinned here is the contract
 * around it: it is a page, not a redirect, and static hosting still routes the
 * bare roots to a locale.
 */
describe("docs landing route", () => {
  const source = readFileSync(resolve(__dirname, "page.tsx"), "utf8")

  it("renders a landing page instead of redirecting into the docs", () => {
    expect(source).not.toMatch(/\bredirect\(/)
    expect(source).toMatch(/<HomeLayout\b/)
    expect(source).toMatch(/<HomePage\b/)
  })

  it("puts the docs in the landing page's own navigation", () => {
    expect(source).toMatch(/links=\{\[\{ text: homeCopy\(lang\)\.navDocs, url: overviewHref/)
  })

  it("derives the area index from the page tree", () => {
    expect(source).toMatch(/homeGroups\(tree\)/)
  })

  it("routes the bare roots to the default locale on static hosting", () => {
    const redirects = readFileSync(resolve(__dirname, "../../public/_redirects"), "utf8")
    const lines = redirects.split("\n")

    expect(lines).toContain("/ /zh/ 302")
    expect(lines).toContain("/docs /zh/docs 302")
  })
})
