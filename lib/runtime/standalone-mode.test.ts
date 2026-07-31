import { detectPlatform } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { useSettingsStore } from "@/stores/settings/settings-store"

import { getMobileRuntimeMode, isStandaloneChatMode, setMobileRuntimeMode } from "./standalone-mode"

jest.mock("@/lib/platform/detect", () => ({ detectPlatform: jest.fn() }))
jest.mock("@/lib/platform/web-companion", () => ({ hasWebCompanionTarget: jest.fn() }))
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: jest.fn() },
}))

const mockDetectPlatform = detectPlatform as jest.MockedFunction<typeof detectPlatform>
const mockHasWebCompanionTarget = hasWebCompanionTarget as jest.MockedFunction<
  typeof hasWebCompanionTarget
>
const mockGetState = useSettingsStore.getState as jest.MockedFunction<
  typeof useSettingsStore.getState
>

function withSettings(mobileRuntimeMode: "paired" | "standalone" | undefined, save = jest.fn()) {
  mockGetState.mockReturnValue({ settings: { mobileRuntimeMode }, save } as never)
  return save
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDetectPlatform.mockReturnValue("web")
  mockHasWebCompanionTarget.mockReturnValue(false)
})

describe("getMobileRuntimeMode", () => {
  it("returns the stored mode", () => {
    withSettings("standalone")
    expect(getMobileRuntimeMode()).toBe("standalone")
  })
  it("returns undefined when unset", () => {
    withSettings(undefined)
    expect(getMobileRuntimeMode()).toBeUndefined()
  })
})

describe("setMobileRuntimeMode", () => {
  it("persists via the settings store save()", async () => {
    const save = withSettings(undefined)
    await setMobileRuntimeMode("standalone")
    expect(save).toHaveBeenCalledWith({ mobileRuntimeMode: "standalone" })
  })
})

describe("isStandaloneChatMode", () => {
  it("is true on Capacitor with mode=standalone", () => {
    mockDetectPlatform.mockReturnValue("mobile")
    withSettings("standalone")
    expect(isStandaloneChatMode()).toBe(true)
  })
  it("is false when paired", () => {
    mockDetectPlatform.mockReturnValue("mobile")
    withSettings("paired")
    expect(isStandaloneChatMode()).toBe(false)
  })
  it("is true in an unpaired browser", () => {
    withSettings(undefined)
    expect(isStandaloneChatMode()).toBe(true)
  })
  it("is false in a paired browser", () => {
    mockHasWebCompanionTarget.mockReturnValue(true)
    withSettings(undefined)
    expect(isStandaloneChatMode()).toBe(false)
  })
  it("is false when mode is unset", () => {
    mockDetectPlatform.mockReturnValue("mobile")
    withSettings(undefined)
    expect(isStandaloneChatMode()).toBe(false)
  })
  it("is false on Tauri", () => {
    mockDetectPlatform.mockReturnValue("tauri")
    withSettings("standalone")
    expect(isStandaloneChatMode()).toBe(false)
  })
})
