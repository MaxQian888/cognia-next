/** @jest-environment jsdom */
import { extractMetadata } from "./extract-metadata"

describe("extractMetadata", () => {
  beforeEach(() => {
    document.head.innerHTML = '<base href="https://example.com/posts/page">'
    document.body.innerHTML = ""
    document.documentElement.removeAttribute("lang")
  })

  it("reads and normalizes meta tags and canonical URLs", () => {
    document.documentElement.lang = " zh-CN "
    document.head.insertAdjacentHTML(
      "beforeend",
      `<meta name="author" content=" Ada\n Lovelace ">
      <meta property="article:published_time" content=" 2026-10-16 "><meta property="og:site_name" content=" Site ">
      <meta name="description" content=" A\n description "><meta property="og:type" content=" Article ">
      <link rel="canonical" href="https://user:secret@example.com/story?q=1#part">`
    )
    expect(extractMetadata(document)).toEqual({
      byline: "Ada Lovelace",
      publishedAt: "2026-10-16",
      siteName: "Site",
      lang: "zh-CN",
      description: "A description",
      kind: "article",
      canonicalUrl: "https://example.com/story?q=1",
    })
  })

  it("traverses arrays and @graph, tolerating malformed JSON-LD", () => {
    document.head.insertAdjacentHTML(
      "beforeend",
      `<script type="application/ld+json">broken</script>
      <script type="application/ld+json">${JSON.stringify([
        {
          "@graph": [
            {
              "@type": "NewsArticle",
              author: [{ name: "Ada" }, { name: "Grace" }],
              datePublished: "2026-10-16",
              publisher: { name: "Daily" },
            },
          ],
        },
      ])}</script><meta property="og:locale" content="zh_CN">`
    )
    expect(extractMetadata(document)).toEqual({
      byline: "Ada, Grace",
      publishedAt: "2026-10-16",
      siteName: "Daily",
      kind: "newsarticle",
      lang: "zh-CN",
    })
  })

  it("falls back to authors, article time, and itemprop metadata", () => {
    document.body.innerHTML =
      '<a rel="author">Writer</a><article><time datetime="2026-10-16">Today</time></article>'
    expect(extractMetadata(document)).toEqual({ byline: "Writer", publishedAt: "2026-10-16" })
    document.body.innerHTML =
      '<span itemprop="author">Other</span><meta itemprop="datePublished" content="2026-10-15">'
    expect(extractMetadata(document)).toEqual({ byline: "Other", publishedAt: "2026-10-15" })
  })

  it("uses the article kind and resolves author/publisher names from graph references", () => {
    document.head.insertAdjacentHTML(
      "beforeend",
      `<script type="application/ld+json">${JSON.stringify({
        "@graph": [
          { "@type": "Organization", "@id": "#publisher", name: "Daily" },
          { "@type": "Person", "@id": "#author", name: "Ada" },
          { "@type": "Article", author: { "@id": "#author" }, publisher: { "@id": "#publisher" } },
        ],
      })}</script>`
    )
    expect(extractMetadata(document)).toEqual({ byline: "Ada", siteName: "Daily", kind: "article" })
  })

  it("uses secondary meta fields and resolves relative canonicals", () => {
    document.head.insertAdjacentHTML(
      "beforeend",
      '<meta property="article:author" content="Author"><meta name="application-name" content="App"><meta property="og:description" content="Description"><link rel="canonical" href="../story#part">'
    )
    expect(extractMetadata(document)).toEqual({
      byline: "Author",
      siteName: "App",
      description: "Description",
      canonicalUrl: "https://example.com/story",
    })
  })

  it.each(["javascript:alert(1)", "data:text/plain,secret", "file:///secret", "https://["])(
    "rejects unsafe canonical %s",
    (url) => {
      const link = document.createElement("link")
      link.rel = "canonical"
      link.setAttribute("href", url)
      document.head.appendChild(link)
      expect(extractMetadata(document).canonicalUrl).toBeUndefined()
    }
  )

  it("omits empty values and caps each value", () => {
    document.head.insertAdjacentHTML(
      "beforeend",
      `<meta name="author" content="  "><meta name="description" content="${"x".repeat(3000)}">`
    )
    expect(extractMetadata(document)).toEqual({ description: "x".repeat(2048) })
  })
})
