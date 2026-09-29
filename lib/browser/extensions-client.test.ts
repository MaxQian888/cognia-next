jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

import { transport } from "@/lib/tauri"
import {
  browserExtensionErrorCode,
  cancelExtensionInstall,
  checkExtensionUpdates,
  confirmExtensionInstall,
  listExtensions,
  pickCrxExtension,
  pickUnpackedExtension,
  prepareWebStoreExtension,
  removeExtension,
  setExtensionEnabled,
  updateExtension,
} from "./extensions-client"

const call = transport.call as jest.Mock

beforeEach(() => {
  call.mockReset()
  call.mockResolvedValue(undefined)
})

it("maps every wrapper onto its Tauri command with camelCase args", async () => {
  await listExtensions()
  await prepareWebStoreExtension("https://chromewebstore.google.com/detail/x/abc")
  await pickCrxExtension()
  await pickUnpackedExtension()
  await confirmExtensionInstall("p1")
  await cancelExtensionInstall("p2")
  await setExtensionEnabled("abc", false)
  await removeExtension("abc")
  await checkExtensionUpdates()
  await updateExtension("abc")
  expect(call.mock.calls).toEqual([
    ["browser_extensions_list"],
    [
      "browser_extension_install_webstore",
      { idOrUrl: "https://chromewebstore.google.com/detail/x/abc" },
    ],
    // Rust shows the pickers: no path ever crosses from the renderer.
    ["browser_extension_install_crx"],
    ["browser_extension_install_unpacked"],
    ["browser_extension_install_confirm", { pendingId: "p1" }],
    ["browser_extension_install_cancel", { pendingId: "p2" }],
    ["browser_extension_set_enabled", { id: "abc", enabled: false }],
    ["browser_extension_remove", { id: "abc" }],
    ["browser_extensions_check_updates"],
    ["browser_extension_update", { id: "abc" }],
  ])
})

it("returns what Rust returns", async () => {
  call.mockResolvedValueOnce([{ id: "abc", currentVersion: "1", availableVersion: "2" }])
  await expect(checkExtensionUpdates()).resolves.toEqual([
    { id: "abc", currentVersion: "1", availableVersion: "2" },
  ])
})

it("extracts typed error codes from rejections", () => {
  expect(browserExtensionErrorCode("crx_id_mismatch: declared id differs")).toBe("crx_id_mismatch")
  expect(browserExtensionErrorCode(new Error("zip_path_traversal"))).toBe("zip_path_traversal")
  expect(browserExtensionErrorCode({ message: "extension_not_found" })).toBe("extension_not_found")
  expect(browserExtensionErrorCode("extension_install_expired: start again")).toBe(
    "extension_install_expired"
  )
  expect(browserExtensionErrorCode("something else")).toBeNull()
  expect(browserExtensionErrorCode(42)).toBeNull()
})
