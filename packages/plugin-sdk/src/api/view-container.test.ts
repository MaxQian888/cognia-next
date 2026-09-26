import * as sdk from "./view-container"
import type {
  PluginViewContainerAPI,
  PluginViewContainerDef,
  ViewContainerEntry,
  ViewContainerOpenErrorCode,
} from "./view-container"
import type { PluginUIAPI } from "../context"

describe("plugin-sdk api/view-container", () => {
  it("exposes the authoring helper and view-container registry functions", () => {
    expect(typeof sdk.defineViewContainer).toBe("function")
    expect(typeof sdk.registerViewContainer).toBe("function")
    expect(typeof sdk.unregisterViewContainersByPlugin).toBe("function")
    expect(typeof sdk.getViewContainer).toBe("function")
    expect(typeof sdk.getViewContainerSnapshot).toBe("function")
    expect(typeof sdk.subscribeViewContainers).toBe("function")
  })

  it("exposes the opener's refusal type and its guard", () => {
    const error = new sdk.ViewContainerOpenError("foreign", "other:view", "refused")
    expect(sdk.isViewContainerOpenError(error, "foreign")).toBe(true)
    expect(sdk.isViewContainerOpenError(new Error("x"))).toBe(false)
  })

  it("does not hand authors the plugin-id-taking host factory", () => {
    expect((sdk as Record<string, unknown>).createViewContainerAPI).toBeUndefined()
    expect((sdk as Record<string, unknown>).showViewContainer).toBeUndefined()
  })

  it("types ctx.ui.openViewContainer as the same promise-returning opener", () => {
    // Compile-time: the author-facing member and the host API agree.
    const opener: PluginUIAPI["openViewContainer"] = async (_id: string) => undefined
    const api: PluginViewContainerAPI = { openViewContainer: opener }
    const code: ViewContainerOpenErrorCode = "not-registered"
    const assertTypes = <_T extends PluginViewContainerDef | ViewContainerEntry>(): void =>
      undefined

    expect(typeof api.openViewContainer).toBe("function")
    expect(code).toBe("not-registered")
    expect(assertTypes).toBeDefined()
  })
})
