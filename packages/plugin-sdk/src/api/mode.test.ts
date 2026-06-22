import * as sdk from "./mode"
import type { AgentModeConfig, AgentModeType, CustomAgentMode, PluginModeDef } from "./mode"

describe("plugin-sdk api/mode", () => {
  it("exposes the mode authoring helper and built-in mode catalog helpers", () => {
    expect(typeof sdk.defineMode).toBe("function")
    expect(Array.isArray(sdk.BUILT_IN_AGENT_MODES)).toBe(true)
    expect(typeof sdk.getAgentMode).toBe("function")
    expect(typeof sdk.getAgentModeByType).toBe("function")
    expect(sdk.getAgentMode("general")?.type).toBe("general")
  })

  it("defineMode is a typesafe identity function", () => {
    const def = sdk.defineMode({
      id: "plugin-review",
      name: "Plugin Review",
      description: "Review plugin code.",
      icon: "SearchCheck",
      outputFormat: "markdown",
    })

    expect(def.id).toBe("plugin-review")
    expect(def.outputFormat).toBe("markdown")
  })

  it("re-exports mode contribution and runtime catalog types", () => {
    const assertTypes = <
      _T extends PluginModeDef | AgentModeConfig | AgentModeType | CustomAgentMode,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
