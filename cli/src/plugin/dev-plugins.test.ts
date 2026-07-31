/**
 * @jest-environment node
 */
import path from "node:path"

import {
  resolveDevPluginsDir,
  discoverDevPlugins,
  type DevPluginsDirFs,
  type DevPluginsScanFs,
} from "./dev-plugins"

describe("resolveDevPluginsDir", () => {
  it("resolves an explicit relative dir against cwd when it exists", () => {
    const fs: DevPluginsDirFs = { existsDir: () => true, existsFile: () => true }
    const out = resolveDevPluginsDir("custom/plugins", "/repo", fs)
    expect(out).toBe(path.resolve("/repo", "custom/plugins"))
  })

  it("returns null for an explicit dir that does not exist", () => {
    const fs: DevPluginsDirFs = { existsDir: () => false, existsFile: () => true }
    expect(resolveDevPluginsDir("nope", "/repo", fs)).toBeNull()
  })

  it("walks up to the repo root (plugins/ + package.json) and returns <root>/plugins", () => {
    const root = path.resolve("/repo")
    const fs: DevPluginsDirFs = {
      existsDir: (p) => p === path.join(root, "plugins"),
      existsFile: (p) => p === path.join(root, "package.json"),
    }
    const cwd = path.join(root, "cli", "src", "deep")
    expect(resolveDevPluginsDir(undefined, cwd, fs)).toBe(path.join(root, "plugins"))
  })

  it("returns null when no ancestor has both plugins/ and package.json", () => {
    const fs: DevPluginsDirFs = { existsDir: () => false, existsFile: () => false }
    expect(resolveDevPluginsDir(undefined, "/some/where", fs)).toBeNull()
  })
})

describe("discoverDevPlugins", () => {
  const manifest = (id: string, type = "frontend") =>
    JSON.stringify({ id, name: id, version: "1.0.0", type, main: "src/index.ts" })

  function scanFs(dirs: string[], files: Record<string, string>): DevPluginsScanFs {
    return {
      readDir: async (p) => (p === "/repo/plugins" ? dirs : []),
      readText: async (p) => {
        if (p in files) return files[p]
        throw new Error("ENOENT")
      },
    }
  }

  it("parses each plugins/<id>/plugin.json into a registrable disk entry", async () => {
    const fs = scanFs(["web-tools", "screenshot"], {
      [path.join("/repo/plugins", "web-tools", "plugin.json")]: manifest("cognia-web-tools"),
      [path.join("/repo/plugins", "screenshot", "plugin.json")]: manifest("cognia-screenshot"),
    })
    const entries = await discoverDevPlugins("/repo/plugins", new Set(), fs)
    expect(entries.map((e) => e.id).sort()).toEqual(["cognia-screenshot", "cognia-web-tools"])
    expect(entries[0]).toMatchObject({ supported: true, dir: expect.stringContaining("plugins") })
  })

  it("skips ids already loaded (compiled-in builtins)", async () => {
    const fs = scanFs(["web-tools"], {
      [path.join("/repo/plugins", "web-tools", "plugin.json")]: manifest("cognia-web-tools"),
    })
    const entries = await discoverDevPlugins("/repo/plugins", new Set(["cognia-web-tools"]), fs)
    expect(entries).toHaveLength(0)
  })

  it("marks non-frontend plugins unsupported and skips malformed/missing manifests", async () => {
    const fs = scanFs(["py", "broken", "nomani"], {
      [path.join("/repo/plugins", "py", "plugin.json")]: manifest("cognia-py", "python"),
      [path.join("/repo/plugins", "broken", "plugin.json")]: "{ not json",
      // "nomani" has no plugin.json → readText throws → skipped
    })
    const entries = await discoverDevPlugins("/repo/plugins", new Set(), fs)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: "cognia-py", supported: false })
  })
})
