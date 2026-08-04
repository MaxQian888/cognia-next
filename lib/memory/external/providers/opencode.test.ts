import { discoverOpencode, opencodeConfigDir } from "./opencode"
import type { DiscoverCtx, ExternalFs } from "../types"

function makeFs(files: Record<string, number>): ExternalFs {
  return {
    async exists(path) {
      return path in files
    },
    async readDir() {
      return []
    },
    async stat(path) {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`)
      return { size: files[path], isFile: true }
    },
  }
}

function context(overrides: Partial<DiscoverCtx> = {}): DiscoverCtx {
  return {
    home: "/Users/x",
    roots: [],
    cwd: undefined,
    platform: "macos",
    fs: makeFs({}),
    ...overrides,
  }
}

describe("discoverOpencode", () => {
  it("uses the environment-aware OpenCode config root", () => {
    expect(
      opencodeConfigDir(
        context({
          vendorRoots: {
            claudeConfigDir: "/claude",
            codexHome: "/codex",
            opencodeConfigDir: "/custom/opencode",
            opencodeDataDir: "/data/opencode",
          },
        })
      )
    ).toBe("/custom/opencode")
  })

  it("surfaces the global AGENTS.md slot even when it is absent", async () => {
    const files = await discoverOpencode(context())
    expect(files[0]).toMatchObject({
      agent: "opencode",
      scope: "global",
      absPath: "/Users/x/.config/opencode/AGENTS.md",
      editable: true,
      exists: false,
    })
  })

  it("walks project AGENTS.md files from root to cwd without duplicates", async () => {
    const fs = makeFs({
      "/repo/AGENTS.md": 10,
      "/repo/app/AGENTS.md": 20,
    })
    const files = await discoverOpencode(
      context({ fs, roots: ["/repo", "/repo"], cwd: "/repo/app" })
    )
    expect(files.filter((file) => file.scope === "project").map((file) => file.absPath)).toEqual([
      "/repo/AGENTS.md",
      "/repo/app/AGENTS.md",
    ])
  })
})
