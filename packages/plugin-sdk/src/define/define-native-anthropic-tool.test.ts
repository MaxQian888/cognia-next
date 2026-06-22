/**
 * `defineNativeAnthropicTool` is a pass-through identity helper. Tests pin
 * the by-reference contract and ensure no field is dropped or defaulted.
 */

import { defineNativeAnthropicTool } from "./define-native-anthropic-tool"
import type { PluginNativeAnthropicToolDef } from "@/types/plugin/plugin-native-tool"

describe("defineNativeAnthropicTool", () => {
  it("returns the same object reference passed in", () => {
    const def: PluginNativeAnthropicToolDef = {
      id: "computer",
      name: "computer",
      type: "computer_20251124",
      executeIpc: { invoke: "plugin_computer_use_execute" },
    }

    const result = defineNativeAnthropicTool(def)

    expect(result).toBe(def)
  })

  it("preserves computer_20251124 dimensions, betaHeader, and permission policy", () => {
    const def: PluginNativeAnthropicToolDef = {
      id: "computer",
      name: "computer",
      type: "computer_20251124",
      betaHeader: "computer-use-2025-11-24",
      displayWidthPx: 1280,
      displayHeightPx: 800,
      displayNumber: 1,
      enableZoom: true,
      executeIpc: { invoke: "plugin_computer_use_execute" },
      permissionPolicy: "session-allow",
    }
    const out = defineNativeAnthropicTool(def)
    expect(out).toMatchObject({
      betaHeader: "computer-use-2025-11-24",
      displayWidthPx: 1280,
      displayHeightPx: 800,
      displayNumber: 1,
      enableZoom: true,
      permissionPolicy: "session-allow",
    })
  })

  it("supports the bash_20250124 and text_editor_20250728 schemas without computer-only fields", () => {
    const bash: PluginNativeAnthropicToolDef = {
      id: "bash",
      name: "bash",
      type: "bash_20250124",
      executeIpc: { invoke: "plugin_computer_use_bash" },
    }
    const editor: PluginNativeAnthropicToolDef = {
      id: "text_editor",
      name: "str_replace_based_edit_tool",
      type: "text_editor_20250728",
      executeIpc: { invoke: "plugin_computer_use_text_editor" },
    }
    expect(defineNativeAnthropicTool(bash).type).toBe("bash_20250124")
    expect(defineNativeAnthropicTool(editor).type).toBe("text_editor_20250728")
  })
})
