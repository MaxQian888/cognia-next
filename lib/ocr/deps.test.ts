import { buildOcrDeps, detectOcrOsTag } from "./deps"
import { DEFAULT_OCR_SETTINGS, type UserOcrSettings } from "@/types/ocr"

const fakeRegistry = { list: () => [], has: () => false } as unknown as ReturnType<
  typeof import("./registry").getSharedOcrRegistry
>
jest.mock("./registry", () => ({
  getSharedOcrRegistry: () => fakeRegistry,
}))

let mockPlatform: "tauri" | "mobile" | "web" = "web"
jest.mock("@/lib/platform/detect", () => ({
  detectPlatform: () => mockPlatform,
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
    const deps = buildOcrDeps({
      settings,
      platform: "tauri",
      osTag: "windows",
      credentialsResolver,
      attachmentResolver,
      onResult,
    })
    expect(deps.settings).toBe(settings)
    expect(deps.platform).toBe("tauri")
    expect(deps.osTag).toBe("windows")
    expect(deps.credentialsResolver).toBe(credentialsResolver)
    expect(deps.attachmentResolver).toBe(attachmentResolver)
    expect(deps.onResult).toBe(onResult)
  })
})
