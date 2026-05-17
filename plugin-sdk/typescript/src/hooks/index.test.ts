import type {
  PluginHooks,
  PluginHooksAll,
  HookPriority,
  HookRegistrationOptions,
  ProjectHookEvents,
  PreToolUseResult,
} from "./index"

/**
 * Hooks subpath is type-only. We assert assignability against
 * representative shapes so the SDK contract trips when upstream renames a
 * hook event or changes the registration options shape.
 */
describe("plugin-sdk: hooks", () => {
  it("re-exports the manifest-side hooks interfaces", () => {
    const baseHooks: PluginHooks = {}
    const extendedHooks: PluginHooksAll = {}
    expect(baseHooks).toEqual({})
    expect(extendedHooks).toEqual({})
  })

  it("HookPriority is a string-literal union for manifest declarations", () => {
    const priority: HookPriority = "normal"
    const options: HookRegistrationOptions = { priority }
    expect(options.priority).toBe("normal")
  })

  it("re-exports domain-specific hook event shapes", () => {
    const project: ProjectHookEvents = {}
    const toolResult: PreToolUseResult = { action: "allow" }
    expect(project).toEqual({})
    expect(toolResult.action).toBe("allow")
  })
})
