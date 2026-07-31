/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

import { useSettingsPatch } from "./use-settings-patch"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import { useSettingsStore } from "@/stores/settings"

jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: jest.fn(async () => undefined),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn(),
}))

const saveMock = jest.fn(async () => undefined)
const enqueueMock = enqueue as jest.MockedFunction<typeof enqueue>
const useSettingsStoreMock = useSettingsStore as unknown as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  // The hook reads `useSettingsStore((s) => s.save)` — honor the selector.
  useSettingsStoreMock.mockImplementation((selector: (s: { save: unknown }) => unknown) =>
    selector({ save: saveMock })
  )
})

describe("useSettingsPatch", () => {
  it("persists the patch through the settings store", async () => {
    const { result } = renderHook(() => useSettingsPatch())
    await result.current({ permissionMode: "plan" })

    expect(saveMock).toHaveBeenCalledWith({ permissionMode: "plan" })
  })

  it("does not enqueue — the persistence funnel owns host mirroring now", async () => {
    // This hook used to save and then enqueue `app_settings_update` itself.
    // That only covered pages which called it, so mobile routes embedding a
    // desktop settings section (`/me/appearance`) never mirrored anything. The
    // enqueue moved into `lib/db/settings.ts` → `lib/settings/mirror-to-host.ts`
    // so every surface is covered; repeating it here would queue each edit
    // twice, which is what this assertion guards.
    const { result } = renderHook(() => useSettingsPatch())
    await result.current({ bareMode: true })

    expect(saveMock).toHaveBeenCalledWith({ bareMode: true })
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it("propagates a persistence failure instead of swallowing it", async () => {
    saveMock.mockRejectedValueOnce(new Error("dexie closed"))
    const { result } = renderHook(() => useSettingsPatch())

    await expect(result.current({ bareMode: true })).rejects.toThrow("dexie closed")
  })
})
