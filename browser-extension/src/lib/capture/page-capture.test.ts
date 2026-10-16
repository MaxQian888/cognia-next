/** @jest-environment jsdom */
import { capturePage } from "./page-capture"
import entrypoint from "../../app/page-capture"

jest.mock(
  "wxt/utils/define-unlisted-script",
  () => ({
    defineUnlistedScript: (main: () => void) => ({ main }),
  }),
  { virtual: true }
)

describe("capturePage", () => {
  beforeEach(() => {
    document.head.innerHTML = "<title>Page title</title>"
    document.body.innerHTML = ""
    window.getSelection()?.removeAllRanges()
    globalThis.__cogniaPageCapture = undefined
  })

  it("combines visible text, article Markdown, metadata and selection", () => {
    const prose =
      "This account describes the discovery, its evidence, and the people behind it. ".repeat(5)
    document.head.insertAdjacentHTML("beforeend", '<meta name="author" content="Ada">')
    document.body.innerHTML = `<article><h1>Article title</h1><p>${prose}</p><p><strong>Selected</strong></p><p hidden>secret</p></article>`
    const range = document.createRange()
    range.selectNode(document.querySelector("strong")!)
    window.getSelection()!.addRange(range)
    const result = capturePage(document, { wholePage: true, article: true })
    expect(result.title).toBe("Article title")
    expect(result.url).toBe(document.location.href)
    expect(result.selection).toEqual({ text: "Selected", markdown: "**Selected**" })
    expect(result.readableText).toContain(prose.trim())
    expect(result.readableText).not.toContain("secret")
    expect(result.readableCharacterCount).toBe(result.readableText!.length)
    expect(result.article?.markdown).toContain("# Article title")
    expect(result.article?.characterCount).toBe(result.article?.markdown.length)
    expect(result.metadata.byline).toBe("Ada")
    expect(result.isPdf).toBe(false)
  })

  it("does not extract unrequested whole-page or article content", () => {
    document.body.innerHTML = "<p>Visible</p>"
    expect(capturePage(document, { wholePage: false, article: false })).toEqual({
      title: "Page title",
      url: document.location.href,
      selection: null,
      readableText: null,
      readableCharacterCount: 0,
      article: null,
      metadata: {},
      isPdf: false,
    })
  })

  it("never includes a selected draft", () => {
    document.body.innerHTML = '<div contenteditable="true">unsent draft</div>'
    const range = document.createRange()
    range.selectNodeContents(document.querySelector("div")!)
    window.getSelection()!.addRange(range)
    const result = capturePage(document, { wholePage: true, article: true })
    expect(result.selection).toBeNull()
    expect(result.readableText).toBeNull()
    expect(result.article).toBeNull()
  })

  it("detects Chrome PDF embeds and PDF content types", () => {
    document.body.innerHTML = '<embed type="application/pdf" src="https://example.com/doc.pdf">'
    expect(capturePage(document, { wholePage: false, article: false }).isPdf).toBe(true)
    document.body.innerHTML = ""
    const contentType = jest
      .spyOn(document, "contentType", "get")
      .mockReturnValue("application/pdf")
    expect(capturePage(document, { wholePage: false, article: false }).isPdf).toBe(true)
    contentType.mockRestore()
  })

  it("installs the injectable bridge idempotently and reads fresh content", () => {
    entrypoint.main?.()
    const bridge = globalThis.__cogniaPageCapture
    entrypoint.main?.()
    expect(globalThis.__cogniaPageCapture).toBe(bridge)
    document.body.innerHTML = "<p>Fresh content</p>"
    expect(bridge?.capture({ wholePage: true, article: false }).readableText).toBe("Fresh content")
  })
})
