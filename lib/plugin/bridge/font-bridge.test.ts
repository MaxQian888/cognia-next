import {
  applyPluginFonts,
  buildFontFaceRule,
  cssFormatHintFor,
  detectFontKind,
  revertPluginFonts,
} from "./font-bridge"
import { __resetFontRegistryForTesting, findFont } from "@/lib/appearance/font-registry"
import type { PluginFontContribution } from "@/types/plugin/plugin"

beforeEach(() => {
  __resetFontRegistryForTesting()
  document.head.innerHTML = ""
})

describe("detectFontKind", () => {
  it.each([
    ["wOF2", [0x77, 0x4f, 0x46, 0x32], "woff2"],
    ["wOFF", [0x77, 0x4f, 0x46, 0x46], "woff"],
    ["OTTO", [0x4f, 0x54, 0x54, 0x4f], "otf"],
    ["TT zero", [0x00, 0x01, 0x00, 0x00], "ttf-zero"],
    ["TT true", [0x74, 0x72, 0x75, 0x65], "ttf-true"],
  ])("recognises %s", (_label, bytes, expected) => {
    const buf = new Uint8Array([...bytes, 0xff, 0xff, 0xff, 0xff]).buffer
    expect(detectFontKind(buf)).toBe(expected)
  })

  it("rejects unknown signatures", () => {
    const buf = new Uint8Array([0x68, 0x69, 0x21, 0x21]).buffer
    expect(detectFontKind(buf)).toBeNull()
  })

  it("rejects buffers shorter than 4 bytes", () => {
    const buf = new Uint8Array([0x77, 0x4f]).buffer
    expect(detectFontKind(buf)).toBeNull()
  })

  it("accepts Uint8Array views as well as raw ArrayBuffers", () => {
    const bytes = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00])
    expect(detectFontKind(bytes)).toBe("woff2")
  })
})

describe("cssFormatHintFor", () => {
  it.each([
    ["woff2", "woff2"],
    ["woff", "woff"],
    ["otf", "opentype"],
    ["ttf-zero", "truetype"],
    ["ttf-true", "truetype"],
    ["ttf-typ1", "truetype"],
  ])("%s -> %s", (kind, hint) => {
    expect(cssFormatHintFor(kind)).toBe(hint)
  })

  it("returns null for unknown kinds", () => {
    expect(cssFormatHintFor("ai-generated-format")).toBeNull()
  })
})

describe("buildFontFaceRule", () => {
  it("emits a minimal rule with the expected fields", () => {
    const rule = buildFontFaceRule({
      family: "Inter",
      url: "/fonts/inter.woff2",
      kind: "woff2",
      file: { weight: 400, src: "assets/inter.woff2" },
    })
    expect(rule).toContain('font-family: "Inter"')
    expect(rule).toContain('src: url("/fonts/inter.woff2") format("woff2")')
    expect(rule).toContain("font-weight: 400")
    expect(rule).toContain("font-style: normal")
  })

  it("includes font-display + unicode-range when provided", () => {
    const rule = buildFontFaceRule({
      family: "Inter",
      url: "/inter.woff2",
      kind: "woff2",
      file: { weight: 400, style: "italic", src: "i.woff2" },
      display: "swap",
      unicodeRange: "U+0000-00FF",
    })
    expect(rule).toContain("font-display: swap")
    expect(rule).toContain("unicode-range: U+0000-00FF")
    expect(rule).toContain("font-style: italic")
  })

  it("escapes embedded double quotes in family names", () => {
    const rule = buildFontFaceRule({
      family: 'evil "name"',
      url: "/x",
      kind: "woff2",
      file: { weight: 400, src: "x" },
    })
    expect(rule).toContain('font-family: "evil \\"name\\""')
  })
})

function magicResponse(bytes: number[], extra: number = 24): Response {
  const buf = new Uint8Array([...bytes, ...Array.from({ length: extra }, () => 0)])
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  } as unknown as Response
}

function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response
}

describe("applyPluginFonts", () => {
  it("registers families when files pass magic-byte validation", async () => {
    const fonts: PluginFontContribution[] = [
      {
        family: "Inter",
        files: [{ weight: 400, src: "assets/inter.woff2" }],
        display: "swap",
      },
    ]
    const fetchImpl = jest.fn().mockResolvedValue(magicResponse([0x77, 0x4f, 0x46, 0x32]))
    const result = await applyPluginFonts({
      pluginId: "pluginA",
      pluginRoot: "/plugins/pluginA",
      fonts,
      resolveAsset: (root, rel) => `${root}/${rel}`,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.registered).toEqual(["Inter"])
    expect(result.rejected).toEqual([])
    expect(findFont("Inter")?.source).toBe("plugin")
    const style = document.getElementById("plugin-fonts-pluginA")
    expect(style).not.toBeNull()
    expect(style?.textContent).toContain('font-family: "Inter"')
  })

  it("rejects files that fail magic-byte validation", async () => {
    const fonts: PluginFontContribution[] = [
      {
        family: "Bogus",
        files: [{ weight: 400, src: "assets/bogus.txt" }],
      },
    ]
    const fetchImpl = jest.fn().mockResolvedValue(magicResponse([0x21, 0x21, 0x21, 0x21]))
    const result = await applyPluginFonts({
      pluginId: "pluginA",
      pluginRoot: "/p",
      fonts,
      resolveAsset: (root, rel) => `${root}/${rel}`,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.registered).toEqual([])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].reason).toContain("magic-byte")
    expect(findFont("Bogus")).toBeUndefined()
    // No style block when no families survived.
    expect(document.getElementById("plugin-fonts-pluginA")).toBeNull()
  })

  it("reports HTTP errors as rejections", async () => {
    const fonts: PluginFontContribution[] = [
      { family: "Missing", files: [{ weight: 400, src: "404.woff2" }] },
    ]
    const fetchImpl = jest.fn().mockResolvedValue(errorResponse(404))
    const result = await applyPluginFonts({
      pluginId: "pluginA",
      pluginRoot: "/p",
      fonts,
      resolveAsset: (root, rel) => `${root}/${rel}`,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.registered).toEqual([])
    expect(result.rejected[0].reason).toContain("404")
  })

  it("replaces the prior style block on re-apply (idempotent)", async () => {
    const fonts: PluginFontContribution[] = [
      { family: "Inter", files: [{ weight: 400, src: "i.woff2" }] },
    ]
    const fetchImpl = jest.fn().mockResolvedValue(magicResponse([0x77, 0x4f, 0x46, 0x32]))
    await applyPluginFonts({
      pluginId: "pluginA",
      pluginRoot: "/p",
      fonts,
      resolveAsset: (r, p) => `${r}/${p}`,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await applyPluginFonts({
      pluginId: "pluginA",
      pluginRoot: "/p",
      fonts,
      resolveAsset: (r, p) => `${r}/${p}`,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(document.querySelectorAll("#plugin-fonts-pluginA")).toHaveLength(1)
  })

  it("does NOT collide between two plugins contributing different families", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(magicResponse([0x77, 0x4f, 0x46, 0x32]))
    await applyPluginFonts({
      pluginId: "pluginA",
      pluginRoot: "/p",
      fonts: [{ family: "A", files: [{ weight: 400, src: "a.woff2" }] }],
      resolveAsset: (r, p) => `${r}/${p}`,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await applyPluginFonts({
      pluginId: "pluginB",
      pluginRoot: "/p",
      fonts: [{ family: "B", files: [{ weight: 400, src: "b.woff2" }] }],
      resolveAsset: (r, p) => `${r}/${p}`,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(document.getElementById("plugin-fonts-pluginA")).not.toBeNull()
    expect(document.getElementById("plugin-fonts-pluginB")).not.toBeNull()
    expect(findFont("A")?.pluginId).toBe("pluginA")
    expect(findFont("B")?.pluginId).toBe("pluginB")
  })
})

describe("revertPluginFonts", () => {
  it("removes the style block and unregisters every family", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(magicResponse([0x77, 0x4f, 0x46, 0x32]))
    await applyPluginFonts({
      pluginId: "pluginA",
      pluginRoot: "/p",
      fonts: [{ family: "Inter", files: [{ weight: 400, src: "i.woff2" }] }],
      resolveAsset: (r, p) => `${r}/${p}`,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const removed = revertPluginFonts("pluginA")
    expect(removed).toBe(1)
    expect(document.getElementById("plugin-fonts-pluginA")).toBeNull()
    expect(findFont("Inter")).toBeUndefined()
  })

  it("returns 0 when nothing was registered", () => {
    expect(revertPluginFonts("ghost")).toBe(0)
  })
})
