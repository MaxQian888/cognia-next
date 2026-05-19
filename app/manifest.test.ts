import manifest, { dynamic } from "./manifest"

describe("manifest()", () => {
  it('opts into force-static so output: "export" can pre-render it', () => {
    // Next.js 16 fails the build under `output: "export"` if a metadata
    // route doesn't declare a static rendering mode.
    expect(dynamic).toBe("force-static")
  })

  it("returns a complete MetadataRoute.Manifest with PWA-installable shape", () => {
    const m = manifest()

    expect(m.name).toBe("cognia")
    expect(m.short_name).toBe("cognia")
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
})
