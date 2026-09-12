jest.mock("@/lib/tauri/transport-routing", () => ({
  isRemoteHostActive: () => platform.remoteHost,
}))
const platform = { tauri: false, capacitor: false, webCompanion: false, remoteHost: false }
jest.mock("@/lib/tauri", () => ({ isTauri: () => platform.tauri }))
jest.mock("@/lib/platform/detect", () => ({ isCapacitor: () => platform.capacitor }))
jest.mock("@/lib/platform/web-companion", () => ({
  hasWebCompanionTarget: () => platform.webCompanion,
}))

import { isCompanionShell } from "./shell"

beforeEach(() => {
  platform.remoteHost = false
  platform.tauri = false
  platform.capacitor = false
  platform.webCompanion = false
})

it("is a companion on Capacitor or a paired web build, and never on Tauri", () => {
  expect(isCompanionShell()).toBe(false)
  platform.capacitor = true
  expect(isCompanionShell()).toBe(true)
  platform.capacitor = false
  platform.webCompanion = true
  expect(isCompanionShell()).toBe(true)
  platform.tauri = true
  expect(isCompanionShell()).toBe(false)
})

it("uses the Host runner when a desktop drives a remote target", () => {
  platform.tauri = true
  platform.remoteHost = true
  expect(isCompanionShell()).toBe(true)
})
