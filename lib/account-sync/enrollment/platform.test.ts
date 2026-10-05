jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => false),
  isCapacitor: jest.fn(() => false),
}))

import { isCapacitor, isTauri } from "@/lib/tauri"

import { currentDevicePlatform } from "./platform"

describe("currentDevicePlatform", () => {
  it("names the shell", () => {
    expect(currentDevicePlatform()).toBe("web")
    jest.mocked(isCapacitor).mockReturnValue(true)
    expect(currentDevicePlatform()).toBe("mobile")
    jest.mocked(isTauri).mockReturnValue(true)
    expect(currentDevicePlatform()).toBe("desktop")
  })
})
