import { isCapacitor } from "@/lib/platform/detect"
import { useSettingsStore } from "@/stores/settings/settings-store"

import { getMobileRuntimeMode, isStandaloneChatMode, setMobileRuntimeMode } from "./standalone-mode"

jest.mock("@/lib/platform/detect", () => ({ isCapacitor: jest.fn() }))
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: { getState: jest.fn() },
}))

const mockIsCapacitor = isCapacitor as jest.MockedFunction<typeof isCapacitor>
const mockGetState = useSettingsStore.getState as jest.MockedFunction<
  typeof useSettingsStore.getState
>

function withSettings(mobileRuntimeMode: "paired" | "standalone" | undefined, save = jest.fn()) {
  mockGetState.mockReturnValue({ settings: { mobileRuntimeMode }, save } as never)
  return save
}

beforeEach(() => jest.clearAllMocks())

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
  it("is true only on Capacitor with mode=standalone", () => {
    mockIsCapacitor.mockReturnValue(true)
    withSettings("standalone")
    expect(isStandaloneChatMode()).toBe(true)
  })
  it("is false when paired", () => {
    mockIsCapacitor.mockReturnValue(true)
    withSettings("paired")
    expect(isStandaloneChatMode()).toBe(false)
  })
  it("is false off Capacitor even when mode=standalone", () => {
    mockIsCapacitor.mockReturnValue(false)
    withSettings("standalone")
    expect(isStandaloneChatMode()).toBe(false)
  })
  it("is false when mode is unset", () => {
    mockIsCapacitor.mockReturnValue(true)
    withSettings(undefined)
    expect(isStandaloneChatMode()).toBe(false)
  })
})
