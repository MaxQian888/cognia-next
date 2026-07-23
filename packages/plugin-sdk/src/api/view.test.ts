import * as sdk from "./view"
import type {
  PluginTreeNode,
  PluginViewDef,
  PluginViewProps,
  ResolvedPluginView,
  TreeDataProvider,
} from "./view"

describe("plugin-sdk api/view", () => {
  it("exposes the authoring helpers and view registry functions", () => {
    expect(typeof sdk.defineView).toBe("function")
    expect(typeof sdk.defineTreeDataProvider).toBe("function")
    expect(typeof sdk.registerView).toBe("function")
    expect(typeof sdk.unregisterViewsByPlugin).toBe("function")
    expect(typeof sdk.getViewSnapshot).toBe("function")
    expect(typeof sdk.listViewsForContainer).toBe("function")
    expect(typeof sdk.subscribeViews).toBe("function")
  })

  it("re-exports view contract types", () => {
    const assertTypes = <
      _T extends
        PluginViewDef | ResolvedPluginView | TreeDataProvider | PluginTreeNode | PluginViewProps,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
