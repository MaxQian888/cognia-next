const platform = { tauri: false, capacitor: false, webCompanion: false }
jest.mock("@/lib/tauri", () => ({ isTauri: () => platform.tauri }))
jest.mock("@/lib/platform/detect", () => ({ isCapacitor: () => platform.capacitor }))
jest.mock("@/lib/platform/web-companion", () => ({
  hasWebCompanionTarget: () => platform.webCompanion,
}))

import { isCompanionShell } from "./shell"

beforeEach(() => {
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
