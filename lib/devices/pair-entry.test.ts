import { standaloneDevicesRequiresHost } from "@/lib/runtime/surface-contract"

import { DESKTOP_PAIR_HREF, devicePairHref } from "./pair-entry"

let tauri = false
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => tauri,
}))

describe("devicePairHref", () => {
  it("opens the desktop's own pairing QR in Settings", () => {
    tauri = true
    expect(devicePairHref()).toBe(DESKTOP_PAIR_HREF)
  })

  it("is the surface contract's remedy everywhere else", () => {
    tauri = false
    expect(devicePairHref()).toBe(standaloneDevicesRequiresHost.remedy)
  })
})
