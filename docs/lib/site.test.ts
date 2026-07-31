import { DEV_SITE_URL, SITE_NAME, resolveSiteUrl } from "./site"

describe("site branding", () => {
  it("uses the Cognia product name", () => {
    expect(SITE_NAME).toBe("Cognia")
  })
})

describe("resolveSiteUrl", () => {
  it("prefers the explicit override over the Cloudflare-injected URL", () => {
    expect(
      resolveSiteUrl({
        NEXT_PUBLIC_DOCS_SITE_URL: "https://docs.example.com",
        CF_PAGES_URL: "https://preview.pages.dev",
      })
    ).toBe("https://docs.example.com")
  })

  it("falls back to the Cloudflare preview URL", () => {
    expect(resolveSiteUrl({ CF_PAGES_URL: "https://preview.pages.dev" })).toBe(
      "https://preview.pages.dev"
    )
  })

  it("falls back to the dev origin when nothing is configured", () => {
    expect(resolveSiteUrl({})).toBe(DEV_SITE_URL)
  })

  it("treats blank and whitespace-only values as unset", () => {
    expect(resolveSiteUrl({ NEXT_PUBLIC_DOCS_SITE_URL: "   ", CF_PAGES_URL: "" })).toBe(
      DEV_SITE_URL
    )
  })

  it("strips trailing slashes so paths can be concatenated", () => {
    expect(resolveSiteUrl({ NEXT_PUBLIC_DOCS_SITE_URL: "https://docs.example.com///" })).toBe(
      "https://docs.example.com"
    )
  })

  it("assumes https when the origin is given without a protocol", () => {
    expect(resolveSiteUrl({ NEXT_PUBLIC_DOCS_SITE_URL: "docs.example.com" })).toBe(
      "https://docs.example.com"
    )
  })

  it("rejects values that are not URLs instead of emitting malformed links", () => {
    expect(resolveSiteUrl({ NEXT_PUBLIC_DOCS_SITE_URL: "https://" })).toBe(DEV_SITE_URL)
  })
})
