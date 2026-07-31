import * as sdk from "./modal-mount"
import type {
  DeclaredModalEntry,
  PluginModalAPI,
  PluginModalComponent,
  PluginModalEntry,
  PluginModalHandle,
  PluginModalMountDef,
  PluginModalProps,
  RegisterModalMountsOptions,
} from "./modal-mount"

describe("plugin-sdk api/modal-mount", () => {
  it("exposes the authoring helper, manifest bridge, plugin API, and declared modal registry", () => {
    expect(typeof sdk.defineModalMount).toBe("function")
    expect(typeof sdk.registerModalMountsForPlugin).toBe("function")
    expect(typeof sdk.unregisterModalMountsForPlugin).toBe("function")
    expect(typeof sdk.createModalAPI).toBe("function")
    expect(typeof sdk.clearModalsForPlugin).toBe("function")
    expect(typeof sdk.registerDeclaredModal).toBe("function")
    expect(typeof sdk.unregisterDeclaredModalsForPlugin).toBe("function")
    expect(typeof sdk.getDeclaredModal).toBe("function")
    expect(typeof sdk.listDeclaredModals).toBe("function")
    expect(typeof sdk.subscribeDeclaredModals).toBe("function")
    expect(typeof sdk.openDeclaredModal).toBe("function")
    expect(typeof sdk.selectTopModal).toBe("function")
    expect(typeof sdk.selectAllModals).toBe("function")
  })

  it("re-exports modal mount, modal API, and declared modal types", () => {
    const assertTypes = <
      _T extends
        | PluginModalMountDef
        | PluginModalProps
        | PluginModalComponent
        | PluginModalEntry
        | PluginModalHandle
        | PluginModalAPI
        | DeclaredModalEntry
        | RegisterModalMountsOptions,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
