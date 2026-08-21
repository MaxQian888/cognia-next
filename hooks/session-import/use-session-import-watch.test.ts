/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import type { AppSettings } from "@cognia/agent-config-types"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useSessionImportWatch } from "./use-session-import-watch"

jest.mock("@/lib/db/settings", () => ({
  saveSettings: jest.fn(async () => ({}) as AppSettings),
}))

const originalStoreSave = useSettingsStore.getState().save

function seed(enabled: boolean | undefined) {
  useSettingsStore.setState({
    settings:
      enabled === undefined
        ? ({ id: "singleton" } as never)
        : ({ id: "singleton", sessionImportWatch: { enabled } } as never),
  })
}

afterEach(() => {
  useSettingsStore.setState({ settings: null, save: originalStoreSave })
})

describe("useSessionImportWatch", () => {
  it("reads the persisted preference, defaulting to off", () => {
    seed(undefined)
    const { result } = renderHook(() => useSessionImportWatch())
    expect(result.current.enabled).toBe(false)
  })

  it("reflects a persisted enabled preference — the switch survives a remount", () => {
    seed(true)
    const { result, unmount } = renderHook(() => useSessionImportWatch())
    expect(result.current.enabled).toBe(true)
    unmount()
    // Reopening the dialog must not re-read as "off" while the watch is on.
    const again = renderHook(() => useSessionImportWatch())
    expect(again.result.current.enabled).toBe(true)
  })

  it("persists the toggle rather than owning the watcher", async () => {
    seed(false)
    const saveSettings = jest.fn(async () => ({}) as AppSettings)
    const { result } = renderHook(() => useSessionImportWatch({ deps: { saveSettings } }))

    await act(async () => {
      await result.current.toggle(true)
    })
    expect(saveSettings).toHaveBeenCalledWith({ sessionImportWatch: { enabled: true } })

    await act(async () => {
      await result.current.toggle(false)
    })
    expect(saveSettings).toHaveBeenCalledWith({ sessionImportWatch: { enabled: false } })
  })

  it("updates the shared settings store so the app-level watcher reacts immediately", async () => {
    seed(false)
    const save = jest.fn(async (patch: Partial<AppSettings>) => {
      useSettingsStore.setState((state) => ({
        settings: { ...state.settings!, ...patch },
      }))
    })
    useSettingsStore.setState({ save: save as never })
    const { result } = renderHook(() => useSessionImportWatch())

    await act(async () => {
      await result.current.toggle(true)
    })

    expect(save).toHaveBeenCalledWith({ sessionImportWatch: { enabled: true } })
    expect(result.current.enabled).toBe(true)
  })
})
