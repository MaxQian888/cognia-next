import { ROUTES } from "./locale"
import { buildMetadata, ogImagePath } from "./metadata"

const meta = { title: "Trust", description: "How to verify each claim." }

describe("buildMetadata", () => {
  const previous = process.env.NEXT_PUBLIC_WEB_SITE_URL

  beforeAll(() => {
    process.env.NEXT_PUBLIC_WEB_SITE_URL = "https://cognia.example"
  })

  afterAll(() => {
    process.env.NEXT_PUBLIC_WEB_SITE_URL = previous
  })

  it("carries the page title and description", () => {
    const result = buildMetadata("en", "/trust", meta)
    expect(result.title).toBe("Trust")
    expect(result.description).toBe(meta.description)
  })

  it("canonicalises English at the unprefixed path", () => {
    expect(buildMetadata("en", "/trust", meta).alternates?.canonical).toBe("/trust")
  })

  it("canonicalises Chinese at the prefixed path", () => {
    expect(buildMetadata("zh", "/trust", meta).alternates?.canonical).toBe("/zh/trust")
  })

  it("advertises both languages and an x-default", () => {
    const languages = buildMetadata("en", "/trust", meta).alternates?.languages
    expect(languages).toEqual({
      en: "/trust",
      "zh-Hans": "/zh/trust",
      "x-default": "/trust",
    })
  })

  it("emits an absolute OpenGraph URL, which a static export cannot infer", () => {
    const og = buildMetadata("zh", "/trust", meta).openGraph
    expect(og?.url).toBe("https://cognia.example/zh/trust")
  })

  it("declares the OpenGraph locale as a BCP-47 tag", () => {
    expect(buildMetadata("zh", "/trust", meta).openGraph?.locale).toBe("zh-Hans")
  })

  it("points at a pre-generated share image at the documented size", () => {
    const images = buildMetadata("en", "/trust", meta).openGraph?.images
    expect(images).toEqual([{ url: "/og/trust-en.png", width: 1200, height: 630, alt: "Trust" }])
  })

  it("produces metadata for every published route", () => {
    for (const route of ROUTES) {
      const result = buildMetadata("zh", route, meta)
      expect(result.alternates?.canonical).toBeTruthy()
      expect(result.openGraph?.url).toContain("https://cognia.example")
    }
  })
})

describe("ogImagePath", () => {
  it("names the homepage image `home`", () => {
    expect(ogImagePath("en", "/")).toBe("/og/home-en.png")
  })

  it("flattens nested routes into one slug", () => {
    expect(ogImagePath("zh", "/use-cases/research")).toBe("/og/use-cases-research-zh.png")
  })

  it("gives every route a distinct image per locale", () => {
    const paths = new Set(ROUTES.flatMap((r) => [ogImagePath("en", r), ogImagePath("zh", r)]))
    expect(paths.size).toBe(ROUTES.length * 2)
  })
})
