import { docsHref, resolveLink, routeHref, splitHash } from "./links"

const DOCS = "https://docs.cognia.example"

describe("splitHash", () => {
  it("returns the whole route when there is no fragment", () => {
    expect(splitHash("/product")).toEqual({ path: "/product", hash: "" })
  })

  it("separates a fragment from the path", () => {
    expect(splitHash("/product#chat")).toEqual({ path: "/product", hash: "#chat" })
  })

  it("treats a bare fragment as the site root", () => {
    expect(splitHash("#top")).toEqual({ path: "/", hash: "#top" })
  })
})

describe("routeHref", () => {
  it("leaves English routes unprefixed", () => {
    expect(routeHref("en", "/trust")).toBe("/trust")
  })

  it("prefixes Chinese routes", () => {
    expect(routeHref("zh", "/trust")).toBe("/zh/trust")
  })

  it("keeps the fragment after the locale prefix, not inside the path", () => {
    expect(routeHref("zh", "/product#chat")).toBe("/zh/product#chat")
    expect(routeHref("en", "/product#chat")).toBe("/product#chat")
  })

  it("handles the homepage in both locales", () => {
    expect(routeHref("en", "/")).toBe("/")
    expect(routeHref("zh", "/")).toBe("/zh")
  })
})

describe("docsHref", () => {
  it("always writes the docs locale prefix, which that site never hides", () => {
    expect(docsHref(DOCS, "en", "/docs/core/architecture")).toBe(
      "https://docs.cognia.example/en/docs/core/architecture"
    )
    expect(docsHref(DOCS, "zh", "/docs/core/architecture")).toBe(
      "https://docs.cognia.example/zh/docs/core/architecture"
    )
  })

  it("tolerates a path without a leading slash", () => {
    expect(docsHref(DOCS, "en", "docs")).toBe("https://docs.cognia.example/en/docs")
  })
})

describe("resolveLink", () => {
  it("marks an absolute URL external", () => {
    expect(resolveLink({ label: "Source", href: "https://github.com/x/y" }, "en", DOCS)).toEqual({
      href: "https://github.com/x/y",
      external: true,
    })
  })

  it("marks a docs path external — the docs site is another hostname", () => {
    expect(resolveLink({ label: "Docs", docsPath: "/docs" }, "zh", DOCS)).toEqual({
      href: "https://docs.cognia.example/zh/docs",
      external: true,
    })
  })

  it("keeps a site route internal and localised", () => {
    expect(resolveLink({ label: "Trust", route: "/trust" }, "zh", DOCS)).toEqual({
      href: "/zh/trust",
      external: false,
    })
  })

  it("prefers an explicit external URL over the other fields", () => {
    const resolved = resolveLink(
      { label: "Source", href: "https://github.com/x/y", route: "/trust" },
      "en",
      DOCS
    )
    expect(resolved.href).toBe("https://github.com/x/y")
  })

  it("throws on a destination-less target rather than rendering a dead anchor", () => {
    expect(() => resolveLink({ label: "Roadmap" }, "en", DOCS)).toThrow(/no destination/)
  })
})
