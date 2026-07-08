import {
  BROWSER_EVENTS,
  type BrowserSelection,
  formatSelectionComment,
  isLocalHostname,
  normalizePreviewUrl,
  resolveTrustTier,
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
  it("defaults a bare local host to http://", () => {
    expect(normalizePreviewUrl("localhost:3000")).toBe("http://localhost:3000/")
    expect(normalizePreviewUrl("127.0.0.1:5173")).toBe("http://127.0.0.1:5173/")
    expect(normalizePreviewUrl("192.168.1.20:8080")).toBe("http://192.168.1.20:8080/")
    expect(normalizePreviewUrl("mymac.local:3000")).toBe("http://mymac.local:3000/")
  })
  it("defaults a bare public host to https://", () => {
    expect(normalizePreviewUrl("github.com")).toBe("https://github.com/")
    expect(normalizePreviewUrl("example.com/path?q=1")).toBe("https://example.com/path?q=1")
  })
  it("keeps an explicit scheme", () => {
    expect(normalizePreviewUrl("https://example.com/x")).toBe("https://example.com/x")
    expect(normalizePreviewUrl("http://example.com/x")).toBe("http://example.com/x")
  })
  it("returns null for empty input", () => {
    expect(normalizePreviewUrl("   ")).toBeNull()
  })
  it("returns null for an unparseable URL", () => {
    expect(normalizePreviewUrl("http://[bad")).toBeNull()
  })
})

describe("isLocalHostname", () => {
  it("classifies loopback, RFC-1918 and mDNS hosts as local", () => {
    for (const h of [
      "localhost",
      "LOCALHOST",
      "app.localhost",
      "::1",
      "[::1]",
      "0.0.0.0",
      "127.0.0.1",
      "10.1.2.3",
      "192.168.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "dev.local",
    ]) {
      expect(isLocalHostname(h)).toBe(true)
    }
  })
  it("classifies public hosts as non-local", () => {
    for (const h of ["github.com", "172.32.0.1", "1720.16.0.1", "mylocal.com", "8.8.8.8"]) {
      expect(isLocalHostname(h)).toBe(false)
    }
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

describe("resolveTrustTier", () => {
  it.each([
    ["http://localhost:3000/", "trusted"],
    ["http://127.0.0.1:8080/x", "trusted"],
    ["http://[::1]:5173/", "trusted"],
    ["https://app.example.com/", "public"],
    ["http://192.168.1.10/", "public"],
  ])("classifies %s as %s", (url, tier) => {
    expect(resolveTrustTier(url)).toBe(tier)
  })

  it("treats unparseable input as public (fail-closed)", () => {
    expect(resolveTrustTier("not a url")).toBe("public")
  })
})

describe("BROWSER_EVENTS", () => {
  it("exposes agent event names", () => {
    expect(BROWSER_EVENTS.snapshot).toBe("browser://snapshot")
    expect(BROWSER_EVENTS.console).toBe("browser://console")
    expect(BROWSER_EVENTS.network).toBe("browser://network")
  })

  it("exposes the navigation lifecycle event names", () => {
    expect(BROWSER_EVENTS.navigated).toBe("browser://navigated")
    expect(BROWSER_EVENTS.loaded).toBe("browser://loaded")
  })
})
