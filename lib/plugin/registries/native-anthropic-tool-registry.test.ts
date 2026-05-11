import type { PluginNativeAnthropicToolDef } from "@/types/plugin/plugin-native-tool"
import {
  __resetNativeAnthropicToolsForTesting,
  computeAnthropicBetaHeaders,
  getNativeAnthropicTool,
  getNativeAnthropicToolEntry,
  listNativeAnthropicToolEntries,
  listNativeAnthropicToolIds,
  registerNativeAnthropicTool,
  unregisterNativeAnthropicToolById,
  unregisterNativeAnthropicToolsByPlugin,
} from "./native-anthropic-tool-registry"

function makeTool(
  id: string,
  overrides: Partial<PluginNativeAnthropicToolDef> = {}
): PluginNativeAnthropicToolDef {
  return {
    id,
    name: id,
    type: "computer_20251124",
    executeIpc: { invoke: `plugin_${id}_invoke` },
    ...overrides,
  }
}

describe("native-anthropic-tool-registry", () => {
  beforeEach(() => {
    __resetNativeAnthropicToolsForTesting()
  })

  describe("registry operations", () => {
    it("registers a tool and retrieves it via get / getEntry / list", () => {
      const tool = makeTool("computer-1")
      const previous = registerNativeAnthropicTool("computer-1", tool, {
        pluginId: "p1",
      })
      expect(previous).toBeUndefined()

      expect(getNativeAnthropicTool("computer-1")).toBe(tool)
      expect(getNativeAnthropicToolEntry("computer-1")).toEqual({
        entry: tool,
        pluginId: "p1",
      })
      expect(listNativeAnthropicToolIds()).toEqual(["computer-1"])
      expect(listNativeAnthropicToolEntries()).toEqual([
        { id: "computer-1", entry: tool, pluginId: "p1" },
      ])
    })

    it("unregisterByPlugin drops every tool from the given pluginId", () => {
      registerNativeAnthropicTool("a", makeTool("a"), { pluginId: "plug" })
      registerNativeAnthropicTool("b", makeTool("b"), { pluginId: "plug" })

      const removed = unregisterNativeAnthropicToolsByPlugin("plug")
      expect(removed).toBe(2)
      expect(getNativeAnthropicTool("a")).toBeUndefined()
      expect(getNativeAnthropicTool("b")).toBeUndefined()
    })

    it("unregisterByPlugin leaves entries from other plugins alone", () => {
      const a = makeTool("a")
      const b = makeTool("b")
      registerNativeAnthropicTool("a", a, { pluginId: "pluginA" })
      registerNativeAnthropicTool("b", b, { pluginId: "pluginB" })

      const removed = unregisterNativeAnthropicToolsByPlugin("pluginA")
      expect(removed).toBe(1)
      expect(getNativeAnthropicTool("a")).toBeUndefined()
      expect(getNativeAnthropicTool("b")).toBe(b)
    })

    it("unregisterById removes only the matching entry", () => {
      registerNativeAnthropicTool("a", makeTool("a"))
      registerNativeAnthropicTool("b", makeTool("b"))

      expect(unregisterNativeAnthropicToolById("a")).toBe(true)
      expect(getNativeAnthropicTool("a")).toBeUndefined()
      expect(getNativeAnthropicTool("b")).toBeDefined()
    })

    it("__resetNativeAnthropicToolsForTesting clears everything", () => {
      registerNativeAnthropicTool("a", makeTool("a"), { pluginId: "p1" })
      registerNativeAnthropicTool("b", makeTool("b"), { pluginId: "p2" })

      __resetNativeAnthropicToolsForTesting()

      expect(listNativeAnthropicToolIds()).toEqual([])
      expect(listNativeAnthropicToolEntries()).toEqual([])
    })
  })

  describe("computeAnthropicBetaHeaders", () => {
    it("returns [] for an empty tool list", () => {
      expect(computeAnthropicBetaHeaders([])).toEqual([])
    })

    it("returns the per-type default for computer_20251124", () => {
      const tool = makeTool("c", { type: "computer_20251124" })
      expect(computeAnthropicBetaHeaders([tool])).toEqual(["computer-use-2025-11-24"])
    })

    it("returns [] for bash_20250124 (no beta default — bash is GA)", () => {
      const tool = makeTool("bash", { type: "bash_20250124" })
      expect(computeAnthropicBetaHeaders([tool])).toEqual([])
    })

    it("returns [] for text_editor_20250728 (no beta default — text editor is GA)", () => {
      const tool = makeTool("ed", { type: "text_editor_20250728" })
      expect(computeAnthropicBetaHeaders([tool])).toEqual([])
    })

    it("lets an explicit betaHeader override the per-type default", () => {
      const tool = makeTool("c", {
        type: "computer_20251124",
        betaHeader: "custom-beta-2025",
      })
      // The plugin-supplied header replaces "computer-use-2025-11-24" entirely.
      expect(computeAnthropicBetaHeaders([tool])).toEqual(["custom-beta-2025"])
    })

    it("lets an explicit betaHeader add a header for a GA type", () => {
      // bash_20250124 has no per-type default but the plugin can still request
      // a beta header (e.g. an experimental bash variant).
      const tool = makeTool("bash", {
        type: "bash_20250124",
        betaHeader: "bash-experimental-2026",
      })
      expect(computeAnthropicBetaHeaders([tool])).toEqual(["bash-experimental-2026"])
    })

    it("dedupes when two tools resolve to the same header", () => {
      const a = makeTool("a", { type: "computer_20251124" })
      const b = makeTool("b", { type: "computer_20251124" })
      expect(computeAnthropicBetaHeaders([a, b])).toEqual(["computer-use-2025-11-24"])
    })

    it("preserves first-occurrence order across mixed types", () => {
      const a = makeTool("a", {
        type: "bash_20250124",
        betaHeader: "alpha-2026",
      })
      const b = makeTool("b", { type: "computer_20251124" })
      const c = makeTool("c", {
        type: "text_editor_20250728",
        betaHeader: "alpha-2026", // duplicate — should NOT appear again
      })
      const d = makeTool("d", {
        type: "bash_20250124",
        betaHeader: "delta-2026",
      })

      expect(computeAnthropicBetaHeaders([a, b, c, d])).toEqual([
        "alpha-2026",
        "computer-use-2025-11-24",
        "delta-2026",
      ])
    })
  })
})
