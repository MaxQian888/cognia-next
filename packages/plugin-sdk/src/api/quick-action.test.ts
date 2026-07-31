import * as sdk from "./quick-action"
import type { PluginQuickActionDef, PluginQuickActionInput, QuickActionEntry } from "./quick-action"

describe("plugin-sdk api/quick-action", () => {
  it("exposes the authoring helper and quick-action registry functions", () => {
    expect(typeof sdk.defineQuickAction).toBe("function")
    expect(typeof sdk.registerQuickAction).toBe("function")
    expect(typeof sdk.unregisterQuickActionsByPlugin).toBe("function")
    expect(typeof sdk.getQuickAction).toBe("function")
    expect(typeof sdk.listQuickActions).toBe("function")
    expect(typeof sdk.getQuickActionSnapshot).toBe("function")
    expect(typeof sdk.subscribeQuickActions).toBe("function")
    expect(typeof sdk.runQuickAction).toBe("function")
  })

  it("re-exports quick-action contract types", () => {
    const assertTypes = <
      _T extends PluginQuickActionDef | PluginQuickActionInput | QuickActionEntry,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
