import { resolveLspServers } from "./resolve-config"
import { BUILTIN_LSP_SERVERS } from "./builtin-defaults"
import type { LspProjectFile, LspServerConfig } from "@/types/lsp/config"

const ALL_BUILTIN_IDS = [...BUILTIN_LSP_SERVERS.map((s) => s.id)].sort()

describe("resolveLspServers", () => {
  it("returns the builtin defaults when no other layer is given", async () => {
    const out = await resolveLspServers({})
    expect(out.map((s) => s.id).sort()).toEqual(ALL_BUILTIN_IDS)
    for (const s of out) expect(s.source).toBe("builtin")
  })

  it("omits builtins when includeBuiltins is false", async () => {
    const out = await resolveLspServers({ includeBuiltins: false })
    expect(out).toEqual([])
  })

  it("lets a user entry override a builtin field-by-field and tags provenance", async () => {
    const userServers: LspServerConfig[] = [
      {
        id: "typescript",
        name: "TS (custom)",
        languages: ["typescript"],
        command: "/opt/tsserver",
      },
    ]
    const out = await resolveLspServers({ userServers })
    const ts = out.find((s) => s.id === "typescript")!
    expect(ts.command).toBe("/opt/tsserver")
    expect(ts.name).toBe("TS (custom)")
    // Untouched builtin fields survive the merge.
    expect(ts.extensions).toContain(".tsx")
    expect(ts.args).toEqual(["--stdio"])
    expect(ts.source).toBe("user")
    expect(ts.overriddenBy).toBe("builtin")
  })

  it("appends a brand-new user server", async () => {
    const userServers: LspServerConfig[] = [
      { id: "clangd", name: "clangd", languages: ["cpp"], command: "clangd", extensions: [".cpp"] },
    ]
    const out = await resolveLspServers({ userServers })
    const clangd = out.find((s) => s.id === "clangd")!
    expect(clangd.source).toBe("user")
    expect(clangd.overriddenBy).toBeUndefined()
    expect(out).toHaveLength(BUILTIN_LSP_SERVERS.length + 1)
  })

  it("deep-merges the settings object instead of replacing it", async () => {
    const userServers: LspServerConfig[] = [
      {
        id: "rust-analyzer",
        name: "rust-analyzer",
        languages: ["rust"],
        command: "rust-analyzer",
        settings: { "rust-analyzer": { cargo: { features: "all" }, checkOnSave: true } },
      },
    ]
    const readProjectFile = async (): Promise<LspProjectFile> => ({
      servers: [
        {
          id: "rust-analyzer",
          name: "rust-analyzer",
          languages: ["rust"],
          command: "rust-analyzer",
          settings: { "rust-analyzer": { cargo: { allFeatures: true } } },
        },
      ],
    })
    const out = await resolveLspServers({ rootDir: "/proj", userServers, readProjectFile })
    const ra = out.find((s) => s.id === "rust-analyzer")!
    expect(ra.settings).toEqual({
      "rust-analyzer": { cargo: { features: "all", allFeatures: true }, checkOnSave: true },
    })
    expect(ra.source).toBe("project")
    expect(ra.overriddenBy).toBe("user")
  })

  it("drops a builtin a user disables with enabled:false", async () => {
    const userServers: LspServerConfig[] = [
      { id: "gopls", name: "gopls", languages: ["go"], command: "gopls", enabled: false },
    ]
    const out = await resolveLspServers({ userServers })
    expect(out.find((s) => s.id === "gopls")).toBeUndefined()
  })

  it("lets a higher layer re-enable a server a lower layer disabled", async () => {
    const userServers: LspServerConfig[] = [
      { id: "gopls", name: "gopls", languages: ["go"], command: "gopls", enabled: false },
    ]
    const readProjectFile = async (): Promise<LspProjectFile> => ({
      servers: [{ id: "gopls", name: "gopls", languages: ["go"], command: "gopls", enabled: true }],
    })
    const out = await resolveLspServers({ rootDir: "/proj", userServers, readProjectFile })
    expect(out.find((s) => s.id === "gopls")).toBeDefined()
  })

  it("treats a throwing project reader as an empty project layer", async () => {
    const readProjectFile = async () => {
      throw new Error("permission denied")
    }
    const out = await resolveLspServers({ rootDir: "/proj", readProjectFile })
    expect(out.map((s) => s.id).sort()).toEqual(ALL_BUILTIN_IDS)
  })

  it("ignores a project file with no servers array", async () => {
    const readProjectFile = async (): Promise<LspProjectFile> => ({})
    const out = await resolveLspServers({ rootDir: "/proj", readProjectFile })
    expect(out).toHaveLength(BUILTIN_LSP_SERVERS.length)
  })

  it("does not read the project file when no rootDir is given", async () => {
    const readProjectFile = jest.fn(async (): Promise<LspProjectFile> => ({ servers: [] }))
    await resolveLspServers({ readProjectFile })
    expect(readProjectFile).not.toHaveBeenCalled()
  })

  it("layers plugin servers below user servers", async () => {
    const pluginServers: LspServerConfig[] = [
      {
        id: "eslint",
        name: "ESLint (plugin)",
        languages: ["javascript"],
        command: "eslint-server",
      },
    ]
    const userServers: LspServerConfig[] = [
      { id: "eslint", name: "ESLint (user)", languages: ["javascript"], command: "my-eslint" },
    ]
    const out = await resolveLspServers({ pluginServers, userServers })
    const eslint = out.find((s) => s.id === "eslint")!
    expect(eslint.command).toBe("my-eslint")
    expect(eslint.source).toBe("user")
    expect(eslint.overriddenBy).toBe("plugin")
  })

  it("deep-merges env while keeping builtin-derived keys", async () => {
    const pluginServers: LspServerConfig[] = [
      { id: "x", name: "x", languages: ["x"], command: "x", env: { A: "1", B: "2" } },
    ]
    const userServers: LspServerConfig[] = [
      { id: "x", name: "x", languages: ["x"], command: "x", env: { B: "20", C: "3" } },
    ]
    const out = await resolveLspServers({ includeBuiltins: false, pluginServers, userServers })
    expect(out[0].env).toEqual({ A: "1", B: "20", C: "3" })
  })

  it("skips entries missing an id", async () => {
    const userServers = [
      { name: "broken", languages: [], command: "x" },
    ] as unknown as LspServerConfig[]
    const out = await resolveLspServers({ includeBuiltins: false, userServers })
    expect(out).toEqual([])
  })
})
