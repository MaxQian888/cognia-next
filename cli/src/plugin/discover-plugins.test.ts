/**
 * @jest-environment node
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { discoverPlugins, type PluginFs } from "./discover-plugins"

function fakeFs(files: Record<string, string>): PluginFs {
  return {
    async exists(p) {
      return p in files || Object.keys(files).some((f) => f.startsWith(p + path.sep))
    },
    async readDir(p) {
      const direct = new Set<string>()
      for (const f of Object.keys(files)) {
        if (f.startsWith(p + path.sep)) {
          const rest = f.slice(p.length + 1)
          direct.add(rest.split(path.sep)[0])
        }
      }
      return [...direct]
    },
    async readText(p) {
      if (!(p in files)) throw new Error("ENOENT")
      return files[p]
    },
  }
}

const manifest = (id: string, type = "frontend") =>
  JSON.stringify({ id, name: id, version: "1.0.0", description: `the ${id}`, type })

describe("discoverPlugins", () => {
  it("parses manifests and marks frontend plugins supported", async () => {
    const dir = path.join("/proj", ".cognia", "plugins")
    const fs = fakeFs({
      [path.join(dir, "hello", "plugin.json")]: manifest("hello", "frontend"),
      [path.join(dir, "pyplug", "plugin.json")]: manifest("pyplug", "python"),
    })
    const plugins = await discoverPlugins(["/proj"], fs)
    const hello = plugins.find((p) => p.id === "hello")!
    expect(hello).toMatchObject({ name: "hello", version: "1.0.0", supported: true })
    expect(plugins.find((p) => p.id === "pyplug")!.supported).toBe(false)
  })

  it("parses declared tools and skips malformed tool entries", async () => {
    const dir = path.join("/proj", ".cognia", "plugins")
    const fs = fakeFs({
      [path.join(dir, "web", "plugin.json")]: JSON.stringify({
        id: "web",
        name: "web",
        version: "1.0.0",
        description: "web tools",
        type: "frontend",
        tools: [
          {
            name: "web_fetch",
            description: "Fetch a URL",
            category: "network",
            parametersSchema: { type: "object" },
          },
          { description: "no name — skipped" },
          "garbage",
        ],
      }),
    })
    const web = (await discoverPlugins(["/proj"], fs)).find((p) => p.id === "web")!
    expect(web.tools).toEqual([
      {
        name: "web_fetch",
        description: "Fetch a URL",
        category: "network",
        parametersSchema: { type: "object" },
      },
    ])
  })

  it("defaults tools to an empty array when the manifest declares none", async () => {
    const dir = path.join("/proj", ".cognia", "plugins")
    const fs = fakeFs({ [path.join(dir, "bare", "plugin.json")]: manifest("bare") })
    expect((await discoverPlugins(["/proj"], fs))[0].tools).toEqual([])
    expect((await discoverPlugins(["/proj"], fs))[0].mcpServerPresets).toEqual([])
  })

  it("parses contributed MCP server presets and skips malformed ones", async () => {
    const dir = path.join("/proj", ".cognia", "plugins")
    const fs = fakeFs({
      [path.join(dir, "linear", "plugin.json")]: JSON.stringify({
        id: "linear",
        name: "Linear",
        version: "1.0.0",
        description: "linear mcp",
        type: "frontend",
        mcpServerPresets: [
          {
            id: "linear-remote",
            name: "Linear",
            icon: "📐",
            transport: "http",
            config: { url: "https://mcp.linear.app/mcp" },
            tags: ["pm"],
          },
          { id: "no-transport", name: "x", config: {} },
          { name: "no-id", transport: "stdio", config: {} },
          "garbage",
        ],
      }),
    })
    const linear = (await discoverPlugins(["/proj"], fs)).find((p) => p.id === "linear")!
    expect(linear.mcpServerPresets).toEqual([
      {
        id: "linear-remote",
        name: "Linear",
        icon: "📐",
        transport: "http",
        config: { url: "https://mcp.linear.app/mcp" },
        tags: ["pm"],
      },
    ])
  })

  it("ignores folders without a plugin.json and malformed manifests", async () => {
    const dir = path.join("/proj", ".cognia", "plugins")
    const fs = fakeFs({
      [path.join(dir, "broken", "plugin.json")]: "{not json",
      [path.join(dir, "nomanifest", "readme.md")]: "hi",
    })
    expect(await discoverPlugins(["/proj"], fs)).toEqual([])
  })

  it("returns nothing when the plugins dir is absent", async () => {
    expect(await discoverPlugins(["/empty"], fakeFs({}))).toEqual([])
  })

  it("de-duplicates by id across roots (first root wins)", async () => {
    const a = path.join("/proj", ".cognia", "plugins", "x", "plugin.json")
    const b = path.join("/home", ".cognia", "plugins", "x", "plugin.json")
    const ffs = fakeFs({ [a]: manifest("x", "frontend"), [b]: manifest("x", "python") })
    const plugins = await discoverPlugins(["/proj", "/home"], ffs)
    expect(plugins).toHaveLength(1)
    expect(plugins[0].supported).toBe(true)
  })

  it("reads real plugin folders via the default node fs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-plugins-"))
    const dir = path.join(root, ".cognia", "plugins", "hello")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "plugin.json"), manifest("hello", "frontend"))
    try {
      const plugins = await discoverPlugins([root, path.join(root, "missing")])
      expect(plugins).toEqual([
        expect.objectContaining({ id: "hello", name: "hello", supported: true }),
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
