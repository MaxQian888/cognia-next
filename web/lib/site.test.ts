import {
  DEV_DOCS_URL,
  DEV_SITE_URL,
  absoluteUrl,
  docsLink,
  resolveDocsUrl,
  resolveSiteUrl,
} from "./site"

describe("resolveSiteUrl", () => {
  it("prefers the explicit site URL over the Cloudflare-injected one", () => {
    expect(
      resolveSiteUrl({
        NEXT_PUBLIC_WEB_SITE_URL: "https://cognia.example",
        CF_PAGES_URL: "https://preview.pages.dev",
      })
    ).toBe("https://cognia.example")
  })

  it("falls back to the Cloudflare preview origin", () => {
    expect(resolveSiteUrl({ CF_PAGES_URL: "https://preview.pages.dev" })).toBe(
      "https://preview.pages.dev"
    )
  })

  it("falls back to the dev origin when nothing is configured", () => {
    expect(resolveSiteUrl({})).toBe(DEV_SITE_URL)
  })

  it("assumes https for a bare hostname", () => {
    expect(resolveSiteUrl({ NEXT_PUBLIC_WEB_SITE_URL: "cognia.example" })).toBe(
      "https://cognia.example"
    )
  })

  it("strips trailing slashes so callers can concatenate paths", () => {
    expect(resolveSiteUrl({ NEXT_PUBLIC_WEB_SITE_URL: "https://cognia.example///" })).toBe(
      "https://cognia.example"
    )
  })

  it("ignores whitespace-only configuration", () => {
    expect(resolveSiteUrl({ NEXT_PUBLIC_WEB_SITE_URL: "   " })).toBe(DEV_SITE_URL)
  })

  it("rejects a value that is not a URL rather than emitting malformed links", () => {
    expect(resolveSiteUrl({ NEXT_PUBLIC_WEB_SITE_URL: "http://" })).toBe(DEV_SITE_URL)
  })
})

describe("resolveDocsUrl", () => {
  it("reads the docs origin from its own variable", () => {
    expect(resolveDocsUrl({ NEXT_PUBLIC_DOCS_SITE_URL: "https://docs.cognia.example" })).toBe(
      "https://docs.cognia.example"
    )
  })

  it("does not borrow the Cloudflare origin, which belongs to the website", () => {
    expect(resolveDocsUrl({ CF_PAGES_URL: "https://preview.pages.dev" })).toBe(DEV_DOCS_URL)
  })

  it("falls back to the docs dev origin", () => {
    expect(resolveDocsUrl({})).toBe(DEV_DOCS_URL)
  })
})

describe("path joining", () => {
  const previous = process.env.NEXT_PUBLIC_WEB_SITE_URL
  const previousDocs = process.env.NEXT_PUBLIC_DOCS_SITE_URL

  beforeAll(() => {
    process.env.NEXT_PUBLIC_WEB_SITE_URL = "https://cognia.example"
    process.env.NEXT_PUBLIC_DOCS_SITE_URL = "https://docs.cognia.example"
  })

  afterAll(() => {
    process.env.NEXT_PUBLIC_WEB_SITE_URL = previous
    process.env.NEXT_PUBLIC_DOCS_SITE_URL = previousDocs
  })

  it("joins an absolute path", () => {
    expect(absoluteUrl("/zh/trust")).toBe("https://cognia.example/zh/trust")
  })

  it("tolerates a path without a leading slash", () => {
    expect(absoluteUrl("trust")).toBe("https://cognia.example/trust")
  })

  it("joins docs paths onto the docs origin", () => {
    expect(docsLink("/en/docs")).toBe("https://docs.cognia.example/en/docs")
  })
})
