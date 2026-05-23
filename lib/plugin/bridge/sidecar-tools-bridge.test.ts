/**
 * Tests for sidecar-tools-bridge.ts
 * Plugin tools manifest builder for the SDK sidecar runtime.
 */

import { buildPluginToolsManifest, buildTerminalDockManifestEntries } from "./sidecar-tools-bridge"
import { TERMINAL_DOCK_PLUGIN_ID } from "./terminal-dock-schemas"
import { usePluginStore } from "@/stores/plugin-runtime"
import type { Plugin, PluginTool } from "@/types/plugin"

jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: {
    getState: jest.fn(),
  },
}))

const mockedUsePluginStore = usePluginStore as jest.Mocked<typeof usePluginStore>

function makeTool(
  name: string,
  opts?: { description?: string; schema?: Record<string, unknown> }
): PluginTool {
  return {
    name,
    pluginId: "ignored-here", // overridden by plugin.manifest.id in the bridge
    definition: {
      name,
      description: opts?.description ?? `desc for ${name}`,
      parametersSchema: opts?.schema ?? {
        type: "object",
        properties: { foo: { type: "string" } },
        required: ["foo"],
      },
    },
    execute: jest.fn(),
  }
}

function makePlugin(
  id: string,
  opts: { status?: Plugin["status"]; tools?: PluginTool[] } = {}
): Plugin {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      description: "",
      author: "",
      cogniaVersion: "*",
      main: "index.js",
      permissions: [],
    } as unknown as Plugin["manifest"],
    status: opts.status ?? "enabled",
    source: "local" as Plugin["source"],
    path: `/plugins/${id}`,
    config: {},
    tools: opts.tools,
  }
}

function setStore(plugins: Record<string, Plugin>) {
  mockedUsePluginStore.getState.mockReturnValue({
    plugins,
  } as never)
}

describe("buildPluginToolsManifest", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns an empty array when no plugins are registered", () => {
    setStore({})
    expect(buildPluginToolsManifest()).toEqual([])
  })

  it("skips disabled plugins", () => {
    setStore({
      "p-on": makePlugin("p-on", { tools: [makeTool("a")] }),
      "p-off": makePlugin("p-off", { status: "disabled", tools: [makeTool("b")] }),
      "p-loading": makePlugin("p-loading", { status: "loading", tools: [makeTool("c")] }),
    })
    const result = buildPluginToolsManifest()
    expect(result.map((t) => t.name)).toEqual(["a"])
  })

  it("flattens multiple tools across multiple enabled plugins", () => {
    setStore({
      alpha: makePlugin("alpha", { tools: [makeTool("t_a1"), makeTool("t_a2")] }),
      beta: makePlugin("beta", { tools: [makeTool("t_b1")] }),
    })
    const result = buildPluginToolsManifest()
    expect(result).toHaveLength(3)
    const names = result.map((t) => t.name).sort()
    expect(names).toEqual(["t_a1", "t_a2", "t_b1"])
  })

  it("uses the plugin manifest id (not the tool's pluginId field)", () => {
    setStore({
      "host-id": makePlugin("host-id", { tools: [makeTool("only")] }),
    })
    const result = buildPluginToolsManifest()
    expect(result).toHaveLength(1)
    expect(result[0].pluginId).toBe("host-id")
  })

  it("strips the execute function (only manifest fields are surfaced)", () => {
    setStore({
      p: makePlugin("p", { tools: [makeTool("with_exec")] }),
    })
    const [entry] = buildPluginToolsManifest()
    expect(Object.keys(entry).sort()).toEqual(
      ["description", "jsonSchema", "name", "pluginId"].sort()
    )
    expect("execute" in entry).toBe(false)
  })

  it("preserves description and parametersSchema verbatim", () => {
    const customSchema = {
      type: "object",
      properties: { bar: { type: "number" } },
      required: ["bar"],
    }
    setStore({
      p: makePlugin("p", {
        tools: [makeTool("with_schema", { description: "exact text", schema: customSchema })],
      }),
    })
    const [entry] = buildPluginToolsManifest()
    expect(entry.description).toBe("exact text")
    expect(entry.jsonSchema).toEqual(customSchema)
  })

  it("falls back to an empty object when parametersSchema is missing", () => {
    const tool = makeTool("no_schema")
    // Simulate a tool definition missing parametersSchema entirely.
    ;(tool.definition as { parametersSchema?: unknown }).parametersSchema =
      undefined as unknown as Record<string, unknown>
    setStore({
      p: makePlugin("p", { tools: [tool] }),
    })
    const [entry] = buildPluginToolsManifest()
    expect(entry.jsonSchema).toEqual({})
  })

  it("skips plugins whose tools array is empty or missing", () => {
    setStore({
      "no-tools": makePlugin("no-tools"),
      "empty-tools": makePlugin("empty-tools", { tools: [] }),
      "has-tools": makePlugin("has-tools", { tools: [makeTool("kept")] }),
    })
    const result = buildPluginToolsManifest()
    expect(result.map((t) => t.name)).toEqual(["kept"])
  })

  it("does NOT include terminal-dock entries by default (gate off)", () => {
    setStore({ p: makePlugin("p", { tools: [makeTool("only")] }) })
    const result = buildPluginToolsManifest()
    expect(result.find((t) => t.name.startsWith("terminal_dock_"))).toBeUndefined()
  })

  it("appends 4 terminal-dock entries when exposeDockToAgents is on", () => {
    setStore({ p: makePlugin("p", { tools: [makeTool("only")] }) })
    const result = buildPluginToolsManifest({ exposeDockToAgents: true })
    const dockEntries = result.filter((t) => t.name.startsWith("terminal_dock_"))
    expect(dockEntries.map((t) => t.name).sort()).toEqual([
      "terminal_dock_read_recent",
      "terminal_dock_spawn",
      "terminal_dock_wait_for_exit",
      "terminal_dock_write",
    ])
    expect(dockEntries.every((t) => t.pluginId === TERMINAL_DOCK_PLUGIN_ID)).toBe(true)
  })

  it("places terminal-dock entries after plugin entries (stable ordering)", () => {
    setStore({ alpha: makePlugin("alpha", { tools: [makeTool("plug_a")] }) })
    const result = buildPluginToolsManifest({ exposeDockToAgents: true })
    expect(result[0].name).toBe("plug_a")
    expect(result.slice(1).every((t) => t.name.startsWith("terminal_dock_"))).toBe(true)
  })
})

describe("buildTerminalDockManifestEntries", () => {
  it("returns an empty array when the gate is off", () => {
    expect(buildTerminalDockManifestEntries()).toEqual([])
    expect(buildTerminalDockManifestEntries({ exposeDockToAgents: false })).toEqual([])
  })

  it("returns four entries with stable names + descriptions when on", () => {
    const entries = buildTerminalDockManifestEntries({ exposeDockToAgents: true })
    expect(entries).toHaveLength(4)
    for (const entry of entries) {
      expect(entry.name).toMatch(/^terminal_dock_/)
      expect(entry.pluginId).toBe(TERMINAL_DOCK_PLUGIN_ID)
      expect(typeof entry.description).toBe("string")
      expect(entry.description.length).toBeGreaterThan(20)
      expect(entry.jsonSchema).toMatchObject({ type: "object", additionalProperties: false })
    }
  })

  it("does not mutate its schemas between calls (frozen identity)", () => {
    const a = buildTerminalDockManifestEntries({ exposeDockToAgents: true })
    const b = buildTerminalDockManifestEntries({ exposeDockToAgents: true })
    // Schema objects are imported constants — must be the same reference.
    expect(a[0].jsonSchema).toBe(b[0].jsonSchema)
  })
})
