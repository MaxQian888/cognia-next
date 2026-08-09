/** @jest-environment jsdom */

import { buildOcrDeps, createOcrRuntimeStatusResolver, detectOcrOsTag } from "./deps"
import { DEFAULT_OCR_SETTINGS, type UserOcrSettings } from "@/types/ocr"
import type { OcrProvider } from "@/types/ocr"
import { transport } from "@/lib/tauri"

jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

const fakeRegistry = { list: () => [], has: () => false } as unknown as ReturnType<
  typeof import("./registry").getSharedOcrRegistry
>
jest.mock("./registry", () => ({
  getSharedOcrRegistry: () => fakeRegistry,
  shellAllows: () => true,
}))

let mockPlatform: "tauri" | "mobile" | "web" | "headless" = "web"
jest.mock("@/lib/platform/detect", () => ({
  detectPlatform: () => mockPlatform,
  isHeadlessHost: () => mockPlatform === "headless",
}))

const sentinelResolver = jest.fn()
jest.mock("./credentials", () => ({
  createOcrCredentialsResolver: () => sentinelResolver,
}))

function setUserAgent(ua: string) {
  Object.defineProperty(globalThis.navigator, "userAgent", { value: ua, configurable: true })
}

beforeEach(() => {
  mockPlatform = "web"
  ;(transport.call as jest.Mock).mockReset()
})

describe("detectOcrOsTag", () => {
  it("maps the browser shell to 'browser' regardless of OS", () => {
    setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
    expect(detectOcrOsTag("web")).toBe("browser")
  })

  it("detects iOS vs Android on the mobile shell", () => {
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")
    expect(detectOcrOsTag("mobile")).toBe("ios")
    setUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel)")
    expect(detectOcrOsTag("mobile")).toBe("android")
  })

  it("reads the host OS off the UA on the Tauri shell", () => {
    setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
    expect(detectOcrOsTag("tauri")).toBe("windows")
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")
    expect(detectOcrOsTag("tauri")).toBe("macos")
    setUserAgent("Mozilla/5.0 (X11; Linux x86_64)")
    expect(detectOcrOsTag("tauri")).toBe("linux")
  })

  it("uses the Node process OS instead of a synthetic browser UA in headless mode", () => {
    const expected =
      process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux"
    expect(detectOcrOsTag("headless")).toBe(expected)
  })
})

describe("buildOcrDeps", () => {
  it("fills defaults: shared registry, default settings, detected platform/osTag, real resolver", () => {
    mockPlatform = "web"
    setUserAgent("Mozilla/5.0 (X11; Linux x86_64)")
    const deps = buildOcrDeps()
    expect(deps.registry).toBe(fakeRegistry)
    expect(deps.settings).toBe(DEFAULT_OCR_SETTINGS)
    expect(deps.platform).toBe("web")
    expect(deps.osTag).toBe("browser")
    expect(deps.credentialsResolver).toBe(sentinelResolver)
    expect(deps.attachmentResolver).toBeUndefined()
  })

  it("honours every override", () => {
    const settings: UserOcrSettings = { ...DEFAULT_OCR_SETTINGS, defaultProviderId: "mistral-ocr" }
    const credentialsResolver = jest.fn()
    const attachmentResolver = jest.fn()
    const onResult = jest.fn()
    const runtimeStatus = jest.fn()
    const deps = buildOcrDeps({
      settings,
      platform: "tauri",
      osTag: "windows",
      credentialsResolver,
      attachmentResolver,
      onResult,
      runtimeStatus,
    })
    expect(deps.settings).toBe(settings)
    expect(deps.platform).toBe("tauri")
    expect(deps.osTag).toBe("windows")
    expect(deps.credentialsResolver).toBe(credentialsResolver)
    expect(deps.attachmentResolver).toBe(attachmentResolver)
    expect(deps.onResult).toBe(onResult)
    expect(deps.runtimeStatus).toBe(runtimeStatus)
  })
})

describe("headless native OCR status", () => {
  it("probes the server registry through the process transport", async () => {
    mockPlatform = "headless"
    ;(transport.call as jest.Mock).mockResolvedValue(["tesseract-native"])
    const provider = {
      id: "tesseract-native",
      category: "local",
      shells: { browser: false, tauri: true, capacitor: false },
      credentialKeys: [],
    } as unknown as OcrProvider
    const resolve = createOcrRuntimeStatusResolver(DEFAULT_OCR_SETTINGS, jest.fn())

    await expect(resolve(provider, "headless")).resolves.toMatchObject({
      providerId: "tesseract-native",
      backendBound: true,
      ready: true,
    })
    expect(transport.call).toHaveBeenCalledWith("ocr_list_available_backends", undefined)
  })
})
/** @jest-environment jsdom */
