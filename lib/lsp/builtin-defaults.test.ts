import { BUILTIN_LSP_SERVERS, BUILTIN_LSP_SERVER_IDS } from "./builtin-defaults"

describe("builtin-defaults", () => {
  it("ships the four original hard-coded servers", () => {
    const ids = BUILTIN_LSP_SERVERS.map((s) => s.id).sort()
    expect(ids).toEqual(["gopls", "pyright", "rust-analyzer", "typescript"])
  })

  it("every server carries command, languages, extensions and rootMarkers", () => {
    for (const s of BUILTIN_LSP_SERVERS) {
      expect(typeof s.command).toBe("string")
      expect(s.command.length).toBeGreaterThan(0)
      expect(Array.isArray(s.languages)).toBe(true)
      expect(s.languages.length).toBeGreaterThan(0)
      expect(Array.isArray(s.extensions)).toBe(true)
      expect(s.extensions!.length).toBeGreaterThan(0)
      expect(Array.isArray(s.rootMarkers)).toBe(true)
      expect(s.rootMarkers!.length).toBeGreaterThan(0)
      expect(s.transport).toBe("stdio")
    }
  })

  it("typescript excludes deno markers so the Deno toolchain can win", () => {
    const ts = BUILTIN_LSP_SERVERS.find((s) => s.id === "typescript")!
    expect(ts.excludeRootMarkers).toEqual(["deno.json", "deno.jsonc"])
    expect(ts.extensions).toContain(".ts")
    expect(ts.extensions).toContain(".jsx")
  })

  it("exposes a Set of builtin ids matching the list", () => {
    expect(BUILTIN_LSP_SERVER_IDS.size).toBe(BUILTIN_LSP_SERVERS.length)
    for (const s of BUILTIN_LSP_SERVERS) expect(BUILTIN_LSP_SERVER_IDS.has(s.id)).toBe(true)
    expect(BUILTIN_LSP_SERVER_IDS.has("nonexistent")).toBe(false)
  })

  it("marks filesystem-backed servers as workspaceFolderRequired", () => {
    const needFs = ["pyright", "rust-analyzer", "gopls"]
    for (const id of needFs) {
      expect(BUILTIN_LSP_SERVERS.find((s) => s.id === id)!.workspaceFolderRequired).toBe(true)
    }
  })
})
