/**
 * @jest-environment jsdom
 */
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  parseLinkMetadata,
  sliceDocumentHead,
} from "./parse-metadata"

const page = (head: string, body = "") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`

describe("parseLinkMetadata", () => {
  it("reads Open Graph fields and resolves relative URLs against the page", () => {
    const meta = parseLinkMetadata(
      page(`
        <title>Fallback title</title>
        <meta property="og:title" content="deepseek-ai/dsh-libreoffice-kit">
        <meta property="og:description" content="An internal component used by DeepSeek Harness">
        <meta property="og:site_name" content="GitHub">
        <meta property="og:image" content="/social/card.png">
        <meta property="og:image:alt" content="Repository card">
        <meta name="theme-color" content="#1e2327">
        <link rel="icon" type="image/svg+xml" href="/favicon.svg">
      `),
      "https://github.com/deepseek-ai/dsh-libreoffice-kit"
    )
    expect(meta).toEqual({
      title: "deepseek-ai/dsh-libreoffice-kit",
      description: "An internal component used by DeepSeek Harness",
      siteName: "GitHub",
      imageUrl: "https://github.com/social/card.png",
      imageAlt: "Repository card",
      faviconUrl: "https://github.com/favicon.svg",
      themeColor: "#1e2327",
    })
  })

  it("falls back to Twitter cards, <title> and the description meta", () => {
    const meta = parseLinkMetadata(
      page(`
        <title>  Plain   title </title>
        <meta name="description" content="Plain description">
        <meta name="twitter:image" content="https://cdn.example.com/x.jpg">
      `),
      "https://example.com/post"
    )
    expect(meta.title).toBe("Plain title")
    expect(meta.description).toBe("Plain description")
    expect(meta.imageUrl).toBe("https://cdn.example.com/x.jpg")
    expect(meta.siteName).toBeUndefined()
    expect(meta.imageAlt).toBeUndefined()
  })

  it("matches property and name attributes interchangeably", () => {
    const meta = parseLinkMetadata(
      page(
        `<meta name="og:title" content="Name attr"><meta property="description" content="Prop">`
      ),
      "https://example.com/"
    )
    expect(meta.title).toBe("Name attr")
    expect(meta.description).toBe("Prop")
  })

  it("honours <base href> when resolving", () => {
    const meta = parseLinkMetadata(
      page(
        `<base href="https://static.example.com/assets/"><meta property="og:image" content="hero.png">`
      ),
      "https://example.com/a/b"
    )
    expect(meta.imageUrl).toBe("https://static.example.com/assets/hero.png")
  })

  it("drops non-http image URLs and keeps inline data favicons", () => {
    const meta = parseLinkMetadata(
      page(`
        <meta property="og:image" content="javascript:alert(1)">
        <link rel="icon" href="data:image/png;base64,AAAA">
      `),
      "https://example.com/"
    )
    expect(meta.imageUrl).toBeUndefined()
    expect(meta.faviconUrl).toBe("data:image/png;base64,AAAA")
  })

  it("picks the icon nearest 32px, then apple-touch-icon, then /favicon.ico", () => {
    const sized = parseLinkMetadata(
      page(`
        <link rel="icon" sizes="192x192" href="/big.png">
        <link rel="shortcut icon" sizes="32x32" href="/mid.png">
        <link rel="icon" sizes="16x16" href="/small.png">
      `),
      "https://example.com/"
    )
    expect(sized.faviconUrl).toBe("https://example.com/mid.png")

    const touch = parseLinkMetadata(
      page(`<link rel="apple-touch-icon" href="/touch.png">`),
      "https://example.com/x"
    )
    expect(touch.faviconUrl).toBe("https://example.com/touch.png")

    const none = parseLinkMetadata(page(""), "https://example.com/deep/path")
    expect(none.faviconUrl).toBe("https://example.com/favicon.ico")
  })

  it("caps runaway titles and descriptions", () => {
    const meta = parseLinkMetadata(
      page(
        `<title>${"t".repeat(500)}</title><meta name="description" content="${"d".repeat(900)}">`
      ),
      "https://example.com/"
    )
    expect(meta.title).toHaveLength(MAX_TITLE_LENGTH)
    expect(meta.title?.endsWith("…")).toBe(true)
    expect(meta.description).toHaveLength(MAX_DESCRIPTION_LENGTH)
  })

  it("never executes or reads the body", () => {
    const meta = parseLinkMetadata(
      page(`<title>Head</title>`, `<script>window.__ran = true</script><h1>Body title</h1>`),
      "https://example.com/"
    )
    expect(meta.title).toBe("Head")
    expect((window as unknown as { __ran?: boolean }).__ran).toBeUndefined()
  })
})

describe("sliceDocumentHead", () => {
  it("cuts at the first </head> and leaves headless HTML alone", () => {
    expect(sliceDocumentHead("<head><title>x</title></head><body>long</body>")).toBe(
      "<head><title>x</title></head><body></body>"
    )
    expect(sliceDocumentHead("<title>x</title>")).toBe("<title>x</title>")
  })
})
