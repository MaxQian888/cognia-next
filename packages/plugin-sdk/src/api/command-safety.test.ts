import * as sdk from "./command-safety"
import type {
  CommandClassification,
  CommandVerdict,
  PluginCommandClassification,
  PluginCommandRule,
  Ruleset,
  SegmentClassification,
  ToolRules,
} from "./command-safety"

describe("plugin-sdk api/command-safety", () => {
  it("exposes the plugin command-rule registry and classifier", () => {
    expect(typeof sdk.registerPluginCommandRules).toBe("function")
    expect(typeof sdk.unregisterPluginCommandRules).toBe("function")
    expect(typeof sdk.getPluginCommandRulesets).toBe("function")
    expect(typeof sdk.classifyCommandSafety).toBe("function")
  })

  it("re-exports command safety and plugin terminal rule types", () => {
    const assertTypes = <
      _T extends
        | PluginCommandRule
        | PluginCommandClassification
        | CommandVerdict
        | CommandClassification
        | SegmentClassification
        | ToolRules
        | Ruleset,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
