/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { useExecutionMonitorPrefs } from "./use-execution-monitor-prefs"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  DEFAULT_EXECUTION_MONITOR_PREFS,
  type StoredExecutionMonitorPrefs,
} from "@/lib/execution/monitor-prefs"

const saveMock = jest.fn(
  async (_patch?: { executionMonitorPrefs?: StoredExecutionMonitorPrefs }) => {}
)

const setStored = (executionMonitorPrefs?: StoredExecutionMonitorPrefs) =>
  useSettingsStore.setState({
    settings: { executionMonitorPrefs } as never,
    save: saveMock as never,
  })

const lastSaved = () =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.executionMonitorPrefs

beforeEach(() => {
  saveMock.mockClear()
  setStored(undefined)
})

describe("useExecutionMonitorPrefs", () => {
  it("resolves the defaults when nothing is stored", () => {
    const { result } = renderHook(() => useExecutionMonitorPrefs())
    expect(result.current.prefs).toEqual(DEFAULT_EXECUTION_MONITOR_PREFS)
    expect(result.current.isDefault).toBe(true)
  })

  it("reflects persisted prefs and reports non-default", () => {
    setStored({ hiddenKinds: ["chat"], sort: "kind", groupByKind: true, showElapsed: false })
    const { result } = renderHook(() => useExecutionMonitorPrefs())
    expect(result.current.prefs.hiddenKinds).toEqual(["chat"])
    expect(result.current.prefs.sort).toBe("kind")
    expect(result.current.isDefault).toBe(false)
  })

  it("hides a kind by adding it to the deny list", async () => {
    const { result } = renderHook(() => useExecutionMonitorPrefs())
    await act(async () => {
      await result.current.toggleKind("team", false)
    })
    expect(lastSaved()?.hiddenKinds).toEqual(["team"])
  })

  it("shows a kind by removing it from the deny list", async () => {
    setStored({ hiddenKinds: ["team", "chat"] })
    const { result } = renderHook(() => useExecutionMonitorPrefs())
    await act(async () => {
      await result.current.toggleKind("team", true)
    })
    expect(lastSaved()?.hiddenKinds).toEqual(["chat"])
  })

  it("does not double-add an already-hidden kind", async () => {
    setStored({ hiddenKinds: ["team"] })
    const { result } = renderHook(() => useExecutionMonitorPrefs())
    await act(async () => {
      await result.current.toggleKind("team", false)
    })
    expect(lastSaved()?.hiddenKinds).toEqual(["team"])
  })

  it("persists sort / groupByKind / showElapsed without clobbering other knobs", async () => {
    setStored({ hiddenKinds: ["chat"] })
    const { result } = renderHook(() => useExecutionMonitorPrefs())
    await act(async () => {
      await result.current.setSort("status")
    })
    expect(lastSaved()).toMatchObject({ hiddenKinds: ["chat"], sort: "status" })
    await act(async () => {
      await result.current.setGroupByKind(true)
    })
    expect(lastSaved()).toMatchObject({ hiddenKinds: ["chat"], groupByKind: true })
    await act(async () => {
      await result.current.setShowElapsed(false)
    })
    expect(lastSaved()).toMatchObject({ hiddenKinds: ["chat"], showElapsed: false })
  })

  it("reset writes the factory defaults", async () => {
    setStored({ hiddenKinds: ["chat"], sort: "kind" })
    const { result } = renderHook(() => useExecutionMonitorPrefs())
    await act(async () => {
      await result.current.reset()
    })
    expect(lastSaved()).toEqual(DEFAULT_EXECUTION_MONITOR_PREFS)
  })
})
