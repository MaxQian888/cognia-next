/**
 * Tests for sidecar-tools-bridge.ts
 * Plugin tools manifest builder for the SDK sidecar runtime.
 */

import { buildPluginToolsManifest } from "./sidecar-tools-bridge"
import { usePluginStore } from "@/stores/plugin"
import type { Plugin, PluginTool } from "@/types/plugin"

jest.mock("@/stores/plugin", () => ({
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
})
