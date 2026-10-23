import * as sdk from "./terminal-completion"
import type {
  PluginTerminalCompletionFactory,
  PluginTerminalCompletionItem,
  PluginTerminalCompletionProvider,
  PluginTerminalCompletionProviderDef,
  TerminalCompletionBridgeOptions,
  TerminalCompletionBridgeResult,
  TerminalCompletionContext,
  TerminalCompletionProvider,
  TerminalCompletionSuggestion,
} from "./terminal-completion"

describe("plugin-sdk api/terminal-completion", () => {
  it("exposes the authoring helper, provider registration, and host registry aliases", () => {
    expect(typeof sdk.defineTerminalCompletionProvider).toBe("function")
    expect(typeof sdk.registerPluginCompletionProvider).toBe("function")
    expect(typeof sdk.registerTerminalCompletionProvider).toBe("function")
    expect(typeof sdk.listTerminalCompletionProviders).toBe("function")
    expect(typeof sdk.getTerminalCompletions).toBe("function")
    expect(typeof sdk.rankTerminalCompletionSuggestions).toBe("function")
  })

  it("keeps host wiring off the author surface (plugins contribute through their manifest)", () => {
    expect(sdk).not.toHaveProperty("adaptPluginCompletionProvider")
    expect(sdk).not.toHaveProperty("registerTerminalCompletionProvidersForPlugin")
    expect(sdk).not.toHaveProperty("unregisterTerminalCompletionProvidersForPlugin")
  })

  it("re-exports terminal completion ranking metadata and contract types", () => {
    expect(sdk.TERMINAL_COMPLETION_SOURCE_PRIORITY.plugin).toBeGreaterThan(
      sdk.TERMINAL_COMPLETION_SOURCE_PRIORITY.history
    )

    const assertTypes = <
      _T extends
        | PluginTerminalCompletionProviderDef
        | PluginTerminalCompletionFactory
        | PluginTerminalCompletionProvider
        | PluginTerminalCompletionItem
        | TerminalCompletionBridgeOptions
        | TerminalCompletionBridgeResult
        | TerminalCompletionContext
        | TerminalCompletionProvider
        | TerminalCompletionSuggestion,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
