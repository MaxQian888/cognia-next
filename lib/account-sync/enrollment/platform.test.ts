jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => false),
  isCapacitor: jest.fn(() => false),
}))

import { isCapacitor, isTauri } from "@/lib/tauri"

import { currentDevicePlatform, suggestDeviceName } from "./platform"

describe("currentDevicePlatform", () => {
  it("names the shell", () => {
    expect(currentDevicePlatform()).toBe("web")
    jest.mocked(isCapacitor).mockReturnValue(true)
    expect(currentDevicePlatform()).toBe("mobile")
    jest.mocked(isTauri).mockReturnValue(true)
    expect(currentDevicePlatform()).toBe("desktop")
  })
})

describe("suggestDeviceName", () => {
  it("names the operating system", () => {
    expect(suggestDeviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe(
      "iPhone"
    )
    expect(suggestDeviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)")).toBe("Mac")
    expect(suggestDeviceName("Mozilla/5.0 (Linux; Android 15; Pixel 9)")).toBe("Android")
    expect(suggestDeviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows")
    expect(suggestDeviceName("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Linux")
    expect(suggestDeviceName("curl/8")).toBe("")
  })
})
