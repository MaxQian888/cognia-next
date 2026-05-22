import {
  getPluginEventHooks,
  getPluginLifecycleHooks,
  validatePluginManifest,
  createExtensionAPI,
  getExtensionsForPoint,
  setToastDispatcher,
  createPermissionAPI,
  createStorageAPI,
} from "./index"
import * as core from "./core/validation"
import * as hooksSystem from "./messaging/hooks-system"
import * as extensionApi from "./api/extension-api"
import * as notificationApi from "./api/notification-api"
import * as permissionApi from "./api/permission-api"
import * as storageApi from "./api/storage-api"

describe("lib/plugin barrel re-exports", () => {
  it("validatePluginManifest is the canonical core validator", () => {
    expect(validatePluginManifest).toBe(core.validatePluginManifest)
  })

  it("getPluginEventHooks / getPluginLifecycleHooks are the canonical hook factories", () => {
    expect(getPluginEventHooks).toBe(hooksSystem.getPluginEventHooks)
    expect(getPluginLifecycleHooks).toBe(hooksSystem.getPluginLifecycleHooks)
  })

  it("getPluginEventHooks() returns the real PluginEventHooks instance", () => {
    expect(getPluginEventHooks()).toBeInstanceOf(hooksSystem.PluginEventHooks)
  })

  it("getPluginLifecycleHooks() returns the real PluginLifecycleHooks instance", () => {
    expect(getPluginLifecycleHooks()).toBeInstanceOf(hooksSystem.PluginLifecycleHooks)
  })

  it("validatePluginManifest accepts governance options", () => {
    const result = validatePluginManifest(
      { id: "test.plugin", name: "Test", version: "1.0.0", type: "frontend" },
      { governanceMode: "warn" }
    )
    expect(result).toEqual(expect.objectContaining({ valid: expect.any(Boolean) }))
  })

  describe("plugin api re-exports (via ./api barrel)", () => {
    it("re-exports extension API surfaces (createExtensionAPI, getExtensionsForPoint)", () => {
      expect(createExtensionAPI).toBe(extensionApi.createExtensionAPI)
      expect(getExtensionsForPoint).toBe(extensionApi.getExtensionsForPoint)
    })

    it("re-exports notification API surfaces (setToastDispatcher)", () => {
      expect(setToastDispatcher).toBe(notificationApi.setToastDispatcher)
    })

    it("re-exports permission API surfaces (createPermissionAPI)", () => {
      expect(createPermissionAPI).toBe(permissionApi.createPermissionAPI)
    })

    it("re-exports storage API surfaces (createStorageAPI)", () => {
      expect(createStorageAPI).toBe(storageApi.createStorageAPI)
    })
  })
})
