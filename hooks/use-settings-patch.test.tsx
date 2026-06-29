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
  it("persists the patch then enqueues an app_settings_update with the same patch", async () => {
    const { result } = renderHook(() => useSettingsPatch())
    await result.current({ permissionMode: "plan" })

    expect(saveMock).toHaveBeenCalledWith({ permissionMode: "plan" })
    expect(enqueueMock).toHaveBeenCalledTimes(1)
    const arg = enqueueMock.mock.calls[0][0]
    expect(arg.command).toBe("app_settings_update")
    expect(arg.payload).toEqual({ patch: { permissionMode: "plan" } })
    expect(typeof arg.label).toBe("string")
  })

  it("saves before it enqueues (local write wins the race)", async () => {
    const order: string[] = []
    saveMock.mockImplementationOnce(async () => {
      order.push("save")
    })
    enqueueMock.mockImplementationOnce(async () => {
      order.push("enqueue")
      return undefined as never
    })
    const { result } = renderHook(() => useSettingsPatch())
    await result.current({ bareMode: true })
    expect(order).toEqual(["save", "enqueue"])
  })
})
