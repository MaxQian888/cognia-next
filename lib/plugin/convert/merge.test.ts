import { mergeContribution, parseExistingManifest } from "./merge"
import type { PluginManifest } from "@/types/plugin/plugin"

const EXISTING = {
  id: "my-plugin",
  name: "My Plugin",
  version: "1.2.3",
  description: "Existing.",
  type: "frontend",
  capabilities: ["commands"],
  main: "dist/index.js",
  permissions: [],
  commands: [{ id: "hello", name: "Hello" }],
  runtimeCompatibility: {
    browser: { availability: "supported" },
    tauri: { availability: "supported" },
    mobile: { availability: "supported" },
  },
} as unknown as PluginManifest

const REQUEST = {
  capability: "mcp-server-preset",
  manifestField: "mcpServerPresets",
  entry: { id: "playwright", name: "playwright" },
  permissions: [],
  need: "host-process" as const,
}

describe("parseExistingManifest", () => {
  it("names the file when the JSON is broken", () => {
    expect(() => parseExistingManifest("{ nope", "a/plugin.json")).toThrow(
      /a\/plugin\.json is not valid JSON/
    )
  })

  it("rejects a non-object document", () => {
    expect(() => parseExistingManifest("[]", "p.json")).toThrow(/must contain a JSON object/)
  })

  it("rejects a manifest without an id", () => {
    expect(() => parseExistingManifest("{}", "p.json")).toThrow(/missing a string `id`/)
  })
})

describe("mergeContribution", () => {
  it("unions the capability and appends the entry", () => {
    const { manifest } = mergeContribution(EXISTING, REQUEST)
    expect(manifest.capabilities).toEqual(["commands", "mcp-server-preset"])
    expect(manifest.mcpServerPresets).toEqual([{ id: "playwright", name: "playwright" }])
  })

  it("does not duplicate a capability that is already declared", () => {
    const already = {
      ...EXISTING,
      capabilities: ["commands", "mcp-server-preset"],
    } as PluginManifest
    expect(mergeContribution(already, REQUEST).manifest.capabilities).toEqual([
      "commands",
      "mcp-server-preset",
    ])
  })

  it("appends alongside existing entries rather than replacing them", () => {
    const withOne = {
      ...EXISTING,
      mcpServerPresets: [{ id: "other" }],
    } as unknown as PluginManifest
    expect(mergeContribution(withOne, REQUEST).manifest.mcpServerPresets).toEqual([
      { id: "other" },
      { id: "playwright", name: "playwright" },
    ])
  })

  it("leaves version, name, and existing contributions untouched", () => {
    const { manifest } = mergeContribution(EXISTING, REQUEST)
    expect(manifest.version).toBe("1.2.3")
    expect(manifest.name).toBe("My Plugin")
    expect(manifest.commands).toEqual([{ id: "hello", name: "Hello" }])
  })

  it("preserves key insertion order so the diff stays readable", () => {
    const { manifest } = mergeContribution(EXISTING, REQUEST)
    expect(Object.keys(manifest).slice(0, 5)).toEqual([
      "id",
      "name",
      "version",
      "description",
      "type",
    ])
  })

  it("does not mutate the input manifest", () => {
    mergeContribution(EXISTING, REQUEST)
    expect(EXISTING.capabilities).toEqual(["commands"])
    expect((EXISTING as { mcpServerPresets?: unknown }).mcpServerPresets).toBeUndefined()
  })

  it("refuses an id collision instead of overwriting or renaming", () => {
    const clashing = {
      ...EXISTING,
      mcpServerPresets: [{ id: "playwright" }],
    } as unknown as PluginManifest
    expect(() => mergeContribution(clashing, REQUEST)).toThrow(
      /already contains an entry with id "playwright"/
    )
  })

  it("refuses to overwrite a field that is not an array", () => {
    const broken = { ...EXISTING, mcpServerPresets: {} } as unknown as PluginManifest
    expect(() => mergeContribution(broken, REQUEST)).toThrow(/is not an array/)
  })

  it("adds a required permission and reports it", () => {
    const { manifest, warnings } = mergeContribution(EXISTING, {
      ...REQUEST,
      permissions: ["cli:execute"],
    })
    expect(manifest.permissions).toEqual(["cli:execute"])
    expect(warnings.join(" ")).toContain("cli:execute")
  })

  it("reports — but does not rewrite — a now-wrong runtime compatibility claim", () => {
    const { manifest, warnings } = mergeContribution(EXISTING, REQUEST)
    // Untouched: narrowing a host plugin's reach could disable its other
    // contributions.
    expect(manifest.runtimeCompatibility?.browser?.availability).toBe("supported")
    expect(warnings.filter((w) => w.includes("runtimeCompatibility"))).toHaveLength(2)
    expect(warnings.join(" ")).toContain("blocked")
  })

  it("stays quiet about compatibility for a portable contribution", () => {
    const { warnings } = mergeContribution(EXISTING, { ...REQUEST, need: "portable" })
    expect(warnings.filter((w) => w.includes("runtimeCompatibility"))).toEqual([])
  })
})

describe("mergeContribution — manifests missing optional arrays", () => {
  const bare = {
    id: "bare",
    name: "Bare",
    version: "0.1.0",
    description: "No optional arrays at all.",
    type: "frontend",
    main: "dist/index.js",
  } as unknown as PluginManifest

  it("creates capabilities and permissions when the manifest has neither", () => {
    const { manifest } = mergeContribution(bare, { ...REQUEST, permissions: ["cli:execute"] })
    expect(manifest.capabilities).toEqual(["mcp-server-preset"])
    expect(manifest.permissions).toEqual(["cli:execute"])
  })

  it("stays quiet about compatibility when the manifest declares none", () => {
    const { warnings } = mergeContribution(bare, REQUEST)
    expect(warnings.filter((w) => w.includes("runtimeCompatibility"))).toEqual([])
  })

  it("does not re-add a permission the manifest already declares", () => {
    const withPermission = { ...bare, permissions: ["cli:execute"] } as unknown as PluginManifest
    const { manifest, warnings } = mergeContribution(withPermission, {
      ...REQUEST,
      permissions: ["cli:execute"],
    })
    expect(manifest.permissions).toEqual(["cli:execute"])
    expect(warnings.filter((w) => w.includes("cli:execute"))).toEqual([])
  })

  it("stays quiet about a target that is already blocked", () => {
    const blocked = {
      ...bare,
      runtimeCompatibility: {
        browser: { availability: "blocked" },
        mobile: { availability: "blocked" },
        tauri: { availability: "supported" },
      },
    } as unknown as PluginManifest
    const { warnings } = mergeContribution(blocked, REQUEST)
    expect(warnings.filter((w) => w.includes("runtimeCompatibility"))).toEqual([])
  })

  it("reports a non-Error JSON failure without losing the path", () => {
    expect(() => parseExistingManifest("undefined", "p.json")).toThrow(/p\.json is not valid JSON/)
  })
})
