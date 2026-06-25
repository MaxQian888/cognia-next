import {
  type BrowserSelection,
  formatSelectionComment,
  normalizePreviewUrl,
  screenshotToFile,
} from "./protocol"

const SELECTION: BrowserSelection = {
  paneId: "browser-pane",
  selector: "#root > section > button",
  domPath: "section > button#go",
  tagName: "button",
  id: "go",
  classes: "btn primary",
  rect: { x: 10, y: 20, width: 100, height: 40 },
  outerHTML: '<button id="go">Go</button>',
  text: "Go",
  pageUrl: "http://localhost:3000/",
  pageTitle: "Home",
}

describe("formatSelectionComment", () => {
  it("leads with the comment then the element context", () => {
    const out = formatSelectionComment(SELECTION, "  make this blue  ")
    expect(out.startsWith("make this blue")).toBe(true)
    expect(out).toContain("Selector: #root > section > button")
    expect(out).toContain("Path: section > button#go")
    expect(out).toContain("Text: Go")
    expect(out).toContain("Page: http://localhost:3000/")
    expect(out).toContain("```html")
    expect(out).toContain('<button id="go">Go</button>')
  })

  it("omits empty optional fields", () => {
    const out = formatSelectionComment({ ...SELECTION, domPath: "", text: "", outerHTML: "" }, "x")
    expect(out).not.toContain("Path:")
    expect(out).not.toContain("Text:")
    expect(out).not.toContain("```html")
  })
})

describe("normalizePreviewUrl", () => {
  it("defaults a bare host to http://", () => {
    expect(normalizePreviewUrl("localhost:3000")).toBe("http://localhost:3000/")
  })
  it("keeps an explicit scheme", () => {
    expect(normalizePreviewUrl("https://example.com/x")).toBe("https://example.com/x")
  })
  it("returns null for empty input", () => {
    expect(normalizePreviewUrl("   ")).toBeNull()
  })
  it("returns null for an unparseable URL", () => {
    expect(normalizePreviewUrl("http://[bad")).toBeNull()
  })
})

describe("screenshotToFile", () => {
  it("builds a data-url SubmittedFile", () => {
    const f = screenshotToFile("AAAA")
    expect(f.url).toBe("data:image/png;base64,AAAA")
    expect(f.mediaType).toBe("image/png")
    expect(f.filename).toBe("preview.png")
  })
  it("accepts a custom filename", () => {
    expect(screenshotToFile("AAAA", "shot.png").filename).toBe("shot.png")
  })
})
