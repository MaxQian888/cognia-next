import JSZip from "jszip"
import { MAX_VSIX_BYTES, normalizeRelPath, readVsix, uiThemeToVariant } from "./parse-vsix"

const SAMPLE_THEME_JSON = JSON.stringify({
  name: "Sample",
  type: "dark",
  colors: {
    "editor.background": "#101010",
    "editor.foreground": "#eeeeee",
    "button.background": "#3b82f6",
  },
})

async function buildVsixBuffer(opts: {
  themes?: Array<{ label?: string; uiTheme?: string; path?: string; bodyJson?: string }>
  manifestExtras?: Record<string, unknown>
  withManifest?: boolean
}): Promise<Uint8Array> {
  const zip = new JSZip()
  if (opts.withManifest !== false) {
    const themes = opts.themes
      ?.filter((t) => typeof t.path === "string")
      .map((t) => ({ label: t.label, uiTheme: t.uiTheme, path: t.path }))
    const manifest = {
      name: "publisher.ext",
      displayName: "Sample Extension",
      version: "1.2.3",
      contributes: themes ? { themes } : undefined,
      ...opts.manifestExtras,
    }
    zip.file("extension/package.json", JSON.stringify(manifest))
  }
  for (const t of opts.themes ?? []) {
    if (!t.path) continue
    zip.file(`extension/${t.path}`, t.bodyJson ?? SAMPLE_THEME_JSON)
  }
  const ab = await zip.generateAsync({ type: "uint8array" })
  return ab
}

describe("normalizeRelPath", () => {
  it("normalises slashes and strips leading ./", () => {
    expect(normalizeRelPath("./themes/dark.json")).toBe("themes/dark.json")
    expect(normalizeRelPath("themes\\dark.json")).toBe("themes/dark.json")
    expect(normalizeRelPath("/themes/dark.json")).toBe("themes/dark.json")
    expect(normalizeRelPath("//themes//dark.json")).toBe("themes//dark.json")
  })
})

describe("uiThemeToVariant", () => {
  it("maps standard ui-theme labels", () => {
    expect(uiThemeToVariant("vs")).toBe("light")
    expect(uiThemeToVariant("hc-light")).toBe("light")
    expect(uiThemeToVariant("vs-dark")).toBe("dark")
    expect(uiThemeToVariant("hc-black")).toBe("dark")
  })
  it("returns undefined for unknown / missing labels", () => {
    expect(uiThemeToVariant(undefined)).toBeUndefined()
    expect(uiThemeToVariant("custom")).toBeUndefined()
  })
})

describe("readVsix", () => {
  it("rejects oversize buffers", async () => {
    const huge = new Uint8Array(MAX_VSIX_BYTES + 1)
    await expect(readVsix(huge)).rejects.toThrow(/size cap/)
  })

  it("rejects non-zip input", async () => {
    const not = new Uint8Array([1, 2, 3, 4])
    await expect(readVsix(not)).rejects.toThrow(/unzip/)
  })

  it("rejects a ZIP without extension/package.json", async () => {
    const buf = await buildVsixBuffer({ themes: [], withManifest: false })
    await expect(readVsix(buf)).rejects.toThrow(/missing/)
  })

  it("rejects an extension with no theme contributions", async () => {
    const buf = await buildVsixBuffer({ themes: [] })
    await expect(readVsix(buf)).rejects.toThrow(/does not contribute/)
  })

  it("rejects a manifest with invalid JSON", async () => {
    const zip = new JSZip()
    zip.file("extension/package.json", "{ not json")
    const buf = await zip.generateAsync({ type: "uint8array" })
    await expect(readVsix(buf)).rejects.toThrow(/invalid JSON/)
  })

  it("ignores theme entries whose file is missing inside the zip", async () => {
    // Build the zip with a manifest that lists 2 themes but only ship 1
    // file. Construct it manually so the manifest doesn't filter the
    // missing one out.
    const zip = new JSZip()
    zip.file(
      "extension/package.json",
      JSON.stringify({
        name: "ext",
        displayName: "Ext",
        contributes: {
          themes: [
            { label: "Has File", path: "themes/a.json" },
            { label: "Missing", path: "themes/missing.json" },
          ],
        },
      })
    )
    zip.file("extension/themes/a.json", SAMPLE_THEME_JSON)
    const buf = await zip.generateAsync({ type: "uint8array" })
    const out = await readVsix(buf)
    expect(out.themes.length).toBe(1)
    expect(out.themes[0].label).toBe("Has File")
  })

  it("returns a parseable manifest for a happy-path VSIX", async () => {
    const buf = await buildVsixBuffer({
      themes: [
        { label: "Sample Dark", uiTheme: "vs-dark", path: "themes/dark.json" },
        { label: "Sample Light", uiTheme: "vs", path: "themes/light.json" },
      ],
    })
    const out = await readVsix(buf)
    expect(out.displayName).toBe("Sample Extension")
    expect(out.name).toBe("publisher.ext")
    expect(out.version).toBe("1.2.3")
    expect(out.themes.map((t) => t.label)).toEqual(["Sample Dark", "Sample Light"])
    const dark = await out.themes[0].parse()
    expect(dark.theme.isDark).toBe(true)
    expect(dark.theme.name).toBe("Sample Dark")
    const light = await out.themes[1].parse()
    expect(light.theme.isDark).toBe(false)
  })

  it("falls back to path when label is missing", async () => {
    const zip = new JSZip()
    zip.file(
      "extension/package.json",
      JSON.stringify({
        name: "ext",
        contributes: { themes: [{ path: "themes/sample.json" }] },
      })
    )
    zip.file("extension/themes/sample.json", SAMPLE_THEME_JSON)
    const buf = await zip.generateAsync({ type: "uint8array" })
    const out = await readVsix(buf)
    expect(out.themes[0].label).toBe("themes/sample.json")
  })

  it("ignores malformed theme entries (not an object, no path)", async () => {
    const zip = new JSZip()
    zip.file(
      "extension/package.json",
      JSON.stringify({
        name: "ext",
        contributes: {
          themes: [null, "string", { label: "no path" }, { path: "themes/ok.json", label: "OK" }],
        },
      })
    )
    zip.file("extension/themes/ok.json", SAMPLE_THEME_JSON)
    const buf = await zip.generateAsync({ type: "uint8array" })
    const out = await readVsix(buf)
    expect(out.themes.length).toBe(1)
    expect(out.themes[0].label).toBe("OK")
  })

  it("accepts ArrayBuffer input as well as Uint8Array", async () => {
    const buf = await buildVsixBuffer({
      themes: [{ label: "X", path: "x.json" }],
    })
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const out = await readVsix(ab as ArrayBuffer)
    expect(out.themes.length).toBe(1)
  })
})
