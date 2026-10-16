/** @jest-environment jsdom */
import { extractArticle } from "./extract-article"

const prose =
  "A long account explains the discovery, describes the evidence, and follows the people involved. ".repeat(
    4
  )

describe("extractArticle", () => {
  beforeEach(() => {
    document.head.innerHTML = "<title>Document title</title>"
    document.body.innerHTML = ""
  })

  it("prefers substantial article content and removes navigation, footer, comments and hidden input", () => {
    document.head.insertAdjacentHTML("beforeend", "<style>.private { display:none }</style>")
    document.body.innerHTML = `<nav>${prose}</nav><main><article><h1>Story title</h1><p>${prose}</p>
      <div class="comments"><p>COMMENT ${prose}</p></div><footer>FOOTER</footer>
      <p class="private">HIDDEN</p><textarea>DRAFT</textarea></article></main>`
    const before = document.documentElement.outerHTML
    const result = extractArticle(document)!
    expect(result.title).toBe("Story title")
    expect(result.markdown).toContain("# Story title")
    expect(result.markdown).not.toMatch(/COMMENT|FOOTER|HIDDEN|DRAFT/)
    expect(result.characterCount).toBe(result.markdown.length)
    expect(document.documentElement.outerHTML).toBe(before)
  })

  it("includes qualifying prose siblings but excludes related and social blocks", () => {
    document.body.innerHTML = `<div><div class="post"><h1>Title</h1><p>${prose}</p></div>
      <p>Continuation ${prose}</p><div class="related"><p>RELATED ${prose}</p></div>
      <div class="social">SOCIAL</div></div>`
    const result = extractArticle(document)!
    expect(result.markdown).toContain("Continuation")
    expect(result.markdown).not.toMatch(/RELATED|SOCIAL/)
  })

  it("returns null on link-heavy search pages and application shells", () => {
    document.body.innerHTML = `<main>${Array.from({ length: 12 }, (_, i) => `<p><a href="/${i}">${prose}</a></p>`).join("")}</main>`
    expect(extractArticle(document)).toBeNull()
    document.body.innerHTML =
      '<main><h1>Dashboard</h1><button>Save</button><input value="draft"></main>'
    expect(extractArticle(document)).toBeNull()
  })

  it.each(["<main>", '<section role="main">', '<div itemprop="articleBody">'])(
    "recognizes semantic main content: %s",
    (opening) => {
      const tag = opening.match(/^<(\w+)/)![1]
      document.body.innerHTML = `${opening}<p>${prose}</p></${tag}>`
      expect(extractArticle(document)?.title).toBe("Document title")
    }
  )

  it("prefers Open Graph titles and does not mistake an address for an ad hint", () => {
    document.head.insertAdjacentHTML("beforeend", '<meta property="og:title" content="OG title">')
    document.body.innerHTML = `<article class="address"><h1>Heading</h1><p>${prose}</p></article>`
    expect(extractArticle(document)?.title).toBe("OG title")
  })
})
