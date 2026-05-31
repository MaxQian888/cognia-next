/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import {
  DEFAULT_SCHEDULER_DASHBOARD_VIEW,
  isSchedulerDashboardView,
  useSchedulerDashboardView,
} from "./use-scheduler-dashboard-view"
import { useSettingsStore } from "@/stores/settings/settings-store"

const saveMock = jest.fn(async (_patch?: { schedulerDashboardView?: string }) => {})

beforeEach(() => {
  saveMock.mockClear()
  useSettingsStore.setState({
    settings: { schedulerDashboardView: "calendar" } as never,
    save: saveMock as never,
  })
})

const lastSaved = () =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.schedulerDashboardView

describe("isSchedulerDashboardView", () => {
  it("accepts the three valid modes", () => {
    expect(isSchedulerDashboardView("overview")).toBe(true)
    expect(isSchedulerDashboardView("calendar")).toBe(true)
    expect(isSchedulerDashboardView("timeline")).toBe(true)
  })

  it("rejects anything else", () => {
    expect(isSchedulerDashboardView("grid")).toBe(false)
    expect(isSchedulerDashboardView("")).toBe(false)
  })
})

describe("useSchedulerDashboardView", () => {
  it("returns the stored mode", () => {
    const { result } = renderHook(() => useSchedulerDashboardView())
    expect(result.current.view).toBe("calendar")
  })

  it("falls back to the default when unset", () => {
    useSettingsStore.setState({ settings: {} as never })
    const { result } = renderHook(() => useSchedulerDashboardView())
    expect(result.current.view).toBe(DEFAULT_SCHEDULER_DASHBOARD_VIEW)
  })

  it("treats missing settings as default", () => {
    useSettingsStore.setState({ settings: null as never })
    const { result } = renderHook(() => useSchedulerDashboardView())
    expect(result.current.view).toBe("overview")
  })

  it("persists the chosen mode", async () => {
    const { result } = renderHook(() => useSchedulerDashboardView())
    await act(async () => {
      await result.current.setView("timeline")
    })
    expect(lastSaved()).toBe("timeline")
  })
})
