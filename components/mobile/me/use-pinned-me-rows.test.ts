/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { usePinnedMeRows } from "./use-pinned-me-rows"
import { useSettingsStore } from "@/stores/settings/settings-store"

const toastSuccess = jest.fn()
jest.mock("sonner", () => ({ toast: { success: (m: string) => toastSuccess(m) } }))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const saveMock = jest.fn(async () => {})

beforeEach(() => {
  saveMock.mockClear()
  toastSuccess.mockClear()
  useSettingsStore.setState({
    // Minimal slice — the hook only reads `settings.pinnedMeRowIds` + `save`.
    settings: { pinnedMeRowIds: [] } as never,
    save: saveMock as never,
  })
})

describe("usePinnedMeRows", () => {
  it("reports pin state from settings", () => {
    useSettingsStore.setState({ settings: { pinnedMeRowIds: ["sync"] } as never })
    const { result } = renderHook(() => usePinnedMeRows())
    expect(result.current.isPinned("sync")).toBe(true)
    expect(result.current.isPinned("backup")).toBe(false)
  })

  it("defaults to an empty pin set when unset", () => {
    useSettingsStore.setState({ settings: {} as never })
    const { result } = renderHook(() => usePinnedMeRows())
    expect(result.current.pinnedIds).toEqual([])
    expect(result.current.isPinned("sync")).toBe(false)
  })

  it("pins an unpinned row and toasts", async () => {
    const { result } = renderHook(() => usePinnedMeRows())
    await act(async () => {
      await result.current.togglePin("sync")
    })
    expect(saveMock).toHaveBeenCalledWith({ pinnedMeRowIds: ["sync"] })
    expect(toastSuccess).toHaveBeenCalledWith("pinned")
  })

  it("unpins an already-pinned row and toasts", async () => {
    useSettingsStore.setState({ settings: { pinnedMeRowIds: ["sync", "backup"] } as never })
    const { result } = renderHook(() => usePinnedMeRows())
    await act(async () => {
      await result.current.togglePin("sync")
    })
    expect(saveMock).toHaveBeenCalledWith({ pinnedMeRowIds: ["backup"] })
    expect(toastSuccess).toHaveBeenCalledWith("unpinned")
  })
})
