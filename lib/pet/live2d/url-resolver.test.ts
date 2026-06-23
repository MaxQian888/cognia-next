import { createUrlResolver, normalizePath } from "./url-resolver"
import type { ModelFileEntry } from "./types"

function entry(path: string): ModelFileEntry {
  return { path, blob: new Blob([path]) }
}

describe("normalizePath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizePath("a\\b\\c.png")).toBe("a/b/c.png")
  })

  it("strips a leading ./", () => {
    expect(normalizePath("./a/b.png")).toBe("a/b.png")
  })

  it("collapses repeated slashes", () => {
    expect(normalizePath("a//b///c.png")).toBe("a/b/c.png")
  })

  it("lowercases for case-insensitive comparison", () => {
    expect(normalizePath("Hiyori.2048/Texture_00.PNG")).toBe("hiyori.2048/texture_00.png")
  })
})

describe("createUrlResolver", () => {
  // Images become data URLs; the injected encoder keeps that deterministic so
  // tests don't depend on the jsdom base64 of arbitrary bytes.
  const stubDataUrl = async (_b: Blob, mime: string) => `data:${mime};base64,IMG`
  const imgDeps = {
    createObjectURL: jest.fn(() => "blob:unused"),
    revokeObjectURL: jest.fn(),
    toDataUrl: stubDataUrl,
  }

  it("makes images data URLs and other files blob URLs, resolved case-insensitively", async () => {
    let n = 0
    const created: string[] = []
    const resolver = await createUrlResolver([entry("model/Tex_00.PNG"), entry("model/m.moc3")], {
      createObjectURL: () => {
        const url = `blob:${n++}`
        created.push(url)
        return url
      },
      revokeObjectURL: jest.fn(),
      toDataUrl: stubDataUrl,
    })
    // Only the non-image entry needs a blob object URL.
    expect(created).toHaveLength(1)
    // Image → data URL (type-detectable by PixiJS), resolved case-insensitively.
    expect(resolver.resolve("model/tex_00.png")).toBe("data:image/png;base64,IMG")
    expect(resolver.resolve("./model/Tex_00.PNG")).toBe("data:image/png;base64,IMG")
    // Non-image → blob URL with an extension fragment.
    expect(resolver.resolve("model/m.moc3")).toBe("blob:0#.moc3")
  })

  it("returns undefined for unknown paths", async () => {
    const resolver = await createUrlResolver([entry("a.png")], imgDeps)
    expect(resolver.resolve("missing.png")).toBeUndefined()
  })

  it("resolves images to data URLs PixiJS can parse, and other files to blob URLs", async () => {
    // PixiJS's texture loader recognizes images by URL extension or data-URL
    // MIME. A blob object URL has neither — its path is an opaque UUID and Pixi's
    // path.extname ignores a "#.png" fragment — so Assets.load finds no parser
    // and the texture loads as null. A data URL passes Pixi's checkDataUrl.
    const resolver = await createUrlResolver(
      [entry("Hiyori.2048/texture_00.png"), entry("m.moc3")],
      {
        createObjectURL: () => "blob:abc",
        revokeObjectURL: jest.fn(),
        toDataUrl: stubDataUrl,
      }
    )
    expect(resolver.resolve("Hiyori.2048/texture_00.png")).toBe("data:image/png;base64,IMG")
    expect(resolver.resolve("m.moc3")).toBe("blob:abc#.moc3")
  })

  it("maps each image extension to the MIME PixiJS recognizes", async () => {
    const cases: Array<[string, string]> = [
      ["a.jpg", "image/jpeg"],
      ["a.jpeg", "image/jpeg"],
      ["a.webp", "image/webp"],
      ["a.avif", "image/avif"],
    ]
    for (const [path, mime] of cases) {
      const resolver = await createUrlResolver([entry(path)], {
        createObjectURL: jest.fn(),
        revokeObjectURL: jest.fn(),
        toDataUrl: async (_b, m) => `data:${m};base64,X`,
      })
      expect(resolver.resolve(path)).toBe(`data:${mime};base64,X`)
    }
  })

  it("base64-encodes images with the default encoder when none is injected", async () => {
    const resolver = await createUrlResolver([entry("tex.png")], {
      createObjectURL: jest.fn(),
      revokeObjectURL: jest.fn(),
    })
    const url = resolver.resolve("tex.png")
    expect(url?.startsWith("data:image/png;base64,")).toBe(true)
    // The entry blob's bytes are the path string — decoding round-trips.
    const b64 = url!.slice("data:image/png;base64,".length)
    expect(atob(b64)).toBe("tex.png")
  })

  it("does not append a fragment for extensionless references", async () => {
    const resolver = await createUrlResolver([entry("noext")], {
      createObjectURL: () => "blob:abc",
      revokeObjectURL: jest.fn(),
    })
    expect(resolver.resolve("noext")).toBe("blob:abc")
  })

  it("exposes a read-only entries map", async () => {
    const resolver = await createUrlResolver([entry("a.png")], imgDeps)
    expect(resolver.entries().size).toBe(1)
  })

  it("dedupes entries that normalize to the same key (first writer wins)", async () => {
    let n = 0
    const resolver = await createUrlResolver([entry("A.png"), entry("a.png")], {
      createObjectURL: jest.fn(),
      revokeObjectURL: jest.fn(),
      toDataUrl: async () => `data:image/png;base64,${n++}`,
    })
    expect(resolver.entries().size).toBe(1)
    expect(resolver.resolve("a.png")).toBe("data:image/png;base64,0")
  })

  it("revokes every blob object URL it created and clears the map", async () => {
    const revoke = jest.fn()
    const resolver = await createUrlResolver([entry("a.moc3"), entry("b.json")], {
      createObjectURL: (b) => `blob:${(b as Blob).size}`,
      revokeObjectURL: revoke,
    })
    resolver.revokeAll()
    expect(revoke).toHaveBeenCalledTimes(2)
    expect(resolver.entries().size).toBe(0)
  })

  it("does not revoke data URLs (images need no revocation)", async () => {
    const revoke = jest.fn()
    const resolver = await createUrlResolver([entry("a.png")], {
      createObjectURL: jest.fn(),
      revokeObjectURL: revoke,
      toDataUrl: stubDataUrl,
    })
    resolver.revokeAll()
    expect(revoke).not.toHaveBeenCalled()
    expect(resolver.entries().size).toBe(0)
  })

  it("falls back to the default URL API when no deps are given", async () => {
    // jsdom's URL has no object-URL methods, so install stubs to spy on. Use a
    // non-image entry so the blob-URL (not data-URL) path is exercised.
    const u = URL as unknown as {
      createObjectURL?: (b: Blob) => string
      revokeObjectURL?: (url: string) => void
    }
    const hadCreate = "createObjectURL" in u
    const hadRevoke = "revokeObjectURL" in u
    u.createObjectURL = jest.fn(() => "blob:default")
    u.revokeObjectURL = jest.fn()
    const resolver = await createUrlResolver([entry("a.moc3")])
    expect(resolver.resolve("a.moc3")).toBe("blob:default#.moc3")
    resolver.revokeAll()
    // Revocation uses the raw object URL, not the extension-hinted one.
    expect(u.revokeObjectURL).toHaveBeenCalledWith("blob:default")
    if (!hadCreate) delete u.createObjectURL
    if (!hadRevoke) delete u.revokeObjectURL
  })
})
