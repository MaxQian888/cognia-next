import manifest, { dynamic } from "./manifest"

describe("manifest()", () => {
  it('opts into force-static so output: "export" can pre-render it', () => {
    // Next.js 16 fails the build under `output: "export"` if a metadata
    // route doesn't declare a static rendering mode.
    expect(dynamic).toBe("force-static")
  })

  it("returns a complete MetadataRoute.Manifest with PWA-installable shape", () => {
    const m = manifest()

    expect(m.name).toBe("Cognia")
    expect(m.short_name).toBe("Cognia")
    expect(m.display).toBe("standalone")
    expect(m.start_url).toBe("/")
    expect(m.theme_color).toBeTruthy()
    expect(m.background_color).toBeTruthy()
  })

  it("declares both standard + maskable icons", () => {
    const m = manifest()
    const icons = m.icons ?? []

    const standard = icons.filter((i) => i.purpose === undefined)
    const maskable = icons.filter((i) => i.purpose === "maskable")

    expect(standard.length).toBeGreaterThan(0)
    expect(maskable.length).toBeGreaterThan(0)
    // Every icon points at a real file under /icons/
    for (const icon of icons) {
      expect(icon.src).toMatch(/^\/icons\/.+\.(svg|png)$/u)
    }
  })

  it("declares a share target the static export can actually receive", () => {
    // `app/share-target/page.tsx` shipped with a full session picker and no way
    // in for an installed PWA: only Android's native SEND intent reached it.
    const m = manifest()
    const target = (m as { share_target?: Record<string, unknown> }).share_target
    expect(target).toBeDefined()
    expect(target?.action).toBe("/share-target")
    // GET is forced, not chosen. A POST target needs a server to receive the
    // form and this app has no `app/api/` at runtime.
    expect(target?.method).toBe("GET")
  })

  it("maps every share param the page reads, and no others", () => {
    const m = manifest()
    const params = (m as { share_target?: { params?: Record<string, string> } }).share_target
      ?.params
    // Declaring a param the page ignores silently drops what the user shared,
    // so this pins the two sides together.
    expect(params).toEqual({ title: "title", text: "text", url: "url" })
  })
})
