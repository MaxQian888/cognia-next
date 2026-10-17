/** @jest-environment jsdom */
jest.mock("@tauri-apps/api/window", () => ({
  availableMonitors: jest.fn(),
}))

import { availableMonitors } from "@tauri-apps/api/window"

import { MAX_RENDER_SCALE, resolveLocalRenderScale } from "@/lib/browser/local-render-scale"

function setDevicePixelRatio(value: number) {
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value })
}

describe("resolveLocalRenderScale", () => {
  afterEach(() => setDevicePixelRatio(1))

  it("renders at the densest connected display, not only the current one", async () => {
    setDevicePixelRatio(1)
    await expect(resolveLocalRenderScale(async () => [1, 2])).resolves.toBe(2)
  })

  it("keeps the current density when it is the densest", async () => {
    setDevicePixelRatio(2)
    await expect(resolveLocalRenderScale(async () => [1])).resolves.toBe(2)
  })

  it("falls back to the current density when displays cannot be listed", async () => {
    setDevicePixelRatio(1.5)
    await expect(
      resolveLocalRenderScale(async () => {
        throw new Error("no window api")
      })
    ).resolves.toBe(1.5)
  })

  it("bounds the result to the runtime's 1–4 range and ignores nonsense", async () => {
    setDevicePixelRatio(0.5)
    await expect(resolveLocalRenderScale(async () => [Number.NaN, -2])).resolves.toBe(1)
    await expect(resolveLocalRenderScale(async () => [6])).resolves.toBe(MAX_RENDER_SCALE)
  })

  it("reads the displays from the Tauri window API by default", async () => {
    setDevicePixelRatio(1)
    ;(availableMonitors as jest.Mock).mockResolvedValue([{ scaleFactor: 1 }, { scaleFactor: 3 }])
    await expect(resolveLocalRenderScale()).resolves.toBe(3)
  })
})
