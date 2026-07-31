import * as sdk from "./view-container"
import type { PluginViewContainerDef, ViewContainerEntry } from "./view-container"

describe("plugin-sdk api/view-container", () => {
  it("exposes the authoring helper and view-container registry functions", () => {
    expect(typeof sdk.defineViewContainer).toBe("function")
    expect(typeof sdk.registerViewContainer).toBe("function")
    expect(typeof sdk.unregisterViewContainersByPlugin).toBe("function")
    expect(typeof sdk.getViewContainer).toBe("function")
    expect(typeof sdk.getViewContainerSnapshot).toBe("function")
    expect(typeof sdk.subscribeViewContainers).toBe("function")
  })

  it("re-exports view-container contract types", () => {
    const assertTypes = <_T extends PluginViewContainerDef | ViewContainerEntry>(): void =>
      undefined

    expect(assertTypes).toBeDefined()
  })
})
