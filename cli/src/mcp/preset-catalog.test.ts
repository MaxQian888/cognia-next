/**
 * @jest-environment node
 */
import path from "node:path"

import { getPreset } from "@/lib/claude/mcp-presets"

import type { PluginFs } from "../plugin/discover-plugins"
import {
  applyPresetFields,
  collectMcpPresets,
  findCatalogPreset,
  missingPresetFields,
  normalizePluginPreset,
  requiredFieldKeys,
} from "./preset-catalog"

function fakeFs(files: Record<string, string>): PluginFs {
  return {
    async exists(p) {
      return p in files || Object.keys(files).some((f) => f.startsWith(p + path.sep))
    },
    async readDir(p) {
      const direct = new Set<string>()
      for (const f of Object.keys(files)) {
        if (f.startsWith(p + path.sep)) direct.add(f.slice(p.length + 1).split(path.sep)[0])
      }
      return [...direct]
    },
    async readText(p) {
      if (!(p in files)) throw new Error("ENOENT")
      return files[p]
    },
  }
}

const pluginManifest = (id: string, presets: unknown[]) =>
  JSON.stringify({ id, name: id, version: "1.0.0", type: "frontend", mcpServerPresets: presets })

describe("normalizePluginPreset", () => {
  it("fills defaults for optional fields", () => {
    expect(
      normalizePluginPreset({ id: "x", name: "X", transport: "http", config: { url: "https://x" } })
    ).toEqual({
      id: "x",
      name: "X",
      description: "",
      icon: "🧩",
      transport: "http",
      config: { url: "https://x" },
      fields: [],
    })
  })

  it("carries through docsUrl and tags when present", () => {
    expect(
      normalizePluginPreset({
        id: "y",
        name: "Y",
        icon: "🔧",
        description: "desc",
        transport: "stdio",
        config: { command: "c" },
        docsUrl: "https://docs",
        tags: ["a"],
      })
    ).toMatchObject({ docsUrl: "https://docs", tags: ["a"], icon: "🔧", description: "desc" })
  })
})

describe("collectMcpPresets", () => {
  const base = { roots: ["/proj"], home: "/home" }

  it("includes the built-in catalog tagged built-in", async () => {
    const catalog = await collectMcpPresets({
      ...base,
      fs: fakeFs({}),
      readDisabled: () => new Set(),
    })
    expect(catalog.length).toBeGreaterThan(5)
    expect(catalog.every((c) => c.source === "built-in")).toBe(true)
    expect(findCatalogPreset(catalog, "github")?.source).toBe("built-in")
  })

  it("appends presets from enabled plugins", async () => {
    const dir = path.join("/proj", ".cognia", "plugins")
    const fs = fakeFs({
      [path.join(dir, "linear", "plugin.json")]: pluginManifest("linear", [
        {
          id: "linear-remote",
          name: "Linear",
          transport: "http",
          config: { url: "https://mcp.linear.app/mcp" },
        },
      ]),
    })
    const catalog = await collectMcpPresets({ ...base, fs, readDisabled: () => new Set() })
    const linear = findCatalogPreset(catalog, "linear-remote")
    expect(linear?.source).toBe("plugin:linear")
    expect(linear?.preset.transport).toBe("http")
  })

  it("omits presets from disabled plugins", async () => {
    const dir = path.join("/proj", ".cognia", "plugins")
    const fs = fakeFs({
      [path.join(dir, "linear", "plugin.json")]: pluginManifest("linear", [
        { id: "linear-remote", name: "Linear", transport: "http", config: { url: "https://x" } },
      ]),
    })
    const catalog = await collectMcpPresets({
      ...base,
      fs,
      readDisabled: () => new Set(["linear"]),
    })
    expect(findCatalogPreset(catalog, "linear-remote")).toBeUndefined()
  })

  it("uses the real disabled-plugin reader by default (empty home → built-ins only)", async () => {
    const catalog = await collectMcpPresets({
      roots: ["/nonexistent"],
      home: "/nonexistent",
      fs: fakeFs({}),
    })
    expect(catalog.length).toBeGreaterThan(5)
    expect(catalog.every((c) => c.source === "built-in")).toBe(true)
  })
})

describe("required / missing fields", () => {
  it("treats every non-header field as required", () => {
    const github = getPreset("github")!
    expect(requiredFieldKeys(github)).toContain("GITHUB_PERSONAL_ACCESS_TOKEN")
    expect(missingPresetFields(github, {})).toHaveLength(1)
    expect(missingPresetFields(github, { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_x" })).toHaveLength(0)
  })

  it("does not require optional header fields", () => {
    const httpGeneric = normalizePluginPreset({
      id: "h",
      name: "H",
      transport: "http",
      config: { url: "" },
      fields: [
        { key: "url", label: "URL", placement: "url" },
        { key: "Authorization", label: "Auth", placement: "header" },
      ],
    })
    expect(requiredFieldKeys(httpGeneric)).toEqual(["url"])
    expect(missingPresetFields(httpGeneric, { url: "https://x" })).toHaveLength(0)
  })
})

describe("applyPresetFields (re-exported)", () => {
  it("plugs values into the config", () => {
    const preset = normalizePluginPreset({
      id: "fs",
      name: "FS",
      transport: "stdio",
      config: { command: "npx", args: ["-y", "srv", "<PATH>"] },
      fields: [{ key: "PATH", label: "Path", placement: "arg-replace", token: "<PATH>" }],
    })
    expect(applyPresetFields(preset, { PATH: "/data" })).toEqual({
      command: "npx",
      args: ["-y", "srv", "/data"],
    })
  })
})
