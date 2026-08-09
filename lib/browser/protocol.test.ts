import {
  BROWSER_EVENTS,
  type BrowserSelection,
  formatSelectionComment,
  formatSelectionsComment,
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
  it("supports compact, detailed, and forensic detail levels", () => {
    const enriched = {
      ...SELECTION,
      nearbyText: "Checkout summary",
      computedStyles: { display: "flex", color: "rgb(0, 0, 0)" },
      accessibility: { role: "button", name: "Go" },
      devicePixelRatio: 2,
      timestamp: "2026-07-16T10:00:00.000Z",
    }
    const compact = formatSelectionComment(enriched, "change it", "compact")
    expect(compact.split("\n")).toHaveLength(1)
    expect(compact).toContain("change it")
    expect(compact).not.toContain("HTML:")

    const detailed = formatSelectionComment(enriched, "change it", "detailed")
    expect(detailed).toContain("Classes: btn primary")
    expect(detailed).toContain("Bounds: x=10, y=20, width=100, height=40")
    expect(detailed).toContain("Nearby text: Checkout summary")

    const forensic = formatSelectionComment(enriched, "change it", "forensic")
    expect(forensic).toContain("Computed styles: display=flex, color=rgb(0, 0, 0)")
    expect(forensic).toContain("Accessibility: role=button, name=Go")
    expect(forensic).toContain("Environment: DPR=2, timestamp=2026-07-16T10:00:00.000Z")
  })

  it("renders a CSS reference frame and parent layout", () => {
    const out = formatSelectionComment(
      {
        ...SELECTION,
        viewport: { width: 1440, height: 900 },
        contentArea: { selector: "main", left: 220, right: 1420, width: 1200, centerX: 820 },
        parentLayout: { display: "flex", flexDirection: "column", gap: "24px", selector: "main" },
      },
      "move it"
    )
    expect(out).toContain("### Reference Frame")
    expect(out).toContain("Viewport: `1440×900px`")
    expect(out).toContain(
      "Content area: `1200px` wide, left edge at `x=220`, right at `x=1420` (`main`)"
    )
    expect(out).toContain("Horizontal position in container: `element.x - 220`")
    expect(out).toContain("Width as % of container: `element.width / 1200 × 100`")
    expect(out).toContain("Parent: `flex`, flex-direction: `column`, gap: `24px` (`main`)")
  })

  it("uses viewport-relative CSS arithmetic without a content area", () => {
    const out = formatSelectionComment(
      { ...SELECTION, viewport: { width: 1024, height: 768 } },
      "move it"
    )
    expect(out).toContain("Horizontal position in viewport: `element.x / 1024 × 100`")
    expect(out).toContain("Width as % of viewport: `element.width / 1024 × 100`")
  })

  it("omits the reference frame when spatial context is absent", () => {
    expect(formatSelectionComment(SELECTION, "x")).not.toContain("### Reference Frame")
  })

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

  it("surfaces the owning component, props and points the agent at its definition", () => {
    const out = formatSelectionComment(
      {
        ...SELECTION,
        componentName: "SubmitButton",
        componentStack: "App > CheckoutForm > SubmitButton",
        props: { variant: "primary", disabled: "false" },
        framework: "react",
      },
      "make it green"
    )
    expect(out).toContain("Component: <SubmitButton>")
    expect(out).toContain("Component path: App > CheckoutForm > SubmitButton")
    expect(out).toContain("Props: variant=primary, disabled=false")
    expect(out).toContain(
      "Rendered by the <SubmitButton> component; locate its definition (grep/LSP) and edit there."
    )
  })

  it("prefers a precise source pointer when an inspector hint is present", () => {
    const out = formatSelectionComment(
      {
        ...SELECTION,
        componentName: "SubmitButton",
        sourceHint: { path: "src/components/SubmitButton.tsx", line: 42, column: 6 },
      },
      "x"
    )
    expect(out).toContain("Source: src/components/SubmitButton.tsx:42:6")
    expect(out).toContain("Likely source: src/components/SubmitButton.tsx:42 — start there.")
    // The source pointer supersedes the component-grep directive.
    expect(out).not.toContain("locate its definition")
  })

  it("adds no component context on a non-React page", () => {
    const out = formatSelectionComment(SELECTION, "x")
    expect(out).not.toContain("Component:")
    expect(out).not.toContain("Props:")
    expect(out).not.toContain("Rendered by")
    expect(out).not.toContain("Likely source:")
  })
})

describe("formatSelectionsComment", () => {
  it("formats numbered element, area, and text targets with budget disclosure", () => {
    const out = formatSelectionsComment(
      [
        {
          ...SELECTION,
          detailReduced: {
            selectionCount: 3,
            outerHTMLLimit: 2000,
            reason: "multi-selection-budget",
          },
        },
        { ...SELECTION, kind: "area", selector: "", tagName: "", outerHTML: "", text: "" },
        { ...SELECTION, kind: "text", selectedText: "Buy now" },
      ],
      "align these"
    )
    expect(out).toContain("Selected targets (in-app browser): 3")
    expect(out).toContain("### 1. Element")
    expect(out).toContain("### 2. Area")
    expect(out).toContain("### 3. Text range")
    expect(out).toContain("Selected text: Buy now")
    expect(out).toContain("Detail reduced: outerHTML capped at 2000 characters")
  })

  it("preserves the scalar formatter for a single selection", () => {
    expect(formatSelectionsComment([SELECTION], "x")).toBe(formatSelectionComment(SELECTION, "x"))
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
    expect(BROWSER_EVENTS.proxyError).toBe("browser://proxy-error")
  })
})
