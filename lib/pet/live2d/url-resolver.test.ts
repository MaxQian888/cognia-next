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
  const deps = {
    createObjectURL: (b: Blob) => `blob:${(b as Blob & { __seq?: number }).size}-${Math.random()}`,
    revokeObjectURL: jest.fn(),
  }

  it("creates one object URL per entry and resolves them case-insensitively", () => {
    let n = 0
    const created: string[] = []
    const resolver = createUrlResolver([entry("model/Tex_00.PNG"), entry("model/m.moc3")], {
      createObjectURL: () => {
        const url = `blob:${n++}`
        created.push(url)
        return url
      },
      revokeObjectURL: jest.fn(),
    })
    expect(created).toHaveLength(2)
    expect(resolver.resolve("model/tex_00.png")).toBe("blob:0")
    expect(resolver.resolve("./model/Tex_00.PNG")).toBe("blob:0")
    expect(resolver.resolve("model/m.moc3")).toBe("blob:1")
  })

  it("returns undefined for unknown paths", () => {
    const resolver = createUrlResolver([entry("a.png")], deps)
    expect(resolver.resolve("missing.png")).toBeUndefined()
  })

  it("exposes a read-only entries map", () => {
    const resolver = createUrlResolver([entry("a.png")], deps)
    expect(resolver.entries().size).toBe(1)
  })

  it("dedupes entries that normalize to the same key (first writer wins)", () => {
    let n = 0
    const resolver = createUrlResolver([entry("A.png"), entry("a.png")], {
      createObjectURL: () => `blob:${n++}`,
      revokeObjectURL: jest.fn(),
    })
    expect(resolver.entries().size).toBe(1)
    expect(resolver.resolve("a.png")).toBe("blob:0")
  })

  it("revokes every created URL and clears the map", () => {
    const revoke = jest.fn()
    const resolver = createUrlResolver([entry("a.png"), entry("b.png")], {
      createObjectURL: (b) => `blob:${(b as Blob).size}`,
      revokeObjectURL: revoke,
    })
    resolver.revokeAll()
    expect(revoke).toHaveBeenCalledTimes(2)
    expect(resolver.entries().size).toBe(0)
  })

  it("falls back to the default URL API when no deps are given", () => {
    // jsdom's URL has no object-URL methods, so install stubs to spy on.
    const u = URL as unknown as {
      createObjectURL?: (b: Blob) => string
      revokeObjectURL?: (url: string) => void
    }
    const hadCreate = "createObjectURL" in u
    const hadRevoke = "revokeObjectURL" in u
    u.createObjectURL = jest.fn(() => "blob:default")
    u.revokeObjectURL = jest.fn()
    const resolver = createUrlResolver([entry("a.png")])
    expect(resolver.resolve("a.png")).toBe("blob:default")
    resolver.revokeAll()
    expect(u.revokeObjectURL).toHaveBeenCalledWith("blob:default")
    if (!hadCreate) delete u.createObjectURL
    if (!hadRevoke) delete u.revokeObjectURL
  })
})
