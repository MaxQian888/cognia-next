import * as sdk from "./tray-item"
import type { PluginTrayAPI, PluginTrayItem, PluginTrayItemInput } from "./tray-item"

describe("plugin-sdk api/tray-item", () => {
  it("exposes the authoring helper and the renderer tray registry", () => {
    expect(typeof sdk.defineTrayItem).toBe("function")
    expect(typeof sdk.registerTrayItem).toBe("function")
    expect(typeof sdk.unregisterTrayItem).toBe("function")
    expect(typeof sdk.unregisterTrayItemsByPlugin).toBe("function")
    expect(typeof sdk.listTrayItems).toBe("function")
    expect(typeof sdk.listTrayItemsByPlugin).toBe("function")
    expect(typeof sdk.getTrayItem).toBe("function")
    expect(typeof sdk.subscribeTrayItems).toBe("function")
  })

  it("keeps host wiring off the author surface (plugins reach it through ctx.tray)", () => {
    expect(sdk).not.toHaveProperty("createTrayAPI")
  })

  it("re-exports tray item API and registry types", () => {
    const assertTypes = <_T extends PluginTrayItemInput | PluginTrayAPI | PluginTrayItem>(): void =>
      undefined

    expect(assertTypes).toBeDefined()
  })
})
