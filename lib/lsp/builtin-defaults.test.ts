import { BUILTIN_LSP_SERVERS, BUILTIN_LSP_SERVER_IDS } from "./builtin-defaults"

describe("builtin-defaults", () => {
  it("ships the original four toolchain servers plus the npm-provisioned set", () => {
    const ids = BUILTIN_LSP_SERVERS.map((s) => s.id).sort()
    expect(ids).toEqual([
      "bash",
      "css",
      "gopls",
      "html",
      "json",
      "pyright",
      "rust-analyzer",
      "typescript",
      "yaml",
    ])
  })

  it("every server carries command, languages and extensions", () => {
    for (const s of BUILTIN_LSP_SERVERS) {
      expect(typeof s.command).toBe("string")
      expect(s.command.length).toBeGreaterThan(0)
      expect(Array.isArray(s.languages)).toBe(true)
      expect(s.languages.length).toBeGreaterThan(0)
      expect(Array.isArray(s.extensions)).toBe(true)
      expect(s.extensions!.length).toBeGreaterThan(0)
      expect(s.transport).toBe("stdio")
    }
  })

  it("toolchain servers keep their rootMarkers; generic servers stay marker-less", () => {
    const withMarkers = ["typescript", "pyright", "rust-analyzer", "gopls"]
    for (const id of withMarkers) {
      const s = BUILTIN_LSP_SERVERS.find((x) => x.id === id)!
      expect(s.rootMarkers!.length).toBeGreaterThan(0)
    }
    // Marker-less servers anchor at the agent cwd (see sidecar buildServers).
    const generic = ["json", "css", "html", "yaml", "bash"]
    for (const id of generic) {
      const s = BUILTIN_LSP_SERVERS.find((x) => x.id === id)!
      expect(s.rootMarkers ?? []).toHaveLength(0)
    }
  })

  it("typescript excludes deno markers so the Deno toolchain can win", () => {
    const ts = BUILTIN_LSP_SERVERS.find((s) => s.id === "typescript")!
    expect(ts.excludeRootMarkers).toEqual(["deno.json", "deno.jsonc"])
    expect(ts.extensions).toContain(".ts")
    expect(ts.extensions).toContain(".jsx")
  })

  it("npm-installable servers declare install metadata; binary-dist servers do not", () => {
    const npmBacked: Record<string, string> = {
      typescript: "typescript-language-server",
      pyright: "pyright",
      json: "vscode-langservers-extracted",
      css: "vscode-langservers-extracted",
      html: "vscode-langservers-extracted",
      yaml: "yaml-language-server",
      bash: "bash-language-server",
    }
    for (const [id, pkg] of Object.entries(npmBacked)) {
      expect(BUILTIN_LSP_SERVERS.find((s) => s.id === id)!.install?.npmPackage).toBe(pkg)
    }
    for (const id of ["rust-analyzer", "gopls"]) {
      expect(BUILTIN_LSP_SERVERS.find((s) => s.id === id)!.install).toBeUndefined()
    }
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
