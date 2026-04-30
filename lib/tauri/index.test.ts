// Smoke test for the barrel module — every named export from each sub-module
// should be re-exported.

jest.mock("@tauri-apps/plugin-autostart", () => ({
  enable: jest.fn(),
  disable: jest.fn(),
  isEnabled: jest.fn(),
}))
jest.mock("@tauri-apps/plugin-cli", () => ({ getMatches: jest.fn() }))
jest.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readImage: jest.fn(),
  readText: jest.fn(),
  writeImage: jest.fn(),
  writeText: jest.fn(),
  clear: jest.fn(),
}))
jest.mock("@tauri-apps/plugin-deep-link", () => ({
  onOpenUrl: jest.fn(),
  getCurrent: jest.fn(),
}))
jest.mock("@tauri-apps/api/event", () => ({ listen: jest.fn() }))
jest.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: jest.fn(),
  requestPermission: jest.fn(),
  sendNotification: jest.fn(),
}))
jest.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: jest.fn(),
  openPath: jest.fn(),
  revealItemInDir: jest.fn(),
}))
jest.mock("@tauri-apps/plugin-os", () => ({
  arch: jest.fn(),
  family: jest.fn(),
  hostname: jest.fn(),
  locale: jest.fn(),
  platform: jest.fn(),
  type: jest.fn(),
  version: jest.fn(),
}))

import * as Barrel from "./index"

describe("lib/tauri/index barrel", () => {
  it("re-exports autostart helpers", () => {
    expect(typeof Barrel.isAutostartEnabled).toBe("function")
    expect(typeof Barrel.enableAutostart).toBe("function")
    expect(typeof Barrel.disableAutostart).toBe("function")
    expect(typeof Barrel.setAutostart).toBe("function")
  })

  it("re-exports cli helpers", () => {
    expect(typeof Barrel.getLaunchCli).toBe("function")
  })

  it("re-exports clipboard helpers", () => {
    expect(typeof Barrel.readClipboardText).toBe("function")
    expect(typeof Barrel.writeClipboardText).toBe("function")
    expect(typeof Barrel.readClipboardImage).toBe("function")
    expect(typeof Barrel.writeClipboardImage).toBe("function")
    expect(typeof Barrel.clearClipboard).toBe("function")
  })

  it("re-exports deep-link helpers", () => {
    expect(typeof Barrel.onDeepLink).toBe("function")
    expect(typeof Barrel.getLaunchDeepLink).toBe("function")
  })

  it("re-exports events helpers + constants", () => {
    expect(typeof Barrel.onTauriEvent).toBe("function")
    expect(Barrel.TAURI_EVENTS).toBeDefined()
    expect(Barrel.TAURI_EVENTS.trayNewChat).toBe("tray://new-chat")
  })

  it("re-exports notification helpers", () => {
    expect(typeof Barrel.ensureNotificationPermission).toBe("function")
    expect(typeof Barrel.notify).toBe("function")
  })

  it("re-exports opener helpers", () => {
    expect(typeof Barrel.openExternal).toBe("function")
    expect(typeof Barrel.openPath).toBe("function")
    expect(typeof Barrel.revealInExplorer).toBe("function")
  })

  it("re-exports os helpers", () => {
    expect(typeof Barrel.getOsInfo).toBe("function")
    expect(typeof Barrel.isMacPlatform).toBe("function")
  })

  it("re-exports store helpers", () => {
    expect(typeof Barrel.getPref).toBe("function")
    expect(typeof Barrel.setPref).toBe("function")
    expect(typeof Barrel.deletePref).toBe("function")
    expect(typeof Barrel.flushPrefs).toBe("function")
  })
})
